import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { LOCAL_PROTOCOL } from './harness-evidence-protocol.ts'
import { ServiceLogger } from './logger.ts'
import { MAX_REQUEST_BYTES } from './protocol.ts'
import { ServiceStore } from './store.ts'

const NOW = Date.parse('2026-09-14T12:00:00.000Z')
const uuid = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const roots: string[] = []
const stores: ServiceStore[] = []

afterEach(() => {
	for (const store of stores.splice(0)) store.close()
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'cukup-coverage-api-'))
	roots.push(root)
	const path = join(root, 'service.sqlite')
	const store = new ServiceStore(path)
	stores.push(store)
	const logs: string[] = []
	const app = createApp({ store, now: () => NOW, fleetHostnames: new Set(['physical-a', 'physical-b']),
		oidcVerifier: { verify: async (token) => token === 'oidc.token.value' },
		logger: new ServiceLogger((line) => logs.push(line)) })
	const first = store.issueBearer(NOW)
	const second = store.issueBearer(NOW + 1)
	return { app, store, path, logs, first, second }
}

function body(fact: unknown, sequence = 1, collector = uuid(70), capabilities = ['execution.segments']) {
	return { source_sequence: sequence, envelope: { protocol: LOCAL_PROTOCOL, protocol_version: 1,
		collector_instance_id: collector, capabilities, fact } }
}

function declaration(n = 1, offset = 0) {
	return { family: 'capability_declaration', fact_id: uuid(n), effective_at: new Date(NOW + offset).toISOString() }
}

function loss(n = 2) {
	return { family: 'irreversible_loss', fact_id: uuid(n), start: new Date(NOW - 2_000).toISOString(),
		end: new Date(NOW - 1_000).toISOString(), reason: 'source_without_replay' }
}

function send(f: ReturnType<typeof fixture>, token: string, payload: BodyInit | unknown, suffix = '') {
	return f.app.fetch(new Request(`https://api.cukup.dev/v1/shadow-coverage${suffix}`, {
		method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: (typeof payload === 'string' || payload instanceof Uint8Array ? payload : JSON.stringify(payload)) as BodyInit,
	}))
}

test('physical coverage route shares collector site and source order with evidence and preserves exact retry receipt', async () => {
	const f = fixture()
	f.store.bindExecutorLabel(f.first.tokenId, 'physical-a')
	expect(await (await send(f, f.first.token, body(declaration(), 4))).json()).toEqual({ status: 'accepted' })
	const evidence = { executionSiteId: f.store.shadowExecutionSite(f.first.tokenId), sourceSequence: 6, envelope: {
		protocol: LOCAL_PROTOCOL, protocol_version: 1, collector_instance_id: uuid(70),
		capabilities: ['engagement.submission'], evidence: [{ family: 'engagement', evidence_id: uuid(20),
			interaction: 'submission', origin: 'human', recovered: false,
			timing: { wall_time: new Date(NOW - 500).toISOString(), provenance: 'native_occurrence', precision_ms: 1 },
			project_attribution: { kind: 'unassigned', reason: 'absent' } }],
	} }
	expect(f.store.shadow.append(evidence, NOW).status).toBe('accepted')
	expect(await (await send(f, f.first.token, body(loss(), 8))).json()).toEqual({ status: 'accepted' })
	const before = f.store.shadow.coverageRecords()
	expect(await (await send(f, f.first.token, body(loss(), 8))).json()).toEqual({ status: 'duplicate' })
	expect(f.store.shadow.coverageRecords()).toEqual(before)
	expect(before.map((row) => [row.sourceSequence, row.receivedAtMs])).toEqual([[4, NOW], [8, NOW]])
	expect(await (await send(f, f.first.token, body(declaration(3), 7))).json()).toEqual({
		status: 'rejected', reason: 'invalid_order',
	})
	expect(before.every((row) => row.executionSiteId === evidence.executionSiteId)).toBeTrue()
})

test('authentication-derived profile/site checks precede body parsing and OIDC remains unsupported', async () => {
	const f = fixture()
	f.store.bindExecutorLabel(f.first.tokenId, 'physical-a')
	f.store.bindExecutorLabel(f.second.tokenId, 'physical-b')
	expect(await (await send(f, f.first.token, body(declaration()))).json()).toEqual({ status: 'accepted' })
	for (const [token, expected] of [
		['oidc.token.value', { error: 'physical_bearer_required' }],
		[f.store.issueBearer().token, { error: 'executor_profile_required' }],
	] as const) expect(await (await send(f, token, '{')).json()).toEqual(expected)
	expect(await (await send(f, f.second.token, body(declaration(2), 2))).json()).toEqual({
		status: 'rejected', reason: 'identity_conflict',
	})
	expect(f.store.shadow.coverageRecords()).toHaveLength(1)
})

