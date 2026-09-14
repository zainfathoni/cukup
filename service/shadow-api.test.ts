import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { CAPABILITIES, LOCAL_PROTOCOL, type Evidence } from './harness-evidence-protocol.ts'
import { ServiceLogger } from './logger.ts'
import { ServiceStore } from './store.ts'

const now = Date.parse('2026-09-14T12:00:00.000Z')
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const directories: string[] = []
const stores: ServiceStore[] = []

afterEach(() => {
	for (const store of stores.splice(0)) store.close()
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function evidence(n = 1): Evidence {
	return {
		family: 'engagement',
		evidence_id: uuid(n),
		recovered: false,
		timing: {
			wall_time: new Date(now - 1_000).toISOString(),
			provenance: 'native_occurrence',
			precision_ms: 1,
		},
		origin: 'human',
		interaction: 'submission',
		project_attribution: { kind: 'unassigned', reason: 'absent' },
	}
}

function body(sequence = 1, collector = uuid(70), fact: unknown = evidence()) {
	return {
		source_sequence: sequence,
		envelope: {
			protocol: LOCAL_PROTOCOL,
			protocol_version: 1,
			collector_instance_id: collector,
			capabilities: [...CAPABILITIES],
			evidence: [fact],
		},
	}
}

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), 'cukup-shadow-api-'))
	directories.push(directory)
	const store = new ServiceStore(join(directory, 'service.sqlite'))
	stores.push(store)
	const logs: string[] = []
	const app = createApp({
		store,
		oidcVerifier: { verify: async (token) => token === 'header.payload.signature' },
		now: () => now,
		fleetHostnames: new Set(['machine-a', 'machine-b']),
		logger: new ServiceLogger((line) => logs.push(line)),
	})
	const first = store.issueBearer(now)
	const second = store.issueBearer(now + 1)
	return { store, app, logs, first, second, path: join(directory, 'service.sqlite') }
}

