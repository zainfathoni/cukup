import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	createDiscoveredLocalHarnessEvidenceClient,
	discoverLocalHarnessEvidenceEndpoint,
	startLocalHarnessEvidenceRuntime,
	type LocalHarnessEvidenceRuntime,
} from './local-harness-evidence-runtime.ts'
import { LOCAL_PROTOCOL, LOCAL_PROTOCOL_VERSION } from './local-harness-evidence.ts'

const COLLECTOR = '20000000-0000-4000-8000-000000000001'
const EVIDENCE = '40000000-0000-4000-8000-000000000001'
const roots: string[] = []
const runtimes: LocalHarnessEvidenceRuntime[] = []

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.stop()
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
	const value = mkdtempSync(join(tmpdir(), 'cukup-runtime-'))
	roots.push(value)
	return value
}

function state(rootPath = root()): string {
	return join(rootPath, 'state')
}

function start(stateDirectory: string, port?: number): LocalHarnessEvidenceRuntime {
	const runtime = startLocalHarnessEvidenceRuntime({ stateDirectory, port })
	runtimes.push(runtime)
	return runtime
}

function envelope() {
	return {
		protocol: LOCAL_PROTOCOL,
		protocol_version: LOCAL_PROTOCOL_VERSION,
		collector_instance_id: COLLECTOR,
		capabilities: ['engagement.submission'],
		evidence: [
			{
				family: 'engagement',
				evidence_id: EVIDENCE,
				interaction: 'submission',
				origin: 'human',
				recovered: false,
				timing: {
					wall_time: new Date(Date.now() - 1_000).toISOString(),
					provenance: 'collector_observation',
					precision_ms: 1,
				},
				project_attribution: { kind: 'unassigned', reason: 'absent' },
			},
		],
	}
}