test('revocation or rotation committed during body read fences new and duplicate coverage writes', async () => {
	for (const duplicate of [false, true]) for (const operation of ['revoke', 'rotate'] as const) {
		const f = fixture()
		f.store.bindExecutorLabel(f.first.tokenId, 'physical-a')
		const payload = body(declaration())
		if (duplicate) expect(await (await send(f, f.first.token, payload)).json()).toEqual({ status: 'accepted' })
		const before = f.store.shadow.coverageRecords()
		let controller!: ReadableStreamDefaultController<Uint8Array>
		const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
		const pending = f.app.fetch(new Request('https://api.cukup.dev/v1/shadow-coverage', {
			method: 'POST', headers: { authorization: `Bearer ${f.first.token}`, 'content-type': 'application/json' },
			body: stream as unknown as BodyInit,
		}))
		await Bun.sleep(5)
		if (operation === 'revoke') f.store.revokeBearer(f.first.tokenId, NOW + 2)
		else f.store.rotateBearer(f.first.tokenId, NOW + 2)
		controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)))
		controller.close()
		const response = await pending
		expect(response.status).toBe(401)
		expect(response.headers.get('www-authenticate')).toBe('Bearer')
		expect(await response.json()).toEqual({ error: 'unauthorized' })
		expect(f.store.shadow.coverageRecords()).toEqual(before)
	}
})

test('strict framing bounds bytes and rejects invalid UTF-8, duplicate keys, encoding and private fields without logging payloads', async () => {
	const f = fixture()
	f.store.bindExecutorLabel(f.first.tokenId, 'physical-a')
	for (const payload of [
		'{"source_sequence":1,"source_sequence":2,"envelope":{}}',
		new Uint8Array([123, 34, 120, 34, 58, 255, 125]),
	]) {
		const response = await send(f, f.first.token, payload)
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ error: 'invalid_request' })
	}
	const encoded = await f.app.fetch(new Request('https://api.cukup.dev/v1/shadow-coverage', {
		method: 'POST', headers: { authorization: `Bearer ${f.first.token}`, 'content-type': 'application/json',
			'content-encoding': 'identity' }, body: '{}',
	}))
	expect(encoded.status).toBe(415)
	const oversized = await send(f, f.first.token, '"' + 'é'.repeat(MAX_REQUEST_BYTES / 2 + 1) + '"')
	expect(oversized.status).toBe(413)
	const privateValue = 'private-prompt-sentinel'
	expect(await (await send(f, f.first.token, body({ ...declaration(), prompt: privateValue }))).json()).toEqual({
		status: 'rejected', reason: 'invalid_record',
	})
	expect(f.store.shadow.coverageRecords()).toEqual([])
	expect(f.logs.join('')).not.toContain(privateValue)
	expect(f.logs.every((line) => JSON.parse(line).path === '/v1/shadow-coverage')).toBeTrue()
})

test('database failure cannot acknowledge or expose coverage content and legacy rows remain unchanged', async () => {
	const f = fixture()
	f.store.bindExecutorLabel(f.first.tokenId, 'physical-a')
	const principal = f.store.authenticateBearer(f.first.token)!
	const legacy = { schemaVersion: 1 as const, eventId: '01990b2e-1c00-7000-8000-000000000001',
		sourceInstance: uuid(80), sourceSequence: 1, sessionId: uuid(81), kind: 'agent.start' as const,
		occurredAt: new Date(NOW - 1_000).toISOString(), occurredAtMs: NOW - 1_000 }
	f.store.ingest(principal, legacy, NOW)
	const before = f.store.events()
	const raw = new Database(f.path)
	raw.exec(`CREATE TRIGGER fail_coverage_api BEFORE INSERT ON shadow_coverage
		BEGIN SELECT RAISE(ABORT, 'private coverage database sentinel'); END`)
	const response = await send(f, f.first.token, body(declaration()))
	expect(response.status).toBe(500)
	expect(await response.json()).toEqual({ error: 'internal_error' })
	expect(f.store.shadow.coverageRecords()).toEqual([])
	expect(f.store.events()).toEqual(before)
	expect(f.logs.join('')).not.toContain('private coverage database sentinel')
	raw.close()
})
