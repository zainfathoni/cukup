import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { TokenProvider } from '../plugin/auth.ts'
import { validateServiceURL } from '../plugin/protocol.ts'
import {
	LOCAL_PROTOCOL,
	LOCAL_PROTOCOL_VERSION,
	canonicalizeEvidence,
	isUuidV4,
	parseEvidenceEnvelope,
	type Capability,
} from './local-harness-evidence.ts'

const DATABASE_VERSION = 1
const RESPONSE_MAX_BYTES = 16 * 1024
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 5 * 60_000] as const

export const PHYSICAL_SHADOW_DEFAULT_MAX_QUEUED_RECORDS = 10_000
export const PHYSICAL_SHADOW_DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024
export const PHYSICAL_SHADOW_DEFAULT_MAX_RECORD_BYTES = 512 * 1024
export const PHYSICAL_SHADOW_DEFAULT_REQUEST_TIMEOUT_MS = 10_000

type Fetch = (input: string, init: RequestInit) => Promise<Response>

export type PhysicalShadowEvidenceOutboxOptions = Readonly<{
	serviceURL: string
	tokenProvider: TokenProvider
	executorHostname: string
	capabilities: readonly Capability[]
	spoolPath: string
	fetch?: Fetch
	now?: () => number
	randomId?: () => string
	maxQueuedRecords?: number
	maxQueuedBytes?: number
	maxRecordBytes?: number
	requestTimeoutMs?: number
}>

export type PhysicalShadowEnqueueResult =
	| Readonly<{ status: 'queued'; records: 0 | 1 }>
	| Readonly<{ status: 'rejected'; reason: 'invalid_evidence' | 'record_too_large' }>
	| Readonly<{ status: 'conflict' | 'spool_full' | 'tracking_failed' }>

export type PhysicalShadowDrainResult = Readonly<{
	status: 'idle' | 'backoff' | 'retryable' | 'blocked' | 'delivered' | 'tracking_failed'
	attempted: 0 | 1
	delivered: 0 | 1
}>

export type PhysicalShadowSpoolStatus = Readonly<{
	queued: number
	blocked: number
	payloadBytes: number
	retrying: number
	blockedReasons: Readonly<{
		invalidRecord: number
		unsupportedVersion: number
		identityConflict: number
		invalidOrder: number
		profile: number
		transport: number
		invalidResponse: number
	}>
}>

type BlockedReason =
	| 'invalid_record'
	| 'unsupported_version'
	| 'identity_conflict'
	| 'invalid_order'
	| 'profile'
	| 'transport'
	| 'invalid_response'

type QueueRow = {
	sourceSequence: number
	evidenceId: string
	envelopeJson: string
	payloadBytes: number
	state: 'queued' | 'blocked'
	blockedReason: BlockedReason | null
	retryAttempt: number
	retryAtMs: number
}

type RequestResult =
	| { kind: 'response'; response: Response; body: unknown; bodyValid: boolean }
	| { kind: 'retryable' }

/**
 * Stage 5C physical-site cloud shadow outbox. Enqueue is local-only and assigns the durable
 * collector identity and source sequence; callers explicitly invoke one bounded FIFO drain step.
 */
export class PhysicalShadowEvidenceOutbox {
	readonly #ownership: Database
	readonly #database: Database
	readonly #serviceOrigin: string
	readonly #tokenProvider: TokenProvider
	readonly #executorHostname: string
	readonly #capabilities: Capability[]
	readonly #fetch: Fetch
	readonly #now: () => number
	readonly #maxQueuedRecords: number
	readonly #maxQueuedBytes: number
	readonly #maxRecordBytes: number
	readonly #requestTimeoutMs: number
	readonly #collectorId: string
	#draining: Promise<PhysicalShadowDrainResult> | undefined

