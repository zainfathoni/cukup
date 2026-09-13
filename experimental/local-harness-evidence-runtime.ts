import { Database } from 'bun:sqlite'
import { randomBytes, randomUUID } from 'node:crypto'
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
	LocalHarnessEvidenceClient,
	parseLocalHarnessEvidenceClientOrigin,
	type LocalHarnessEvidenceClientOptions,
} from './local-harness-evidence-client.ts'
import {
	isLocalHarnessEvidenceReceiverToken,
	LOCAL_HARNESS_EVIDENCE_READINESS_PATH,
	startLocalHarnessEvidenceHttpServer,
	type LocalHarnessEvidenceHttpServer,
} from './local-harness-evidence-http-server.ts'
import {
	LocalHarnessEvidenceReceiver,
	prepareLocalHarnessEvidenceDatabaseFile,
} from './local-harness-evidence-receiver.ts'
import { LOCAL_PROTOCOL, LOCAL_PROTOCOL_VERSION, isUuidV4 } from './local-harness-evidence.ts'

const DATABASE_FILE = 'receiver.sqlite'
const IDENTITY_FILE = 'execution-site-id'
const TOKEN_FILE = 'receiver-token'
const ENDPOINT_FILE = 'endpoint.json'
const OWNERSHIP_FILE = 'runtime-ownership.sqlite'
const ENDPOINT_MAX_BYTES = 512
const READINESS_MAX_BYTES = 512
const READINESS_RESPONSE = `{"protocol":"${LOCAL_PROTOCOL}","protocol_version":${LOCAL_PROTOCOL_VERSION},"ready":true}`
const RUNTIME_ERROR = 'Local Harness evidence runtime is unavailable'
const DISCOVERY_ERROR = 'Local Harness evidence endpoint is unavailable'

export type LocalHarnessEvidenceEndpoint = Readonly<{
	protocol: typeof LOCAL_PROTOCOL
	protocol_version: typeof LOCAL_PROTOCOL_VERSION
	origin: string
}>

export type LocalHarnessEvidenceRuntime = Readonly<{
	endpoint: LocalHarnessEvidenceEndpoint
	stop: () => Promise<void>
}>

export type LocalHarnessEvidenceRuntimeOptions = Readonly<{
	stateDirectory: string
	port?: number
}>

export type DiscoveredLocalHarnessEvidenceClientOptions = Omit<
	LocalHarnessEvidenceClientOptions,
	'origin' | 'tokenProvider'
> &
	Readonly<{ stateDirectory: string }>

/**
 * Owns one exact durable state directory and one explicitly caller-managed receiver lifecycle.
 * Credential rotation is deliberately not exposed until overlap and stale-client semantics are decided.
 */