function request(
	value: ReturnType<typeof fixture>,
	token: string,
	payload: unknown,
	path = '/v1/shadow-evidence',
): Promise<Response> {
	return value.app.fetch(new Request(`https://api.cukup.dev${path}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: typeof payload === 'string' ? payload : JSON.stringify(payload),
	}))
}

describe('authenticated cloud shadow ingestion', () => {
	test('derives an opaque site from the bound bearer and preserves it across rotation and retry', async () => {
		const value = fixture()
		expect(value.store.bindExecutorLabel(value.first.tokenId, 'machine-a').outcome).toBe('bound')
		const first = await request(value, value.first.token, body(3))
		expect(first.status).toBe(200)
		expect(await first.json()).toEqual({ status: 'accepted' })

		const [stored] = value.store.shadow.records()
		expect(stored?.executionSiteId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		)
		expect(stored?.executionSiteId).not.toBe('machine-a')
		const site = stored!.executionSiteId
		expect(value.store.bindExecutorLabel(value.first.tokenId, 'machine-a').outcome).toBe('bound')
		expect(value.store.shadowExecutionSite(value.first.tokenId)).toBe(site)
		expect(Object.keys(value.store.listBearerMetadata()[0]!).sort()).toEqual([
			'createdAt', 'executorLabel', 'replacedBy', 'revokedAt', 'tokenId',
		])
		const replacement = value.store.rotateBearer(value.first.tokenId, now + 2)
		expect(await (await request(value, replacement.token, body(3))).json()).toEqual({
			status: 'duplicate',
		})
		expect(value.store.shadow.records()[0]?.executionSiteId).toBe(site)
		expect(await (await request(value, replacement.token, body(4, uuid(70), evidence(2)))).json()).toEqual({
			status: 'accepted',
		})
		const old = await request(value, value.first.token, body(5, uuid(70), evidence(3)))
		expect(old.status).toBe(401)
		expect(await old.json()).toEqual({ error: 'unauthorized' })
	})

	test('refuses unbound bearers and workload OIDC without mutating either evidence generation', async () => {
		const value = fixture()
		const metadata = value.store.listBearerMetadata()
		for (const [token, expected] of [
			[value.first.token, { error: 'executor_profile_required' }],
			['header.payload.signature', { error: 'physical_bearer_required' }],
		] as const) {
			const response = await request(value, token, body())
			expect(response.status).toBe(403)
			expect(await response.json()).toEqual(expected)
		}
		expect(value.store.listBearerMetadata()).toEqual(metadata)
		expect(value.store.shadow.records()).toEqual([])
		expect(value.store.events()).toEqual([])
	})

	test('rejects a collector claimed by another bearer lineage and keeps legacy storage isolated', async () => {
		const value = fixture()
		value.store.bindExecutorLabel(value.first.tokenId, 'machine-a')
		value.store.bindExecutorLabel(value.second.tokenId, 'machine-b')
		const legacy = {
			schemaVersion: 1 as const,
			eventId: '01990b2e-1c00-7000-8000-000000000001',
			sourceInstance: uuid(91),
			sourceSequence: 1,
			sessionId: uuid(92),
			kind: 'agent.start' as const,
			occurredAt: new Date(now - 2_000).toISOString(),
			occurredAtMs: now - 2_000,
		}
		value.store.ingest(value.store.authenticateBearer(value.first.token)!, legacy, now)
		const before = value.store.events()
		expect(await (await request(value, value.first.token, body(1))).json()).toEqual({ status: 'accepted' })
		expect(await (await request(value, value.second.token, body(2, uuid(70), evidence(2)))).json()).toEqual({
			status: 'rejected',
			reason: 'identity_conflict',
		})
		expect(value.store.shadow.records()).toHaveLength(1)
		expect(value.store.events()).toEqual(before)

		value.store.revokeBearer(value.first.tokenId, now + 2)
		const reused = value.store.issueBearer(now + 3)
		value.store.bindExecutorLabel(reused.tokenId, 'machine-a')
		expect(await (await request(value, reused.token, body(1, uuid(71), evidence(3)))).json()).toEqual({
			status: 'accepted',
		})
		const sites = value.store.shadow.records().map((record) => record.executionSiteId)
		expect(new Set(sites).size).toBe(2)
		expect(await (await request(value, reused.token, body(2, uuid(70), evidence(2)))).json()).toEqual({
			status: 'rejected',
			reason: 'identity_conflict',
		})
	})

	test('preserves unsupported, invalid, conflict, and order outcomes in one closed response shape', async () => {
		const value = fixture()
		value.store.bindExecutorLabel(value.first.tokenId, 'machine-a')
		expect(await (await request(value, value.first.token, body(4))).json()).toEqual({ status: 'accepted' })

		const unsupported = body(5, uuid(70), evidence(2))
		unsupported.envelope.protocol_version = 2
		const cases: Array<[unknown, unknown]> = [
			[unsupported, { status: 'rejected', reason: 'unsupported_version' }],
			[body(0, uuid(70), evidence(2)), { status: 'rejected', reason: 'invalid_record' }],
			[body(5, uuid(70), { ...evidence(), recovered: true }), { status: 'rejected', reason: 'identity_conflict' }],
			[body(3, uuid(70), evidence(3)), { status: 'rejected', reason: 'invalid_order' }],
		]
		for (const [payload, expected] of cases) {
			const response = await request(value, value.first.token, payload)
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual(expected)
		}
		expect(value.store.shadow.records()).toHaveLength(1)
	})

	test('rejects caller attribution and metadata fields before storage without reflecting values', async () => {
		const value = fixture()
		value.store.bindExecutorLabel(value.first.tokenId, 'machine-a')
		for (const field of [
			'execution_site_id',
			'hostname',
			'executor_label',
			'source_instance_id',
			'source_owner',
			'metadata',
		]) {
			const response = await request(value, value.first.token, { ...body(), [field]: `private-${field}` })
			expect(await response.json()).toEqual({ status: 'rejected', reason: 'invalid_record' })
		}
		const malformed = await request(value, value.first.token, '{')
		expect(malformed.status).toBe(400)
		expect(await malformed.json()).toEqual({ error: 'invalid_request' })
		expect(value.store.shadow.records()).toEqual([])
		expect(value.logs.join('\n')).not.toContain('private-')
		expect(value.logs.every((line) => line.includes('"path":"/v1/shadow-evidence"'))).toBeTrue()
	})

	test('uses existing secure API host, authentication, method, media, and route-hiding boundaries', async () => {
		const value = fixture()
		value.store.bindExecutorLabel(value.first.tokenId, 'machine-a')
		const missing = await value.app.fetch(new Request('https://api.cukup.dev/v1/shadow-evidence'))
		expect(missing.status).toBe(401)
		const wrongHost = await value.app.fetch(new Request('https://cukup.dev/v1/shadow-evidence', {
			headers: { authorization: `Bearer ${value.first.token}` },
		}))
		expect(wrongHost.status).toBe(404)
		const insecure = await value.app.fetch(new Request('http://api.cukup.dev/v1/shadow-evidence', {
			headers: { authorization: `Bearer ${value.first.token}` },
		}))
		expect(insecure.status).toBe(400)
		const method = await value.app.fetch(new Request('https://api.cukup.dev/v1/shadow-evidence', {
			method: 'PUT',
			headers: { authorization: `Bearer ${value.first.token}` },
		}))
		expect(method.status).toBe(405)
		expect(method.headers.get('allow')).toBe('POST')
		const media = await value.app.fetch(new Request('https://api.cukup.dev/v1/shadow-evidence', {
			method: 'POST',
			headers: { authorization: `Bearer ${value.first.token}` },
			body: JSON.stringify(body()),
		}))
		expect(media.status).toBe(415)
		expect(value.store.shadow.records()).toEqual([])
	})

	test('normalizes append failures without leaking diagnostics, identifiers, or a site', async () => {
		const value = fixture()
		value.store.bindExecutorLabel(value.first.tokenId, 'machine-a')
		const raw = new Database(value.path)
		raw.exec(`CREATE TRIGGER fail_shadow_api BEFORE INSERT ON shadow_evidence
			BEGIN SELECT RAISE(ABORT, 'private injected shadow failure'); END`)
		const response = await request(value, value.first.token, body())
		expect(response.status).toBe(500)
		expect(await response.json()).toEqual({ error: 'internal_error' })
		expect(value.store.shadow.records()).toEqual([])
		const output = value.logs.join('\n')
		for (const prohibited of ['private injected shadow failure', uuid(70), uuid(1), 'machine-a']) {
			expect(output).not.toContain(prohibited)
		}
		raw.close()
	})
})