	constructor(options: PhysicalShadowEvidenceOutboxOptions) {
		this.#serviceOrigin = validateServiceURL(options.serviceURL).origin
		this.#tokenProvider = options.tokenProvider
		this.#executorHostname = validateHostname(options.executorHostname)
		this.#fetch = options.fetch ?? fetch
		this.#now = options.now ?? Date.now
		this.#maxQueuedRecords = positiveInteger(
			options.maxQueuedRecords,
			PHYSICAL_SHADOW_DEFAULT_MAX_QUEUED_RECORDS,
		)
		this.#maxQueuedBytes = positiveInteger(
			options.maxQueuedBytes,
			PHYSICAL_SHADOW_DEFAULT_MAX_QUEUED_BYTES,
		)
		this.#maxRecordBytes = positiveInteger(
			options.maxRecordBytes,
			PHYSICAL_SHADOW_DEFAULT_MAX_RECORD_BYTES,
		)
		this.#requestTimeoutMs = positiveInteger(
			options.requestTimeoutMs,
			PHYSICAL_SHADOW_DEFAULT_REQUEST_TIMEOUT_MS,
		)
		this.#capabilities = validateCapabilities(options.capabilities)

		prepareSpoolDirectory(options.spoolPath)
		this.#ownership = acquireOwnership(`${options.spoolPath}.owner`)
		let database: Database
		try {
			prepareDatabaseFile(options.spoolPath)
			prepareExistingFile(`${options.spoolPath}-wal`)
			prepareExistingFile(`${options.spoolPath}-shm`)
			database = new Database(options.spoolPath, { create: true, strict: true })
		} catch (error) {
			this.#ownership.close()
			throw error
		}
		this.#database = database
		try {
			this.#database.exec('PRAGMA busy_timeout = 100')
			this.#migrate()
			this.#collectorId = this.#initializeCollector(options.randomId ?? randomUUID)
			this.#database.exec('PRAGMA journal_mode = WAL')
			prepareExistingFile(`${options.spoolPath}-wal`)
			prepareExistingFile(`${options.spoolPath}-shm`)
		} catch (error) {
			this.#database.close()
			this.#ownership.close()
			throw error
		}
	}

	enqueue(value: unknown): PhysicalShadowEnqueueResult {
		const candidate = {
			protocol: LOCAL_PROTOCOL,
			protocol_version: LOCAL_PROTOCOL_VERSION,
			collector_instance_id: this.#collectorId,
			capabilities: this.#capabilities,
			evidence: [value],
		}
		const parsed = parseEvidenceEnvelope(candidate, this.#now())
		if (
			'reason' in parsed ||
			'unsupported' in parsed ||
			parsed.evidence.length !== 1 ||
			'reason' in parsed.evidence[0]!
		) {
			return { status: 'rejected', reason: 'invalid_evidence' }
		}
		const evidence = parsed.evidence[0].value
		const envelopeJson = JSON.stringify({
			protocol: LOCAL_PROTOCOL,
			protocol_version: LOCAL_PROTOCOL_VERSION,
			collector_instance_id: this.#collectorId,
			capabilities: this.#capabilities,
			evidence: [JSON.parse(canonicalizeEvidence(evidence)) as unknown],
		})
		const payloadBytes = encodedRequestBytes(Number.MAX_SAFE_INTEGER, envelopeJson)
		if (payloadBytes > this.#maxRecordBytes) {
			return { status: 'rejected', reason: 'record_too_large' }
		}

		try {
			return this.#database.transaction((): PhysicalShadowEnqueueResult => {
				const existing = this.#database
					.query<{ envelopeJson: string }, [string]>(
						'SELECT envelope_json AS envelopeJson FROM physical_shadow_outbox WHERE evidence_id = ?',
					)
					.get(evidence.evidence_id)
				if (existing !== null) {
					return existing.envelopeJson === envelopeJson
						? { status: 'queued', records: 0 }
						: { status: 'conflict' }
				}
				const totals = this.#database
					.query<{ count: number; bytes: number }, []>(
						`SELECT count(*) AS count, coalesce(sum(payload_bytes), 0) AS bytes
						 FROM physical_shadow_outbox`,
					)
					.get()!
				const latest = this.#database
					.query<{ sequence: number }, []>(
						`SELECT coalesce(max(source_sequence), 0) AS sequence FROM physical_shadow_outbox`,
					)
					.get()!.sequence
				if (
					totals.count >= this.#maxQueuedRecords ||
					totals.bytes + payloadBytes > this.#maxQueuedBytes ||
					latest >= Number.MAX_SAFE_INTEGER
				) {
					return { status: 'spool_full' }
				}
				this.#database
					.query(
						`INSERT INTO physical_shadow_outbox
							(evidence_id, envelope_json, payload_bytes) VALUES (?, ?, ?)`,
					)
					.run(evidence.evidence_id, envelopeJson, payloadBytes)
				return { status: 'queued', records: 1 }
			}).immediate()
		} catch {
			return { status: 'tracking_failed' }
		}
	}

	drainStep(): Promise<PhysicalShadowDrainResult> {
		if (this.#draining !== undefined) return this.#draining
		this.#draining = this.#drain().finally(() => {
			this.#draining = undefined
		})
		return this.#draining
	}

	async #drain(): Promise<PhysicalShadowDrainResult> {
		let row: QueueRow | null
		try {
			row = this.#oldest()
		} catch {
			return drainResult('tracking_failed')
		}
		if (row === null) return drainResult('idle')
		if (row.state === 'blocked') return drainResult('blocked')
		if (row.retryAtMs > this.#now()) return drainResult('backoff')

		let token: string
		try {
			token = await this.#tokenProvider.getToken()
		} catch {
			return this.#retry(row.sourceSequence)
		}
		if (token.length < 32 || token.length > 16 * 1024 || /\s/.test(token)) {
			return this.#retry(row.sourceSequence)
		}

		const profile = await this.#request('/v1/executor-profile', token, 'PUT', {
			hostname: this.#executorHostname,
		})
		if (profile.kind === 'retryable') return this.#retry(row.sourceSequence)
		if (isRetryableStatus(profile.response.status)) return this.#retry(row.sourceSequence)
		if (
			profile.response.status !== 200 ||
			!profile.bodyValid ||
			!exactObject(profile.body, ['executor_label']) ||
			profile.body.executor_label !== this.#executorHostname
		) {
			return this.#block(
				row.sourceSequence,
				profile.response.status === 200 ? 'invalid_response' : 'profile',
			)
		}

		const envelope = JSON.parse(row.envelopeJson) as unknown
		const delivery = await this.#request('/v1/shadow-evidence', token, 'POST', {
			source_sequence: row.sourceSequence,
			envelope,
		})
		token = ''
		if (delivery.kind === 'retryable') return this.#retry(row.sourceSequence, 1)
		if (isRetryableStatus(delivery.response.status)) return this.#retry(row.sourceSequence, 1)
		if (delivery.response.status !== 200) {
			return this.#block(row.sourceSequence, 'transport', 1)
		}
		if (!delivery.bodyValid) return this.#block(row.sourceSequence, 'invalid_response', 1)
		const outcome = parseShadowOutcome(delivery.body)
		if (outcome === undefined) return this.#block(row.sourceSequence, 'invalid_response', 1)
		if (outcome.status !== 'rejected') {
			try {
				const change = this.#database
					.query(`DELETE FROM physical_shadow_outbox WHERE source_sequence = ? AND state = 'queued'`)
					.run(row.sourceSequence)
				if (change.changes !== 1) return drainResult('tracking_failed', 1)
				return drainResult('delivered', 1, 1)
			} catch {
				return drainResult('tracking_failed', 1)
			}
		}
		return this.#block(row.sourceSequence, outcome.reason, 1)
	}

	status(): PhysicalShadowSpoolStatus {
		try {
			const row = this.#database
				.query<{
					queued: number
					blocked: number
					bytes: number
					retrying: number
					invalidRecord: number
					unsupportedVersion: number
					identityConflict: number
					invalidOrder: number
					profile: number
					transport: number
					invalidResponse: number
				}, []>(
					`SELECT
						coalesce(sum(state = 'queued'), 0) AS queued,
						coalesce(sum(state = 'blocked'), 0) AS blocked,
						coalesce(sum(payload_bytes), 0) AS bytes,
						coalesce(sum(state = 'queued' AND retry_at_ms > 0), 0) AS retrying,
						coalesce(sum(blocked_reason = 'invalid_record'), 0) AS invalidRecord,
						coalesce(sum(blocked_reason = 'unsupported_version'), 0) AS unsupportedVersion,
						coalesce(sum(blocked_reason = 'identity_conflict'), 0) AS identityConflict,
						coalesce(sum(blocked_reason = 'invalid_order'), 0) AS invalidOrder,
						coalesce(sum(blocked_reason = 'profile'), 0) AS profile,
						coalesce(sum(blocked_reason = 'transport'), 0) AS transport,
						coalesce(sum(blocked_reason = 'invalid_response'), 0) AS invalidResponse
					 FROM physical_shadow_outbox`,
				)
				.get()!
			return {
				queued: row.queued,
				blocked: row.blocked,
				payloadBytes: row.bytes,
				retrying: row.retrying,
				blockedReasons: {
					invalidRecord: row.invalidRecord,
					unsupportedVersion: row.unsupportedVersion,
					identityConflict: row.identityConflict,
					invalidOrder: row.invalidOrder,
					profile: row.profile,
					transport: row.transport,
					invalidResponse: row.invalidResponse,
				},
			}
		} catch {
			throw new Error('Physical shadow spool status unavailable')
		}
	}

	close(): void {
		if (this.#draining !== undefined) {
			throw new Error('Physical shadow drain must finish before close')
		}
		this.#database.close()
		this.#ownership.close()
	}

	#oldest(): QueueRow | null {
		return this.#database
			.query<QueueRow, []>(
				`SELECT source_sequence AS sourceSequence, evidence_id AS evidenceId,
					envelope_json AS envelopeJson, payload_bytes AS payloadBytes, state,
					blocked_reason AS blockedReason, retry_attempt AS retryAttempt,
					retry_at_ms AS retryAtMs
				 FROM physical_shadow_outbox ORDER BY source_sequence LIMIT 1`,
			)
			.get()
	}

	async #request(path: string, token: string, method: 'PUT' | 'POST', body: object): Promise<RequestResult> {
		if (token.length < 32 || token.length > 16 * 1024 || /\s/.test(token)) return { kind: 'retryable' }
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs)
		try {
			const response = await this.#fetch(`${this.#serviceOrigin}${path}`, {
				method,
				headers: {
					accept: 'application/json',
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(body),
				signal: controller.signal,
				redirect: 'manual',
			})
			if (response.status !== 200) {
				void response.body?.cancel().catch(() => undefined)
				return { kind: 'response', response, body: undefined, bodyValid: false }
			}
			const parsed = await readBoundedJson(response)
			if (parsed.kind === 'interrupted') return { kind: 'retryable' }
			return parsed.kind === 'parsed'
				? { kind: 'response', response, body: parsed.value, bodyValid: true }
				: { kind: 'response', response, body: undefined, bodyValid: false }
		} catch {
			return { kind: 'retryable' }
		} finally {
			clearTimeout(timeout)
		}
	}

	#retry(sourceSequence: number, attempted: 0 | 1 = 0): PhysicalShadowDrainResult {
		try {
			const current = this.#database
				.query<{ attempt: number }, [number]>(
					'SELECT retry_attempt AS attempt FROM physical_shadow_outbox WHERE source_sequence = ?',
				)
				.get(sourceSequence)!
			const attempt = Math.min(current.attempt + 1, RETRY_DELAYS_MS.length)
			const change = this.#database
				.query('UPDATE physical_shadow_outbox SET retry_attempt = ?, retry_at_ms = ? WHERE source_sequence = ?')
				.run(attempt, this.#now() + RETRY_DELAYS_MS[attempt - 1]!, sourceSequence)
			if (change.changes !== 1) return drainResult('tracking_failed', attempted)
			return drainResult('retryable', attempted)
		} catch {
			return drainResult('tracking_failed', attempted)
		}
	}

	#block(
		sourceSequence: number,
		reason: BlockedReason,
		attempted: 0 | 1 = 0,
	): PhysicalShadowDrainResult {
		try {
			const change = this.#database
				.query(
					`UPDATE physical_shadow_outbox SET state = 'blocked', blocked_reason = ?
					 WHERE source_sequence = ? AND state = 'queued'`,
				)
				.run(reason, sourceSequence)
			if (change.changes !== 1) return drainResult('tracking_failed', attempted)
			return drainResult('blocked', attempted)
		} catch {
			return drainResult('tracking_failed', attempted)
		}
	}

	#migrate(): void {
		const version = this.#database.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version
		if (version > DATABASE_VERSION) {
			throw new Error(`Physical shadow spool schema version ${version} is newer than supported version ${DATABASE_VERSION}`)
		}
		this.#database.transaction(() => {
			this.#database.exec(`
				CREATE TABLE IF NOT EXISTS physical_shadow_settings (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				) STRICT;
				CREATE TABLE IF NOT EXISTS physical_shadow_outbox (
					source_sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (source_sequence BETWEEN 1 AND 9007199254740991),
					evidence_id TEXT NOT NULL UNIQUE,
					envelope_json TEXT NOT NULL,
					payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0),
					state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'blocked')),
					blocked_reason TEXT CHECK (blocked_reason IN (
						'invalid_record', 'unsupported_version', 'identity_conflict', 'invalid_order',
						'profile', 'transport', 'invalid_response'
					)),
					retry_attempt INTEGER NOT NULL DEFAULT 0 CHECK (retry_attempt BETWEEN 0 AND 4),
					retry_at_ms INTEGER NOT NULL DEFAULT 0,
					CHECK ((state = 'queued' AND blocked_reason IS NULL) OR
						(state = 'blocked' AND blocked_reason IS NOT NULL))
				) STRICT;
				PRAGMA user_version = ${DATABASE_VERSION};
			`)
		}).immediate()
	}

	#initializeCollector(randomId: () => string): string {
		return this.#database.transaction(() => {
			const existing = this.#database
				.query<{ value: string }, []>(
					`SELECT value FROM physical_shadow_settings WHERE key = 'collector_id'`,
				)
				.get()?.value
			if (existing !== undefined) {
				if (!isUuidV4(existing)) throw new Error('Physical shadow collector identity is invalid')
				return existing
			}
			const created = randomId()
			if (!isUuidV4(created)) throw new Error('Physical shadow collector identity generation failed')
			this.#database
				.query(`INSERT INTO physical_shadow_settings (key, value) VALUES ('collector_id', ?)`)
				.run(created)
			return created
		}).immediate()
	}
}

type ShadowOutcome =
	| { status: 'accepted' | 'duplicate' }
	| { status: 'rejected'; reason: Extract<BlockedReason, 'invalid_record' | 'unsupported_version' | 'identity_conflict' | 'invalid_order'> }

function parseShadowOutcome(value: unknown): ShadowOutcome | undefined {
	if (!isRecord(value)) return undefined
	if (
		(value.status === 'accepted' || value.status === 'duplicate') &&
		exactObject(value, ['status'])
	) {
		return value as ShadowOutcome
	}
	if (
		value.status === 'rejected' &&
		(value.reason === 'invalid_record' ||
			value.reason === 'unsupported_version' ||
			value.reason === 'identity_conflict' ||
			value.reason === 'invalid_order') &&
		exactObject(value, ['reason', 'status'])
	) {
		return value as ShadowOutcome
	}
	return undefined
}

function validateCapabilities(value: readonly Capability[]): Capability[] {
	const parsed = parseEvidenceEnvelope({
		protocol: LOCAL_PROTOCOL,
		protocol_version: LOCAL_PROTOCOL_VERSION,
		collector_instance_id: '00000000-0000-4000-8000-000000000000',
		capabilities: value,
		evidence: [],
	}, Date.now())
	if ('reason' in parsed || 'unsupported' in parsed) throw new Error('Invalid physical shadow capabilities')
	return [...parsed.capabilities].sort()
}

function validateHostname(value: string): string {
	if (!value || value.length > 255 || /\s/.test(value)) {
		throw new Error('Physical shadow executor hostname is invalid')
	}
	return value
}

function positiveInteger(value: number | undefined, fallback: number): number {
	const selected = value ?? fallback
	if (!Number.isSafeInteger(selected) || selected < 1) throw new Error('Physical shadow limits must be positive integers')
	return selected
}

function encodedRequestBytes(sourceSequence: number, envelopeJson: string): number {
	return Buffer.byteLength(`{"source_sequence":${sourceSequence},"envelope":${envelopeJson}}`)
}

function isRetryableStatus(status: number): boolean {
	return status === 401 || status === 408 || status === 425 || status === 429 || status >= 500
}

function drainResult(
	status: PhysicalShadowDrainResult['status'],
	attempted: 0 | 1 = 0,
	delivered: 0 | 1 = 0,
): PhysicalShadowDrainResult {
	return { status, attempted, delivered }
}

async function readBoundedJson(
	response: Response,
): Promise<{ kind: 'parsed'; value: unknown } | { kind: 'invalid' | 'interrupted' }> {
	if (response.body === null || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
		void response.body?.cancel().catch(() => undefined)
		return { kind: 'invalid' }
	}
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let length = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			length += value.byteLength
			if (length > RESPONSE_MAX_BYTES) {
				void reader.cancel().catch(() => undefined)
				return { kind: 'invalid' }
			}
			chunks.push(value)
		}
		const bytes = new Uint8Array(length)
		let offset = 0
		for (const chunk of chunks) {
			bytes.set(chunk, offset)
			offset += chunk.byteLength
		}
		try {
			return {
				kind: 'parsed',
				value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
			}
		} catch {
			return { kind: 'invalid' }
		}
	} catch {
		return { kind: 'interrupted' }
	}
}

function prepareSpoolDirectory(spoolPath: string): void {
	if (
		!isAbsolute(spoolPath) ||
		spoolPath.length === 0 ||
		spoolPath !== spoolPath.trim() ||
		resolve(spoolPath) !== spoolPath
	) {
		throw new Error('Physical shadow spool requires an exact absolute file path')
	}
	const directory = dirname(spoolPath)
	const createdDirectory = mkdirSync(directory, { recursive: true, mode: 0o700 })
	if (realpathSync(directory) !== directory) throw new Error('Physical shadow spool directory is unsafe')
	const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
	try {
		const stat = fstatSync(descriptor)
		const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
		if (
			!stat.isDirectory() ||
			(uid !== undefined && stat.uid !== uid) ||
			(createdDirectory === undefined && (stat.mode & 0o777) !== 0o700)
		) {
			throw new Error('Physical shadow spool directory is unsafe')
		}
		if (createdDirectory !== undefined) fchmodSync(descriptor, 0o700)
	} finally {
		closeSync(descriptor)
	}
}

function acquireOwnership(path: string): Database {
	prepareOwnershipFile(path)
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

function prepareOwnershipFile(path: string): void {
	try {
		const stat = lstatSync(path)
		const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			(stat.mode & 0o777) !== 0o600 ||
			(uid !== undefined && stat.uid !== uid)
		) {
			throw new Error('Physical shadow ownership file is unsafe')
		}
		return
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
	}
	const descriptor = openSync(
		path,
		constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	)
	try {
		secureDescriptor(descriptor)
	} finally {
		closeSync(descriptor)
	}
}

function prepareExistingFile(path: string): void {
	try {
		const descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW)
		try {
			secureDescriptor(descriptor)
		} finally {
			closeSync(descriptor)
		}
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
	}
}

function prepareDatabaseFile(path: string): void {
	if (path.length === 0 || path !== path.trim() || path === ':memory:') {
		throw new Error('Physical shadow spool requires an exact durable file path')
	}
	try {
		if (!lstatSync(path).isFile()) throw new Error('Physical shadow spool must be a regular file')
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
	}
	let descriptor: number
	try {
		descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
		descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW)
	}
	try {
		secureDescriptor(descriptor)
	} finally {
		closeSync(descriptor)
	}
}

function secureDescriptor(descriptor: number): void {
	const stat = fstatSync(descriptor)
	const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
	if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) {
		throw new Error('Physical shadow spool must be an owner-owned regular file')
	}
	fchmodSync(descriptor, 0o600)
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
	return isRecord(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