export function startLocalHarnessEvidenceRuntime(
	options: LocalHarnessEvidenceRuntimeOptions,
): LocalHarnessEvidenceRuntime {
	let ownership: Database | undefined
	let receiver: LocalHarnessEvidenceReceiver | undefined
	let server: LocalHarnessEvidenceHttpServer | undefined
	let endpointPath: string | undefined
	try {
		const paths = prepareStateDirectory(options.stateDirectory)
		validateExistingOwnerFile(paths.database)
		validateExistingOwnerFile(paths.ownership)
		ownership = acquireOwnership(paths.ownership)
		endpointPath = paths.endpoint
		rmSync(paths.endpoint, { force: true })

		const executionSiteId = provisionValue(paths.identity, () => randomUUID(), isUuidV4)
		const token = provisionValue(
			paths.token,
			() => randomBytes(32).toString('base64url'),
			isLocalHarnessEvidenceReceiverToken,
		)
		receiver = new LocalHarnessEvidenceReceiver(paths.database, executionSiteId)
		server = startLocalHarnessEvidenceHttpServer({ receiver, token, port: options.port })
		const endpoint = Object.freeze({
			protocol: LOCAL_PROTOCOL,
			protocol_version: LOCAL_PROTOCOL_VERSION,
			origin: `http://${server.hostname}:${server.port}`,
		})
		atomicWrite(paths.endpoint, JSON.stringify(endpoint))

		let stopped = false
		return Object.freeze({
			endpoint,
			stop: async () => {
				if (stopped) return
				stopped = true
				let failed = false
				try {
					rmSync(paths.endpoint, { force: true })
				} catch {
					failed = true
				}
				try {
					await server!.stop()
				} catch {
					failed = true
				}
				try {
					receiver!.close()
				} catch {
					failed = true
				}
				try {
					ownership!.exec('ROLLBACK')
					ownership!.close()
				} catch {
					failed = true
				}
				if (failed) throw new Error(RUNTIME_ERROR)
			},
		})
	} catch {
		if (endpointPath !== undefined) {
			try {
				rmSync(endpointPath, { force: true })
			} catch {}
		}
		if (server !== undefined) {
			try {
				void server.stop()
			} catch {}
		}
		if (receiver !== undefined) {
			try {
				receiver.close()
			} catch {}
		}
		if (ownership !== undefined) {
			try {
				ownership.exec('ROLLBACK')
			} catch {}
			try {
				ownership.close()
			} catch {}
		}
		throw new Error(RUNTIME_ERROR)
	}
}

/** Discovers only a currently reachable runtime; stale descriptors never produce a client origin. */
export async function discoverLocalHarnessEvidenceEndpoint(
	stateDirectory: string,
): Promise<LocalHarnessEvidenceEndpoint> {
	try {
		const paths = inspectStateDirectory(stateDirectory)
		const endpoint = parseEndpoint(readOwnerFile(paths.endpoint, ENDPOINT_MAX_BYTES))
		const token = readOwnerFile(paths.token, 43)
		if (!isLocalHarnessEvidenceReceiverToken(token)) throw new Error()
		const response = await fetch(`${endpoint.origin}${LOCAL_HARNESS_EVIDENCE_READINESS_PATH}`, {
			method: 'GET',
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(1_000),
		})
		if (
			response.status !== 200 ||
			response.headers.get('content-type') !== 'application/json; charset=utf-8' ||
			(await readBoundedResponse(response, READINESS_MAX_BYTES)) !== READINESS_RESPONSE
		) {
			throw new Error()
		}
		return endpoint
	} catch {
		throw new Error(DISCOVERY_ERROR)
	}
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
	const declaredLength = response.headers.get('content-length')
	if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
		throw new Error()
	}
	if (response.body === null) throw new Error()
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let length = 0
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		length += value.byteLength
		if (length > maximumBytes) {
			void reader.cancel().catch(() => undefined)
			throw new Error()
		}
		chunks.push(value)
	}
	const bytes = new Uint8Array(length)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** Constructs the existing bounded client after safe endpoint discovery. */
export async function createDiscoveredLocalHarnessEvidenceClient(
	options: DiscoveredLocalHarnessEvidenceClientOptions,
): Promise<LocalHarnessEvidenceClient> {
	const { stateDirectory, ...clientOptions } = options
	const endpoint = await discoverLocalHarnessEvidenceEndpoint(stateDirectory)
	let paths: ReturnType<typeof statePaths>
	try {
		paths = inspectStateDirectory(stateDirectory)
	} catch {
		throw new Error(DISCOVERY_ERROR)
	}
	return new LocalHarnessEvidenceClient({
		...clientOptions,
		origin: endpoint.origin,
		tokenProvider: () => {
			try {
				const token = readOwnerFile(paths.token, 43)
				if (!isLocalHarnessEvidenceReceiverToken(token)) throw new Error()
				return token
			} catch {
				throw new Error(DISCOVERY_ERROR)
			}
		},
	})
}