describe('programmatic local Harness evidence runtime', () => {
	test('fresh provisioning is owner-only, canonical, closed, and ready when published', async () => {
		const stateDirectory = state()
		const runtime = start(stateDirectory)
		const names = [
			'execution-site-id',
			'receiver-token',
			'receiver.sqlite',
			'runtime-ownership.sqlite',
			'endpoint.json',
		]
		expect(statSync(stateDirectory).mode & 0o777).toBe(0o700)
		for (const name of names) {
			const stat = statSync(join(stateDirectory, name))
			expect(stat.isFile()).toBeTrue()
			expect(stat.mode & 0o777).toBe(0o600)
		}
		const site = readFileSync(join(stateDirectory, 'execution-site-id'), 'utf8')
		const token = readFileSync(join(stateDirectory, 'receiver-token'), 'utf8')
		expect(site).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
		const descriptorText = readFileSync(join(stateDirectory, 'endpoint.json'), 'utf8')
		expect(JSON.parse(descriptorText)).toEqual(runtime.endpoint)
		expect(Object.keys(JSON.parse(descriptorText))).toEqual(['protocol', 'protocol_version', 'origin'])
		expect(descriptorText).not.toContain(site)
		expect(descriptorText).not.toContain(token)
		expect(descriptorText).not.toContain(stateDirectory)
		expect(await discoverLocalHarnessEvidenceEndpoint(stateDirectory)).toEqual(runtime.endpoint)
	})

	test('constructs the existing client from discovery and delivers persisted evidence', async () => {
		const rootPath = root()
		const stateDirectory = state(rootPath)
		const runtime = start(stateDirectory)
		const client = await createDiscoveredLocalHarnessEvidenceClient({
			stateDirectory,
			spoolPath: join(rootPath, 'collector', 'spool.sqlite'),
		})
		try {
			expect(client.enqueue(envelope())).toEqual({ status: 'queued', records: 1 })
			expect(await client.drainStep()).toEqual({
				status: 'delivered',
				attempted: 1,
				delivered: 1,
				blocked: 0,
			})
		} finally {
			client.close()
		}
		await runtime.stop()
		runtimes.splice(runtimes.indexOf(runtime), 1)
		const database = new Database(join(stateDirectory, 'receiver.sqlite'), { readonly: true })
		try {
			expect(database.query<{ count: number }, []>('SELECT count(*) AS count FROM accepted_evidence').get()!.count).toBe(1)
		} finally {
			database.close()
		}
	})

	test('restart preserves site and token, replaces a stale endpoint, and stale discovery fails', async () => {
		const stateDirectory = state()
		const first = start(stateDirectory)
		const site = readFileSync(join(stateDirectory, 'execution-site-id'), 'utf8')
		const token = readFileSync(join(stateDirectory, 'receiver-token'), 'utf8')
		const oldEndpoint = first.endpoint
		await first.stop()
		runtimes.splice(runtimes.indexOf(first), 1)
		await expect(discoverLocalHarnessEvidenceEndpoint(stateDirectory)).rejects.toThrow(
			'Local Harness evidence endpoint is unavailable',
		)
		writeFileSync(join(stateDirectory, 'endpoint.json'), JSON.stringify(oldEndpoint), { mode: 0o600 })
		const occupyingServer = Bun.serve({ hostname: '127.0.0.1', port: new URL(oldEndpoint.origin).port, fetch: () => new Response() })
		try {
			const second = start(stateDirectory)
			expect(second.endpoint.origin).not.toBe(oldEndpoint.origin)
			expect(readFileSync(join(stateDirectory, 'execution-site-id'), 'utf8')).toBe(site)
			expect(readFileSync(join(stateDirectory, 'receiver-token'), 'utf8')).toBe(token)
			expect(await discoverLocalHarnessEvidenceEndpoint(stateDirectory)).toEqual(second.endpoint)
		} finally {
			await occupyingServer.stop(true)
		}
	})

	test('rejects another live Cukup runtime substituted into a stale descriptor', async () => {
		const stateA = state()
		const stateB = state()
		start(stateA)
		const runtimeB = start(stateB)
		const tokenA = readFileSync(join(stateA, 'receiver-token'), 'utf8')
		const tokenB = readFileSync(join(stateB, 'receiver-token'), 'utf8')
		expect(tokenA).not.toBe(tokenB)
		writeFileSync(join(stateA, 'endpoint.json'), JSON.stringify(runtimeB.endpoint), { mode: 0o600 })
		await expect(discoverLocalHarnessEvidenceEndpoint(stateA)).rejects.toThrow(DISCOVERY_ERROR)
	})

	test('refuses concurrent ownership and failed listener startup publishes nothing', async () => {
		const firstState = state()
		const first = start(firstState)
		expect(() => startLocalHarnessEvidenceRuntime({ stateDirectory: firstState })).toThrow(
			'Local Harness evidence runtime is unavailable',
		)
		expect(await discoverLocalHarnessEvidenceEndpoint(firstState)).toEqual(first.endpoint)

		const failedState = state()
		expect(() => startLocalHarnessEvidenceRuntime({
			stateDirectory: failedState,
			port: Number(new URL(first.endpoint.origin).port),
		})).toThrow('Local Harness evidence runtime is unavailable')
		expect(() => statSync(join(failedState, 'endpoint.json'))).toThrow()
	})

	test('stop removes discovery without deleting durable evidence or identity', async () => {
		const stateDirectory = state()
		const runtime = start(stateDirectory)
		const site = readFileSync(join(stateDirectory, 'execution-site-id'), 'utf8')
		await runtime.stop()
		runtimes.splice(runtimes.indexOf(runtime), 1)
		expect(() => statSync(join(stateDirectory, 'endpoint.json'))).toThrow()
		expect(readFileSync(join(stateDirectory, 'execution-site-id'), 'utf8')).toBe(site)
		expect(statSync(join(stateDirectory, 'receiver.sqlite')).isFile()).toBeTrue()
	})

	test('rejects non-exact, symlinked, non-directory, malformed, and non-file state', async () => {
		const rootPath = root()
		const exact = state(rootPath)
		for (const invalid of ['relative', `${exact}/`, `${rootPath}/state/../state`]) {
			expect(() => startLocalHarnessEvidenceRuntime({ stateDirectory: invalid })).toThrow(
				'Local Harness evidence runtime is unavailable',
			)
		}
		const target = join(rootPath, 'target')
		const linked = join(rootPath, 'linked')
		writeFileSync(target, 'not a directory')
		symlinkSync(target, linked)
		expect(() => startLocalHarnessEvidenceRuntime({ stateDirectory: target })).toThrow(RUNTIME_ERROR)
		expect(() => startLocalHarnessEvidenceRuntime({ stateDirectory: linked })).toThrow(RUNTIME_ERROR)

		const stateDirectory = exact
		const runtime = start(stateDirectory)
		await runtime.stop()
		runtimes.splice(runtimes.indexOf(runtime), 1)
		writeFileSync(join(stateDirectory, 'endpoint.json'), '{"origin":"http://127.0.0.1:1","extra":"secret"}', { mode: 0o600 })
		await expect(discoverLocalHarnessEvidenceEndpoint(stateDirectory)).rejects.toThrow(DISCOVERY_ERROR)
		rmSync(join(stateDirectory, 'receiver-token'))
		symlinkSync(join(stateDirectory, 'execution-site-id'), join(stateDirectory, 'receiver-token'))
		expect(() => startLocalHarnessEvidenceRuntime({ stateDirectory })).toThrow(RUNTIME_ERROR)
	})

	test('fixed errors disclose no supplied paths, secrets, or native metadata', async () => {
		const sensitivePath = join(root(), 'private-user-workspace')
		const values = ['/private/user/path', 'native-session-123', 'prompt marker']
		let message = ''
		try {
			await discoverLocalHarnessEvidenceEndpoint(sensitivePath)
		} catch (error) {
			message = String(error)
		}
		expect(message).toContain(DISCOVERY_ERROR)
		expect(message).not.toContain(sensitivePath)
		for (const value of values) expect(message).not.toContain(value)
	})
})

const RUNTIME_ERROR = 'Local Harness evidence runtime is unavailable'
const DISCOVERY_ERROR = 'Local Harness evidence endpoint is unavailable'
