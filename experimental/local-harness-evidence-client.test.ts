import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	LocalHarnessEvidenceClient,
	type LocalHarnessEvidenceClientOptions,
} from './local-harness-evidence-client.ts'
import {
	LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH,
	LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH,
	startLocalHarnessEvidenceHttpServer,
	type LocalHarnessEvidenceHttpServer,
} from './local-harness-evidence-http-server.ts'
import { LocalHarnessEvidenceReceiver } from './local-harness-evidence-receiver.ts'
import { LOCAL_PROTOCOL, LOCAL_PROTOCOL_VERSION, type Capability } from './local-harness-evidence.ts'

const NOW = Date.parse('2026-09-10T03:00:00.000Z')
const SITE = '10000000-0000-4000-8000-000000000001'
const COLLECTOR = '20000000-0000-4000-8000-000000000001'
const PROJECT = '30000000-0000-4000-8000-000000000001'
const TOKEN = randomBytes(32).toString('base64url')
const OTHER_TOKEN = randomBytes(32).toString('base64url')

const directories: string[] = []
const clients: LocalHarnessEvidenceClient[] = []
const servers: LocalHarnessEvidenceHttpServer[] = []
const receivers: LocalHarnessEvidenceReceiver[] = []

afterEach(async () => {
	for (const client of clients.splice(0)) client.close()
	for (const server of servers.splice(0)) await server.stop()
	for (const receiver of receivers.splice(0)) receiver.close()
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function path(name = 'spool.sqlite'): string {
	const directory = mkdtempSync(join(tmpdir(), 'cukup-client-'))
	directories.push(directory)
	return join(directory, name)
}

function client(
	spoolPath: string,
	overrides: Partial<LocalHarnessEvidenceClientOptions> = {},
): LocalHarnessEvidenceClient {
	const value = new LocalHarnessEvidenceClient({
		origin: 'http://127.0.0.1:49151',
		tokenProvider: () => TOKEN,
		spoolPath,
		now: () => NOW,
		...overrides,
	})
	clients.push(value)
	return value
}

function realServer(receiverPath = path('receiver.sqlite')) {
	const receiver = new LocalHarnessEvidenceReceiver(receiverPath, SITE)
	receivers.push(receiver)
	const server = startLocalHarnessEvidenceHttpServer({ receiver, token: TOKEN })
	servers.push(server)
	return { receiverPath, origin: `http://${server.hostname}:${server.port}` }
}

function envelope(
	evidence: unknown[],
	capabilities: Capability[] = ['engagement.submission'],
	collector = COLLECTOR,
) {
	return {
		protocol: LOCAL_PROTOCOL,
		protocol_version: LOCAL_PROTOCOL_VERSION,
		collector_instance_id: collector,
		capabilities,
		evidence,
	}
}

function engagement(evidenceId: string, interaction: 'submission' | 'approval' = 'submission') {
	return {
		family: 'engagement',
		evidence_id: evidenceId,
		interaction,
		origin: 'human',
		recovered: false,
		timing: {
			wall_time: '2026-09-10T02:00:00.000Z',
			provenance: 'collector_observation',
			precision_ms: 1,
		},
		project_attribution: { kind: 'cukup_project', project_id: PROJECT, basis: 'approved_mapping' },
	}
}

function count(databasePath: string, table: string): number {
	const database = new Database(databasePath, { readonly: true, strict: true })
	try {
		return database.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()!.count
	} finally {
		database.close()
	}
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function scriptedFetch(
	evidenceResponse: (body: Record<string, unknown>) => Response,
	onRequest?: (path: string, body: Record<string, unknown>) => void,
) {
	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const pathname = new URL(String(input)).pathname
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>
		onRequest?.(pathname, body)
		if (pathname === LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH) {
			return json({ protocol: LOCAL_PROTOCOL, selected_version: LOCAL_PROTOCOL_VERSION })
		}
		return evidenceResponse(body)
	}
}

function accepted(body: Record<string, unknown>): Response {
	const evidence = body.evidence as Array<{ evidence_id: string }>
	return json({ outcomes: evidence.map(({ evidence_id }) => ({ evidence_id, status: 'accepted' })) })
}

describe('experimental local Harness evidence collector client', () => {
	test('enqueues without a receiver, survives restart, and delivers exactly once to the real server', async () => {
		const spoolPath = path()
		const evidence = engagement('40000000-0000-4000-8000-000000000001')
		let value = client(spoolPath)
		const started = performance.now()
		expect(value.enqueue(envelope([evidence]))).toEqual({ status: 'queued', records: 1 })
		expect(performance.now() - started).toBeLessThan(250)
		expect(value.status()).toMatchObject({ queued: 1, blocked: 0 })
		value.close()
		clients.splice(clients.indexOf(value), 1)

		const server = realServer()
		value = client(spoolPath, { origin: server.origin })
		expect(await value.drainStep()).toEqual({
			status: 'delivered',
			attempted: 1,
			delivered: 1,
			blocked: 0,
		})
		expect(await value.drainStep()).toMatchObject({ status: 'idle', attempted: 0 })
		expect(count(server.receiverPath, 'accepted_evidence')).toBe(1)
	})

	test('retries exact evidence after response loss and clears the receiver duplicate', async () => {
		const server = realServer()
		const spoolPath = path()
		let now = NOW
		let loseResponse = true
		const fetchAfterCommit = async (input: string | URL | Request, init?: RequestInit) => {
			const response = await fetch(input, init)
			if (new URL(String(input)).pathname === LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH && loseResponse) {
				loseResponse = false
				await response.text()
				throw new Error('synthetic response loss')
			}
			return response
		}
		const value = client(spoolPath, { origin: server.origin, fetch: fetchAfterCommit, now: () => now })
		value.enqueue(envelope([engagement('41000000-0000-4000-8000-000000000001')]))
		expect(await value.drainStep()).toMatchObject({ status: 'retryable', attempted: 1 })
		expect(count(server.receiverPath, 'accepted_evidence')).toBe(1)
		expect(value.status()).toMatchObject({ queued: 1, retryingGroups: 1 })
		now += 1_000
		expect(await value.drainStep()).toMatchObject({ status: 'delivered', delivered: 1 })
		expect(count(server.receiverPath, 'accepted_evidence')).toBe(1)
		expect(value.status()).toMatchObject({ queued: 0, payloadBytes: 0 })
	})

	test('persists timeout/503 backoff and does no premature network work after reopen', async () => {
		const spoolPath = path()
		let now = NOW
		let calls = 0
		const unavailable = async () => {
			calls += 1
			return json({ error: 'service_unavailable' }, 503)
		}
		let value = client(spoolPath, { fetch: unavailable, now: () => now })
		value.enqueue(envelope([engagement('42000000-0000-4000-8000-000000000001')]))
		expect(await value.drainStep()).toMatchObject({ status: 'retryable' })
		expect(calls).toBe(1)
		value.close()
		clients.splice(clients.indexOf(value), 1)
		value = client(spoolPath, { fetch: unavailable, now: () => now })
		expect(await value.drainStep()).toMatchObject({ status: 'backoff' })
		expect(calls).toBe(1)
		now += 1_000
		expect(await value.drainStep()).toMatchObject({ status: 'retryable' })
		expect(calls).toBe(2)

		const timeoutPath = path()
		const timedOut = client(timeoutPath, {
			fetch: async () => {
				throw new DOMException('synthetic timeout detail', 'AbortError')
			},
		})
		timedOut.enqueue(envelope([engagement('42000000-0000-4000-8000-000000000002')]))
		expect(await timedOut.drainStep()).toMatchObject({ status: 'retryable' })
	})

	test('uses the token provider for each request and picks up rotation on a later cycle', async () => {
		const server = realServer()
		let now = NOW
		let token = OTHER_TOKEN
		let providerCalls = 0
		const value = client(path(), {
			origin: server.origin,
			now: () => now,
			tokenProvider: () => {
				providerCalls += 1
				return token
			},
		})
		value.enqueue(envelope([engagement('43000000-0000-4000-8000-000000000001')]))
		expect(await value.drainStep()).toMatchObject({ status: 'retryable' })
		token = TOKEN
		now += 1_000
		expect(await value.drainStep()).toMatchObject({ status: 'delivered', delivered: 1 })
		expect(providerCalls).toBe(3)
	})

	test('keeps exact snapshots separate and drains only the contiguous FIFO group', async () => {
		const requests: Array<{ path: string; capabilities: unknown }> = []
		const value = client(path(), {
			fetch: scriptedFetch(accepted, (requestPath, body) =>
				requests.push({ path: requestPath, capabilities: body.capabilities }),
			),
		})
		const a: Capability[] = ['engagement.submission']
		const b: Capability[] = ['engagement.submission', 'engagement.approval']
		value.enqueue(envelope([engagement('44000000-0000-4000-8000-000000000001')], a))
		value.enqueue(envelope([engagement('44000000-0000-4000-8000-000000000002', 'approval')], b))
		value.enqueue(envelope([engagement('44000000-0000-4000-8000-000000000003')], a))
		for (let index = 0; index < 3; index += 1) {
			expect(await value.drainStep()).toMatchObject({ status: 'delivered', attempted: 1 })
		}
		expect(requests.filter(({ path }) => path === LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH)).toEqual([
			{ path: LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH, capabilities: a },
			{ path: LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH, capabilities: [...b].sort() },
			{ path: LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH, capabilities: a },
		])
	})

	test('clears accepted/duplicate and retains conflict/rejected as visible FIFO blockers', async () => {
		const ids = [
			'45000000-0000-4000-8000-000000000001',
			'45000000-0000-4000-8000-000000000002',
			'45000000-0000-4000-8000-000000000003',
			'45000000-0000-4000-8000-000000000004',
		]
		const value = client(path(), {
			fetch: scriptedFetch(() =>
				json({
					outcomes: [
						{ evidence_id: ids[0], status: 'accepted' },
						{ evidence_id: ids[1], status: 'duplicate' },
						{ evidence_id: ids[2], status: 'conflict', reason: 'identity_conflict' },
						{ evidence_id: ids[3], status: 'rejected', reason: 'invalid_order' },
					],
				}),
			),
		})
		value.enqueue(envelope(ids.map((id) => engagement(id))))
		expect(await value.drainStep()).toEqual({
			status: 'blocked',
			attempted: 4,
			delivered: 2,
			blocked: 2,
		})
		expect(value.status()).toMatchObject({
			queued: 0,
			blocked: 2,
			blockedReasons: { conflict: 1, rejected: 1 },
		})
		expect(await value.drainStep()).toMatchObject({ status: 'blocked', attempted: 0 })
	})

	test('treats malformed, missing, unknown, duplicate, and envelope outcomes as unusable', async () => {
		const evidenceId = '46000000-0000-4000-8000-000000000001'
		const unknownId = '46000000-0000-4000-8000-000000000099'
		const bodies = [
			{},
			{ outcomes: [] },
			{ outcomes: [{ evidence_id: unknownId, status: 'accepted' }] },
			{
				outcomes: [
					{ evidence_id: evidenceId, status: 'accepted' },
					{ evidence_id: evidenceId, status: 'duplicate' },
				],
			},
			{ outcomes: [{ scope: 'envelope', status: 'rejected', reason: 'invalid_envelope' }] },
			{ outcomes: [{ evidence_id: evidenceId, status: 'accepted', extra: true }] },
		]
		for (const body of bodies) {
			const value = client(path(), { fetch: scriptedFetch(() => json(body)) })
			value.enqueue(envelope([engagement(evidenceId)]))
			expect(await value.drainStep()).toMatchObject({ status: 'retryable', attempted: 1 })
			expect(value.status()).toMatchObject({ queued: 1, blocked: 0 })
		}
	})

	test('makes unsupported, invalid, and binding-conflicted negotiation visibly blocked', async () => {
		const cases = [
			{
				response: json({
					protocol: LOCAL_PROTOCOL,
					unsupported_versions: true,
					supported_versions: [LOCAL_PROTOCOL_VERSION],
				}),
				reason: 'unsupported',
			},
			{ response: json({ error: 'invalid_request' }, 400), reason: 'transportRejected' },
			{
				response: json({ error: 'collector_binding_conflict' }, 409),
				reason: 'bindingConflict',
			},
		] as const
		for (const [index, item] of cases.entries()) {
			let calls = 0
			const value = client(path(), {
				fetch: async () => {
					calls += 1
					return item.response.clone()
				},
			})
			value.enqueue(
				envelope([engagement(`46${index + 1}00000-0000-4000-8000-000000000001`)]),
			)
			expect(await value.drainStep()).toMatchObject({ status: 'blocked' })
			expect(calls).toBe(1)
			expect(value.status().blockedReasons[item.reason]).toBe(1)
			expect(await value.drainStep()).toMatchObject({ status: 'blocked', attempted: 0 })
			expect(calls).toBe(1)
		}
	})

	test('retries malformed unsupported-version responses instead of blocking', async () => {
		for (const [index, supported_versions] of [[], [2], [1, 1], [1, 2]].entries()) {
			const value = client(path(), {
				fetch: async () =>
					json({
						protocol: LOCAL_PROTOCOL,
						unsupported_versions: true,
						supported_versions,
					}),
			})
			value.enqueue(
				envelope([engagement(`46${index + 4}00000-0000-4000-8000-000000000001`)]),
			)
			expect(await value.drainStep()).toMatchObject({ status: 'retryable' })
			expect(value.status()).toMatchObject({ queued: 1, blocked: 0 })
		}
	})

	test('rejects invalid/prohibited/unsupported envelopes before any spool write', () => {
		const spoolPath = path()
		const value = client(spoolPath)
		const base = engagement('47000000-0000-4000-8000-000000000001')
		const invalid = [
			{ ...envelope([base]), surprise: true },
			envelope([{ ...base, prompt: 'private prompt' }]),
			{ ...envelope([base]), protocol_version: 2 },
			envelope([{ ...base, origin: 'automatic' }]),
		]
		for (const candidate of invalid) {
			expect(value.enqueue(candidate)).toEqual({ status: 'rejected', reason: 'invalid_evidence' })
		}
		expect(count(spoolPath, 'queued_evidence')).toBe(0)
		expect(count(spoolPath, 'delivery_snapshots')).toBe(0)
	})

	test('enforces count and encoded-byte limits atomically without eviction', () => {
		const countPath = path()
		const byCount = client(countPath, { maxQueuedRecords: 2 })
		const first = engagement('48000000-0000-4000-8000-000000000001')
		expect(byCount.enqueue(envelope([first]))).toMatchObject({ status: 'queued' })
		expect(
			byCount.enqueue(
				envelope([
					engagement('48000000-0000-4000-8000-000000000002'),
					engagement('48000000-0000-4000-8000-000000000003'),
				]),
			),
		).toEqual({ status: 'spool_full' })
		expect(count(countPath, 'queued_evidence')).toBe(1)

		const bytesPath = path()
		const payloadBytes = Buffer.byteLength(JSON.stringify(first))
		const byBytes = client(bytesPath, { maxQueuedBytes: payloadBytes })
		expect(byBytes.enqueue(envelope([first]))).toMatchObject({ status: 'queued' })
		expect(
			byBytes.enqueue(envelope([engagement('48000000-0000-4000-8000-000000000004')])),
		).toEqual({ status: 'spool_full' })
		expect(count(bytesPath, 'queued_evidence')).toBe(1)
	})

	test('idempotently enqueues exact replay but conflicts changed identity reuse atomically across restart', () => {
		const spoolPath = path()
		const evidenceId = '48100000-0000-4000-8000-000000000001'
		const first = engagement(evidenceId)
		let value = client(spoolPath, { maxQueuedRecords: 2 })
		expect(value.enqueue(envelope([first]))).toEqual({ status: 'queued', records: 1 })
		const initial = value.status()
		value.close()
		clients.splice(clients.indexOf(value), 1)

		value = client(spoolPath, { maxQueuedRecords: 2 })
		expect(value.enqueue(envelope([first, first]))).toEqual({ status: 'queued', records: 0 })
		expect(value.status()).toEqual(initial)
		const second = engagement('48100000-0000-4000-8000-000000000002')
		expect(value.enqueue(envelope([first, second]))).toEqual({ status: 'queued', records: 1 })
		expect(count(spoolPath, 'queued_evidence')).toBe(2)

		const third = engagement('48100000-0000-4000-8000-000000000003')
		const changedRecord = {
			...first,
			timing: { ...first.timing, wall_time: '2026-09-10T02:00:01.000Z' },
		}
		expect(value.enqueue(envelope([third, changedRecord]))).toEqual({ status: 'conflict' })
		expect(
			value.enqueue(
				envelope([first], ['engagement.submission', 'engagement.approval']),
			),
		).toEqual({ status: 'conflict' })
		expect(
			value.enqueue(envelope([first], ['engagement.submission'], '20000000-0000-4000-8000-000000000002')),
		).toEqual({ status: 'conflict' })
		expect(count(spoolPath, 'queued_evidence')).toBe(2)
	})

	test('accepts the exact batch-byte boundary and validates only delivery-eligible rows on reopen', async () => {
		const record = engagement('48200000-0000-4000-8000-000000000001')
		const completeEnvelopeBytes = Buffer.byteLength(JSON.stringify(envelope([record])))
		const exactPath = path()
		const exact = client(exactPath, { maxBatchBytes: completeEnvelopeBytes })
		expect(exact.enqueue(envelope([record]))).toEqual({ status: 'queued', records: 1 })
		exact.close()
		clients.splice(clients.indexOf(exact), 1)

		const lower = client(path(), { maxBatchBytes: completeEnvelopeBytes - 1 })
		expect(lower.enqueue(envelope([record]))).toEqual({
			status: 'rejected',
			reason: 'batch_too_large',
		})
		expect(lower.status()).toMatchObject({ queued: 0, blocked: 0, payloadBytes: 0 })
		expect(() => client(exactPath, { maxBatchBytes: completeEnvelopeBytes - 1 })).toThrow(
			'Evidence client batch limit cannot deliver queued evidence',
		)

		const blockedPath = path()
		const blockedId = '48200000-0000-4000-8000-000000000002'
		let blocked = client(blockedPath, {
			maxBatchBytes: completeEnvelopeBytes,
			fetch: scriptedFetch(() =>
				json({
					outcomes: [
						{ evidence_id: blockedId, status: 'conflict', reason: 'identity_conflict' },
					],
				}),
			),
		})
		expect(blocked.enqueue(envelope([engagement(blockedId)]))).toMatchObject({ status: 'queued' })
		expect(await blocked.drainStep()).toMatchObject({ status: 'blocked' })
		blocked.close()
		clients.splice(clients.indexOf(blocked), 1)
		blocked = client(blockedPath, { maxBatchBytes: completeEnvelopeBytes - 1 })
		expect(blocked.status()).toMatchObject({
			queued: 0,
			blocked: 1,
			blockedReasons: { conflict: 1 },
		})
		expect(await blocked.drainStep()).toMatchObject({ status: 'blocked', attempted: 0 })
	})

	test('reports fixed tracking failures and rolls back enqueue and delivery mutations', async () => {
		const enqueuePath = path()
		const enqueueClient = client(enqueuePath)
		let database = new Database(enqueuePath, { strict: true })
		database.exec(`CREATE TRIGGER fail_enqueue BEFORE INSERT ON queued_evidence
			BEGIN SELECT RAISE(FAIL, 'private enqueue diagnostic'); END`)
		database.close()
		expect(
			enqueueClient.enqueue(envelope([engagement('49000000-0000-4000-8000-000000000001')])),
		).toEqual({ status: 'tracking_failed' })
		expect(count(enqueuePath, 'queued_evidence')).toBe(0)
		expect(count(enqueuePath, 'delivery_snapshots')).toBe(0)

		const deliveryPath = path()
		const deliveryClient = client(deliveryPath, { fetch: scriptedFetch(accepted) })
		deliveryClient.enqueue(
			envelope([
				engagement('49000000-0000-4000-8000-000000000002'),
				engagement('49000000-0000-4000-8000-000000000003'),
			]),
		)
		database = new Database(deliveryPath, { strict: true })
		database.exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON queued_evidence
			BEGIN SELECT RAISE(FAIL, 'private delete diagnostic'); END`)
		database.close()
		expect(await deliveryClient.drainStep()).toMatchObject({ status: 'tracking_failed', delivered: 0 })
		expect(count(deliveryPath, 'queued_evidence')).toBe(2)

		const updatePath = path()
		const updateId = '49000000-0000-4000-8000-000000000004'
		const updateClient = client(updatePath, {
			fetch: scriptedFetch(() =>
				json({
					outcomes: [
						{ evidence_id: updateId, status: 'conflict', reason: 'identity_conflict' },
					],
				}),
			),
		})
		updateClient.enqueue(envelope([engagement(updateId)]))
		database = new Database(updatePath, { strict: true })
		database.exec(`CREATE TRIGGER fail_update BEFORE UPDATE ON queued_evidence
			BEGIN SELECT RAISE(FAIL, 'private update diagnostic'); END`)
		database.close()
		expect(await updateClient.drainStep()).toMatchObject({ status: 'tracking_failed', blocked: 0 })
		expect(updateClient.status()).toMatchObject({ queued: 1, blocked: 0 })
	})

	test('preserves blocked state and exact byte accounting across close/reopen', async () => {
		const spoolPath = path()
		const evidenceId = '4a000000-0000-4000-8000-000000000001'
		let value = client(spoolPath, {
			fetch: scriptedFetch(() =>
				json({ outcomes: [{ evidence_id: evidenceId, status: 'rejected', reason: 'invalid_order' }] }),
			),
		})
		value.enqueue(envelope([engagement(evidenceId)]))
		const bytes = value.status().payloadBytes
		expect(await value.drainStep()).toMatchObject({ status: 'blocked' })
		value.close()
		clients.splice(clients.indexOf(value), 1)
		value = client(spoolPath)
		expect(value.status()).toMatchObject({
			queued: 0,
			blocked: 1,
			payloadBytes: bytes,
			blockedReasons: { rejected: 1 },
		})
		expect(await value.drainStep()).toMatchObject({ status: 'blocked', attempted: 0 })
	})

	test('matches private SQLite path, file, permission, and future-schema protections', () => {
		const existingParent = mkdtempSync(join(tmpdir(), 'cukup-client-permission-'))
		directories.push(existingParent)
		chmodSync(existingParent, 0o750)
		const spoolPath = join(existingParent, 'spool.sqlite')
		const value = client(spoolPath)
		value.close()
		clients.splice(clients.indexOf(value), 1)
		expect(statSync(existingParent).mode & 0o777).toBe(0o750)
		expect(statSync(spoolPath).mode & 0o777).toBe(0o600)

		for (const invalidPath of ['', ':memory:', `${spoolPath} `]) {
			expect(() => client(invalidPath)).toThrow('exact durable file path')
		}
		expect(() => client(existingParent)).toThrow('regular file')
		expect(statSync(existingParent).mode & 0o777).toBe(0o750)

		const futurePath = path()
		const database = new Database(futurePath, { create: true, strict: true })
		database.exec('PRAGMA journal_mode = DELETE')
		database.exec('PRAGMA user_version = 2')
		database.close()
		expect(() => client(futurePath)).toThrow('Evidence spool schema version 2 is newer')
		const unchanged = new Database(futurePath, { readonly: true, strict: true })
		expect(
			unchanged.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version,
		).toBe(2)
		expect(
			unchanged.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()!.journal_mode,
		).toBe('delete')
		unchanged.close()
	})

	test('rejects non-exact origins and exposes only privacy-safe status and fixed errors', async () => {
		const spoolPath = path()
		for (const origin of [
			'https://127.0.0.1:1234',
			'http://localhost:1234',
			'http://[::1]:1234',
			'http://user@127.0.0.1:1234',
			'http://127.0.0.1:1234/',
			'http://127.0.0.1:1234/path',
			'http://127.0.0.1:1234?token=x',
			'http://127.0.0.1:1234#x',
		]) {
			expect(() => client(spoolPath, { origin })).toThrow('exact IPv4 loopback HTTP origin')
		}
		const sensitive = {
			token: 'synthetic-token-marker',
			id: '4b000000-0000-4000-8000-000000000001',
			project: PROJECT,
			path: '/private/synthetic/path',
			prompt: 'private prompt marker',
			timestamp: '2026-09-10T02:00:00.000Z',
		}
		const value = client(spoolPath, {
			tokenProvider: () => sensitive.token,
		})
		expect(value.enqueue(envelope([{ ...engagement(sensitive.id), prompt: sensitive.prompt }]))).toEqual({
			status: 'rejected',
			reason: 'invalid_evidence',
		})
		value.enqueue(envelope([engagement(sensitive.id)]))
		expect(await value.drainStep()).toEqual({
			status: 'retryable',
			attempted: 0,
			delivered: 0,
			blocked: 0,
		})
		const exposed = JSON.stringify([value.status(), await value.drainStep()])
		for (const secret of Object.values(sensitive)) expect(exposed).not.toContain(secret)

		const database = new Database(spoolPath, { readonly: true, strict: true })
		const columns = ['delivery_snapshots', 'queued_evidence'].flatMap((table) =>
			database
				.query<{ name: string }, [string]>('SELECT name FROM pragma_table_info(?)')
				.all(table)
				.map(({ name }) => name),
		)
		database.close()
		for (const prohibited of ['token', 'origin', 'endpoint', 'native', 'path', 'prompt', 'output', 'metadata']) {
			expect(columns.some((column) => column.includes(prohibited))).toBeFalse()
		}
	})
})