function statePaths(stateDirectory: string) {
	return {
		database: join(stateDirectory, DATABASE_FILE),
		identity: join(stateDirectory, IDENTITY_FILE),
		token: join(stateDirectory, TOKEN_FILE),
		endpoint: join(stateDirectory, ENDPOINT_FILE),
		ownership: join(stateDirectory, OWNERSHIP_FILE),
	}
}

function validateExactStatePath(path: string): void {
	if (!isAbsolute(path) || path.length === 0 || path !== path.trim() || resolve(path) !== path || path === '/') {
		throw new Error()
	}
}

function prepareStateDirectory(path: string) {
	validateExactStatePath(path)
	const parent = dirname(path)
	if (realpathSync(parent) !== parent) throw new Error()
	try {
		mkdirSync(path, { mode: 0o700 })
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
	}
	return inspectStateDirectory(path)
}

function inspectStateDirectory(path: string) {
	validateExactStatePath(path)
	const stat = lstatSync(path)
	const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		realpathSync(path) !== path ||
		(uid !== undefined && stat.uid !== uid)
	) {
		throw new Error()
	}
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
	try {
		fchmodSync(descriptor, 0o700)
	} finally {
		closeSync(descriptor)
	}
	return statePaths(path)
}

function acquireOwnership(path: string): Database {
	prepareLocalHarnessEvidenceDatabaseFile(path)
	const database = new Database(path, { create: true, strict: true })
	try {
		database.exec('PRAGMA busy_timeout = 0')
		database.exec('PRAGMA journal_mode = DELETE')
		database.exec('BEGIN EXCLUSIVE')
		return database
	} catch (error) {
		database.close()
		throw error
	}
}

function validateExistingOwnerFile(path: string): void {
	try {
		const stat = lstatSync(path)
		const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			(stat.mode & 0o777) !== 0o600 ||
			(uid !== undefined && stat.uid !== uid)
		) {
			throw new Error()
		}
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
	}
}

function provisionValue(path: string, create: () => string, valid: (value: string) => boolean): string {
	try {
		const existing = readOwnerFile(path, 64)
		if (!valid(existing)) throw new Error()
		return existing
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
	}
	const value = create()
	if (!valid(value)) throw new Error()
	atomicWrite(path, value)
	return value
}

function atomicWrite(path: string, value: string): void {
	const temporary = `${path}.tmp-${randomUUID()}`
	let descriptor: number | undefined
	try {
		descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
		writeFileSync(descriptor, value, 'utf8')
		fsyncSync(descriptor)
		closeSync(descriptor)
		descriptor = undefined
		renameSync(temporary, path)
		const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
		try {
			fsyncSync(directory)
		} finally {
			closeSync(directory)
		}
	} finally {
		if (descriptor !== undefined) closeSync(descriptor)
		rmSync(temporary, { force: true })
	}
}

function readOwnerFile(path: string, maximumBytes: number): string {
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
	try {
		const stat = fstatSync(descriptor)
		const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
		if (
			!stat.isFile() ||
			(stat.mode & 0o777) !== 0o600 ||
			(uid !== undefined && stat.uid !== uid) ||
			stat.size > maximumBytes
		) {
			throw new Error()
		}
		return readFileSync(descriptor, 'utf8')
	} finally {
		closeSync(descriptor)
	}
}

function parseEndpoint(content: string): LocalHarnessEvidenceEndpoint {
	const value: unknown = JSON.parse(content)
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
	const record = value as Record<string, unknown>
	if (
		Object.keys(record).sort().join(',') !== 'origin,protocol,protocol_version' ||
		record.protocol !== LOCAL_PROTOCOL ||
		record.protocol_version !== LOCAL_PROTOCOL_VERSION ||
		typeof record.origin !== 'string'
	) {
		throw new Error()
	}
	const origin = parseLocalHarnessEvidenceClientOrigin(record.origin)
	return Object.freeze({
		protocol: LOCAL_PROTOCOL,
		protocol_version: LOCAL_PROTOCOL_VERSION,
		origin,
	})
}
