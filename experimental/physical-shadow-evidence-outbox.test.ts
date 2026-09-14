import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkHoursStore } from '../plugin/store.ts'
import { createApp } from '../service/app.ts'
import { ServiceLogger } from '../service/logger.ts'
import { ServiceStore } from '../service/store.ts'
import {
	PhysicalShadowEvidenceOutbox,
	type PhysicalShadowEvidenceOutboxOptions,
} from './physical-shadow-evidence-outbox.ts'

const NOW = Date.parse('2026-09-14T12:00:00.000Z')
const COLLECTOR = '50000000-0000-4000-8000-000000000001'
const PROJECT = '60000000-0000-4000-8000-000000000001'
const TOKEN = 'cukup_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HOSTNAME = 'physical-a'
const FACT = '80000000-0000-4000-8000-000000000001'
const directories: string[] = []
const outboxes: PhysicalShadowEvidenceOutbox[] = []
const serviceStores: ServiceStore[] = []

afterEach(() => {
	for (const outbox of outboxes.splice(0)) outbox.close()
	for (const store of serviceStores.splice(0)) store.close()
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function directory(): string {
	const value = mkdtempSync(join(tmpdir(), 'cukup-physical-shadow-'))
	directories.push(value)
	return value
}

function engagement(n: number, extra: Record<string, unknown> = {}) {
	return {
		family: 'engagement',
		evidence_id: `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
		interaction: 'submission',
		origin: 'human',
		recovered: false,
		timing: {
			wall_time: '2026-09-14T11:59:00.000Z',
			provenance: 'native_occurrence',
			precision_ms: 1,
		},
		project_attribution: { kind: 'cukup_project', project_id: PROJECT, basis: 'approved_mapping' },
		...extra,
	}
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status })
}

function scriptedFetch(
	shadow: (body: Record<string, unknown>) => Response = () => json({ status: 'accepted' }),
	requests: Array<{ url: string; init: RequestInit }> = [],
) {
	return async (url: string, init: RequestInit): Promise<Response> => {
		requests.push({ url, init })
		if (url.endsWith('/v1/executor-profile')) return json({ executor_label: HOSTNAME })
		return shadow(JSON.parse(String(init.body)) as Record<string, unknown>)
	}
}

function outbox(
	spoolPath: string,
	overrides: Partial<PhysicalShadowEvidenceOutboxOptions> = {},
): PhysicalShadowEvidenceOutbox {
	const value = new PhysicalShadowEvidenceOutbox({
		serviceURL: 'https://api.cukup.dev',
		tokenProvider: { getToken: async () => TOKEN },
		executorHostname: HOSTNAME,
		capabilities: ['engagement.submission', 'recovery.engagement.submission'],
		spoolPath,
		fetch: scriptedFetch(),
		now: () => NOW,
		randomId: () => COLLECTOR,
		...overrides,
	})
	outboxes.push(value)
	return value
}

function rows(spoolPath: string): Array<{
	sequence: number
	evidenceId: string
	envelopeJson: string
	state: string
	reason: string | null
	retryAttempt: number
	retryAtMs: number
}> {
	const database = new Database(spoolPath, { readonly: true, strict: true })
	try {
		return database.query<{
			sequence: number
			evidenceId: string
			envelopeJson: string
			state: string
			reason: string | null
			retryAttempt: number
			retryAtMs: number
		}, []>(
			`SELECT source_sequence AS sequence, evidence_id AS evidenceId,
				envelope_json AS envelopeJson, state, blocked_reason AS reason,
				retry_attempt AS retryAttempt, retry_at_ms AS retryAtMs
			 FROM physical_shadow_outbox ORDER BY source_sequence`,
		).all()
	} finally {
		database.close()
	}
}

function collectorId(spoolPath: string): string {
	const database = new Database(spoolPath, { readonly: true, strict: true })
	try {
		return database.query<{ value: string }, []>(
			`SELECT value FROM physical_shadow_settings WHERE key = 'collector_id'`,
		).get()!.value
	} finally {
		database.close()
	}
}

function childOwnershipExitCode(spoolPath: string): number {
	const modulePath = new URL('./physical-shadow-evidence-outbox.ts', import.meta.url).pathname
	const script = `
		import { PhysicalShadowEvidenceOutbox } from ${JSON.stringify(modulePath)}
		try {
			const value = new PhysicalShadowEvidenceOutbox({
				serviceURL: 'https://api.cukup.dev',
				tokenProvider: { getToken: async () => ${JSON.stringify(TOKEN)} },
				executorHostname: ${JSON.stringify(HOSTNAME)},
				capabilities: ['engagement.submission'],
				spoolPath: ${JSON.stringify(spoolPath)},
				randomId: () => ${JSON.stringify(COLLECTOR)},
			})
			value.close()
			process.exit(0)
		} catch { process.exit(2) }
	`
	return Bun.spawnSync([process.execPath, '-e', script], {
		stdout: 'ignore',
		stderr: 'ignore',
	}).exitCode
}

describe('physical cloud shadow evidence outbox', () => {
	test('assigns identity and sequence durably before any network call, then replays the exact Stage 5B wire shape', async () => {
		const spoolPath = join(directory(), 'state', 'shadow.sqlite')
		const requests: Array<{ url: string; init: RequestInit }> = []
		let networkCalls = 0
		let value = outbox(spoolPath, {
			fetch: async (...args) => {
				networkCalls += 1
				return scriptedFetch(undefined, requests)(...args)
			},
		})
		expect(value.enqueue(engagement(1))).toEqual({ status: 'queued', records: 1 })
		expect(networkCalls).toBe(0)
		const before = rows(spoolPath)[0]!
		expect(before.sequence).toBe(1)
		expect(JSON.parse(before.envelopeJson)).toMatchObject({ collector_instance_id: COLLECTOR })

		value.close()
		outboxes.splice(outboxes.indexOf(value), 1)
		value = outbox(spoolPath, { randomId: () => 'invalid-if-regenerated', fetch: scriptedFetch(undefined, requests) })
		expect(value.enqueue(engagement(2))).toEqual({ status: 'queued', records: 1 })
		expect(rows(spoolPath).map((row) => row.sequence)).toEqual([1, 2])
		expect(collectorId(spoolPath)).toBe(COLLECTOR)

		expect(await value.drainStep()).toEqual({ status: 'delivered', attempted: 1, delivered: 1 })
		expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
			'/v1/executor-profile',
			'/v1/shadow-evidence',
		])
		const profile = JSON.parse(String(requests[0]!.init.body))
		const body = JSON.parse(String(requests[1]!.init.body))
		expect(profile).toEqual({ hostname: HOSTNAME })
		expect(Object.keys(body).sort()).toEqual(['envelope', 'source_sequence'])
		expect(body).toEqual({ source_sequence: 1, envelope: JSON.parse(before.envelopeJson) })
		expect(new Headers(requests[1]!.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
		expect(await value.drainStep()).toMatchObject({ status: 'delivered' })
		expect(value.enqueue(engagement(6))).toEqual({ status: 'queued', records: 1 })
		expect(rows(spoolPath)[0]?.sequence).toBe(3)
	})

	test('shares one durable FIFO across evidence and coverage without synthesizing loss', async () => {
		const spoolPath = join(directory(), 'shadow.sqlite')
		const requests: Array<{ url: string; init: RequestInit }> = []
		const value = outbox(spoolPath, { fetch: scriptedFetch(undefined, requests) })
		expect(value.enqueue(engagement(1))).toEqual({ status: 'queued', records: 1 })
		expect(value.enqueueCoverage({
			family: 'capability_declaration', fact_id: FACT, effective_at: new Date(NOW).toISOString(),
		})).toEqual({ status: 'queued', records: 1 })
		expect(value.enqueue(engagement(2))).toEqual({ status: 'queued', records: 1 })
		expect(rows(spoolPath).map((row) => row.sequence)).toEqual([1, 2, 3])
		for (let i = 0; i < 3; i++) expect(await value.drainStep()).toMatchObject({ status: 'delivered' })
		expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
			'/v1/executor-profile', '/v1/shadow-evidence',
			'/v1/executor-profile', '/v1/shadow-coverage',
			'/v1/executor-profile', '/v1/shadow-evidence',
		])
		expect(requests.map(({ init }) => JSON.stringify(init.body)).join('')).not.toContain('irreversible_loss')
	})

	test('persists one capability declaration identity and effective instant across delivery and restart', async () => {
		const spoolPath = join(directory(), 'shadow.sqlite')
		const ids = [COLLECTOR, FACT]
		let value = outbox(spoolPath, { randomId: () => ids.shift()!, fetch: scriptedFetch() })
		expect(value.enqueueCapabilityDeclaration()).toEqual({ status: 'queued', records: 1 })
		expect(value.enqueueCapabilityDeclaration()).toEqual({ status: 'queued', records: 0 })
		const exact = rows(spoolPath)[0]!
		expect(JSON.parse(exact.envelopeJson)).toMatchObject({
			collector_instance_id: COLLECTOR,
			capabilities: ['engagement.submission', 'recovery.engagement.submission'],
			fact: { family: 'capability_declaration', fact_id: FACT, effective_at: new Date(NOW).toISOString() },
		})
		expect(await value.drainStep()).toMatchObject({ status: 'delivered' })
		value.close()
		outboxes.splice(outboxes.indexOf(value), 1)
		value = outbox(spoolPath, { randomId: () => { throw new Error('must not regenerate') } })
		expect(value.enqueueCapabilityDeclaration()).toEqual({ status: 'queued', records: 0 })
		expect(rows(spoolPath)).toEqual([])
	})

	test('coverage response loss retries exact identity/content while changed identity content conflicts', async () => {
		const spoolPath = join(directory(), 'shadow.sqlite')
		let now = NOW
		let lose = true
		const bodies: string[] = []
		const value = outbox(spoolPath, {
			now: () => now,
			fetch: async (url, init) => {
				if (url.endsWith('/v1/executor-profile')) return json({ executor_label: HOSTNAME })
				bodies.push(String(init.body))
				if (lose) { lose = false; throw new Error('private response loss') }
				return json({ status: 'duplicate' })
			},
		})
		const fact = { family: 'capability_declaration', fact_id: FACT, effective_at: new Date(NOW).toISOString() }
		expect(value.enqueueCoverage(fact)).toEqual({ status: 'queued', records: 1 })
		expect(value.enqueueCoverage({ ...fact, effective_at: new Date(NOW - 1).toISOString() })).toEqual({ status: 'conflict' })
		const exact = rows(spoolPath)[0]!.envelopeJson
		expect(await value.drainStep()).toMatchObject({ status: 'retryable', attempted: 1 })
		expect(rows(spoolPath)[0]!.envelopeJson).toBe(exact)
		now += 1_000
		expect(await value.drainStep()).toMatchObject({ status: 'delivered', delivered: 1 })
		expect(bodies[0]).toBe(bodies[1])
	})

	test('preserves recovery-only loss scope while refusing that scope for a capability declaration', async () => {
		const requests: Array<{ url: string; init: RequestInit }> = []
		const value = outbox(join(directory(), 'shadow.sqlite'), { fetch: scriptedFetch(undefined, requests) })
		const recoveryOnly = ['recovery.execution_end.native'] as const
		expect(value.enqueueCoverage({
			family: 'capability_declaration', fact_id: FACT, effective_at: new Date(NOW).toISOString(),
		}, recoveryOnly)).toEqual({ status: 'rejected', reason: 'invalid_evidence' })
		expect(value.enqueueCoverage({
			family: 'irreversible_loss', fact_id: FACT,
			start: new Date(NOW - 2_000).toISOString(), end: new Date(NOW - 1_000).toISOString(),
			reason: 'source_without_replay',
		}, recoveryOnly)).toEqual({ status: 'queued', records: 1 })
		expect(await value.drainStep()).toMatchObject({ status: 'delivered' })
		const body = JSON.parse(String(requests[1]!.init.body))
		expect(body.envelope.capabilities).toEqual(recoveryOnly)
	})

	test('survives response loss, bearer rotation, and restart; the cloud duplicate clears the exact record', async () => {
		const root = directory()
		const store = new ServiceStore(join(root, 'service.sqlite'))
		serviceStores.push(store)
		const first = store.issueBearer(NOW)
		let token = first.token
		let loseResponse = true
		let now = NOW
		const app = createApp({
			store,
			oidcVerifier: { verify: async () => false },
			now: () => NOW,
			fleetHostnames: new Set([HOSTNAME]),
			logger: new ServiceLogger(() => {}),
		})
		const fetcher = async (url: string, init: RequestInit) => {
			const response = await app.fetch(new Request(url, init))
			if (url.endsWith('/v1/shadow-evidence') && loseResponse) {
				loseResponse = false
				await response.text()
				throw new Error('synthetic response loss')
			}
			return response
		}
		const spoolPath = join(root, 'shadow.sqlite')
		let value = outbox(spoolPath, {
			tokenProvider: { getToken: async () => token },
			fetch: fetcher,
			now: () => now,
		})
		value.enqueue(engagement(3))
		expect(await value.drainStep()).toMatchObject({ status: 'retryable', attempted: 1 })
		expect(store.shadow.records()).toHaveLength(1)
		const exact = rows(spoolPath)[0]!.envelopeJson

		value.close()
		outboxes.splice(outboxes.indexOf(value), 1)
		const replacement = store.rotateBearer(first.tokenId, NOW + 1)
		token = replacement.token
		now += 1_000
		value = outbox(spoolPath, {
			tokenProvider: { getToken: async () => token },
			fetch: fetcher,
			now: () => now,
			randomId: () => 'must-not-regenerate',
		})
		expect(rows(spoolPath)[0]!.envelopeJson).toBe(exact)
		expect(await value.drainStep()).toEqual({ status: 'delivered', attempted: 1, delivered: 1 })
		expect(value.status()).toMatchObject({ queued: 0, blocked: 0, payloadBytes: 0 })
		expect(store.shadow.records()).toHaveLength(1)
	})

	test('requires the exact immutable profile response and keeps profile failures as durable FIFO blockers', async () => {
		for (const [index, response, reason] of [
			[4, json({ executor_label: HOSTNAME, extra: true }), 'invalidResponse'],
			[5, json({ error: 'executor_profile_conflict' }, 409), 'profile'],
		] as const) {
			const spoolPath = join(directory(), 'shadow.sqlite')
			let calls = 0
			let value = outbox(spoolPath, {
				fetch: async () => {
					calls += 1
					return response.clone()
				},
			})
			value.enqueue(engagement(index))
			expect(await value.drainStep()).toMatchObject({ status: 'blocked', attempted: 0 })
			expect(value.status().blockedReasons[reason]).toBe(1)
			value.close()
			outboxes.splice(outboxes.indexOf(value), 1)
			value = outbox(spoolPath, { fetch: async () => { calls += 1; return json({ status: 'accepted' }) } })
			expect(await value.drainStep()).toMatchObject({ status: 'blocked', attempted: 0 })
			expect(calls).toBe(1)
		}
	})

	test('strictly parses the closed shadow response and permanently retains every terminal Stage 5B outcome', async () => {
		const cases = [
			['invalid_record', 'invalidRecord'],
			['unsupported_version', 'unsupportedVersion'],
			['identity_conflict', 'identityConflict'],
			['invalid_order', 'invalidOrder'],
		] as const
		for (const [index, [reason, aggregate]] of cases.entries()) {
			const spoolPath = join(directory(), 'shadow.sqlite')
			const value = outbox(spoolPath, {
				fetch: scriptedFetch(() => json({ status: 'rejected', reason })),
			})
			value.enqueue(engagement(10 + index))
			expect(await value.drainStep()).toEqual({ status: 'blocked', attempted: 1, delivered: 0 })
			expect(rows(spoolPath)[0]).toMatchObject({ state: 'blocked', reason })
			expect(value.status().blockedReasons[aggregate]).toBe(1)
		}

		for (const [index, body] of [{ status: 'accepted', extra: true }, { status: 'mystery' }].entries()) {
			const value = outbox(join(directory(), 'shadow.sqlite'), {
				fetch: scriptedFetch(() => json(body)),
			})
			value.enqueue(engagement(20 + index))
			expect(await value.drainStep()).toMatchObject({ status: 'blocked', delivered: 0 })
			expect(value.status().blockedReasons.invalidResponse).toBe(1)
		}
	})

	test('does not follow profile or upload redirects and retains them as terminal blockers', async () => {
		for (const redirectAt of ['profile', 'upload'] as const) {
			const requests: RequestInit[] = []
			const value = outbox(join(directory(), 'shadow.sqlite'), {
				fetch: async (url, init) => {
					requests.push(init)
					if (redirectAt === 'upload' && url.endsWith('/v1/executor-profile')) {
						return json({ executor_label: HOSTNAME })
					}
					return new Response(null, {
						status: 307,
						headers: { location: 'http://outside.invalid/capture' },
					})
				},
			})
			value.enqueue(engagement(25 + requests.length))
			expect(await value.drainStep()).toMatchObject({ status: 'blocked' })
			expect(requests).toHaveLength(redirectAt === 'profile' ? 1 : 2)
			expect(requests.every((request) => request.redirect === 'manual')).toBeTrue()
			expect(value.status().blockedReasons[redirectAt === 'profile' ? 'profile' : 'transport']).toBe(1)
		}
	})

	test('classifies terminal HTTP status independently of response body and blocks invalid 200 media', async () => {
		const cases = [
			{
				fetch: async () => new Response('conflict', { status: 409 }),
				reason: 'profile' as const,
			},
			{
				fetch: scriptedFetch(() => new Response(null, { status: 413 })),
				reason: 'transport' as const,
			},
			{
				fetch: scriptedFetch(() => new Response('{"status":"accepted"}', {
					headers: { 'content-type': 'text/plain' },
				})),
				reason: 'invalidResponse' as const,
			},
		]
		for (const [index, item] of cases.entries()) {
			const spoolPath = join(directory(), 'shadow.sqlite')
			let value = outbox(spoolPath, { fetch: item.fetch })
			value.enqueue(engagement(60 + index))
			expect(await value.drainStep()).toMatchObject({ status: 'blocked' })
			expect(value.status().blockedReasons[item.reason]).toBe(1)
			value.close()
			outboxes.splice(outboxes.indexOf(value), 1)
			value = outbox(spoolPath)
			expect(await value.drainStep()).toMatchObject({ status: 'blocked', attempted: 0 })
		}
	})

	test('bounds FIFO capacity and persistent retry backoff without sending later records first', async () => {
		const spoolPath = join(directory(), 'shadow.sqlite')
		let now = NOW
		let calls = 0
		const value = outbox(spoolPath, {
			now: () => now,
			maxQueuedRecords: 2,
			fetch: async () => {
				calls += 1
				return json({ error: 'temporarily_unavailable' }, 503)
			},
		})
		expect(value.enqueue(engagement(30))).toMatchObject({ status: 'queued' })
		expect(value.enqueue(engagement(31))).toMatchObject({ status: 'queued' })
		expect(value.enqueue(engagement(32))).toEqual({ status: 'spool_full' })
		expect(await value.drainStep()).toMatchObject({ status: 'retryable', attempted: 0 })
		expect(calls).toBe(1)
		expect(await value.drainStep()).toMatchObject({ status: 'backoff' })
		expect(calls).toBe(1)
		for (const delay of [1_000, 5_000, 30_000, 300_000, 300_000]) {
			now += delay
			expect(await value.drainStep()).toMatchObject({ status: 'retryable' })
		}
		expect(rows(spoolPath)[0]).toMatchObject({ sequence: 1, retryAttempt: 4 })
		expect(rows(spoolPath)[1]).toMatchObject({ sequence: 2, retryAttempt: 0 })
	})

	test('times out one bounded drain attempt without changing the persisted record', async () => {
		const spoolPath = join(directory(), 'shadow.sqlite')
		const value = outbox(spoolPath, {
			requestTimeoutMs: 5,
			fetch: async (_url, init) => new Promise((_resolve, reject) => {
				init.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')))
			}),
		})
		value.enqueue(engagement(39))
		const exact = rows(spoolPath)[0]!.envelopeJson
		expect(await value.drainStep()).toMatchObject({ status: 'retryable', attempted: 0 })
		expect(rows(spoolPath)[0]).toMatchObject({ envelopeJson: exact, state: 'queued', retryAttempt: 1 })
	})

	test('serializes concurrent drains and refuses a second spool owner', async () => {
		const spoolPath = join(directory(), 'shadow.sqlite')
		let releaseProfile = () => {}
		const profileReady = new Promise<void>((resolve) => {
			releaseProfile = resolve
		})
		let calls = 0
		const value = outbox(spoolPath, {
			fetch: async (url) => {
				calls += 1
				if (url.endsWith('/v1/executor-profile')) {
					await profileReady
					return json({ executor_label: HOSTNAME })
				}
				return json({ status: 'accepted' })
			},
		})
		value.enqueue(engagement(70))
		value.enqueue(engagement(71))
		const first = value.drainStep()
		const concurrent = value.drainStep()
		expect(concurrent).toBe(first)
		await Bun.sleep(1)
		expect(calls).toBe(1)
		expect(() => outbox(spoolPath)).toThrow()
		expect(() => value.close()).toThrow('Physical shadow drain must finish before close')
		expect(childOwnershipExitCode(spoolPath)).toBe(2)
		releaseProfile()
		expect(await first).toEqual({ status: 'delivered', attempted: 1, delivered: 1 })
		expect(await concurrent).toEqual({ status: 'delivered', attempted: 1, delivered: 1 })
		expect(calls).toBe(2)
		expect(rows(spoolPath).map((row) => row.sequence)).toEqual([2])
		value.close()
		outboxes.splice(outboxes.indexOf(value), 1)
		expect(childOwnershipExitCode(spoolPath)).toBe(0)
	})

	test('requires private existing directories and secures owner files while rejecting links', () => {
		const root = directory()
		const existing = join(root, 'existing')
		mkdirSync(existing, { mode: 0o777 })
		chmodSync(existing, 0o777)
		const spoolPath = join(existing, 'shadow.sqlite')
		writeFileSync(spoolPath, '', { mode: 0o666 })
		chmodSync(spoolPath, 0o666)
		expect(() => outbox(spoolPath)).toThrow()
		expect(statSync(existing).mode & 0o777).toBe(0o777)
		chmodSync(existing, 0o700)
		const value = outbox(spoolPath)
		expect(statSync(existing).mode & 0o777).toBe(0o700)
		expect(statSync(spoolPath).mode & 0o777).toBe(0o600)
		value.close()
		outboxes.splice(outboxes.indexOf(value), 1)

		const target = join(root, 'target')
		mkdirSync(target, { mode: 0o700 })
		const linked = join(root, 'linked')
		symlinkSync(target, linked)
		expect(() => outbox(join(linked, 'shadow.sqlite'))).toThrow()

		const sidecarPath = join(root, 'sidecar.sqlite')
		const victim = join(root, 'victim')
		writeFileSync(victim, 'unchanged', { mode: 0o600 })
		symlinkSync(victim, `${sidecarPath}-wal`)
		expect(() => outbox(sidecarPath)).toThrow()
		expect(readFileSync(victim, 'utf8')).toBe('unchanged')
	})

	test('accepts only closed generic facts and never persists or surfaces token, hostname, or rejected payload', () => {
		const spoolPath = join(directory(), 'nested', 'shadow.sqlite')
		const secret = 'private prompt contents'
		const value = outbox(spoolPath)
		expect(value.enqueue({ ...engagement(40), prompt: secret })).toEqual({
			status: 'rejected',
			reason: 'invalid_evidence',
		})
		expect(value.enqueue(engagement(41))).toMatchObject({ status: 'queued' })
		expect(statSync(spoolPath).mode & 0o777).toBe(0o600)
		expect(statSync(join(spoolPath, '..')).mode & 0o777).toBe(0o700)
		expect(statSync(`${spoolPath}-wal`).mode & 0o777).toBe(0o600)
		expect(statSync(`${spoolPath}-shm`).mode & 0o777).toBe(0o600)
		const persisted = readFileSync(spoolPath).toString('utf8')
		for (const prohibited of [TOKEN, HOSTNAME, secret]) expect(persisted).not.toContain(prohibited)
		const status = JSON.stringify(value.status())
		for (const prohibited of [TOKEN, HOSTNAME, COLLECTOR, PROJECT, engagement(41).evidence_id]) {
			expect(status).not.toContain(prohibited)
		}
	})

	test('keeps collector identity and sequence independent from the legacy v1/v2 store', () => {
		const root = directory()
		const legacyPath = join(root, 'legacy.sqlite')
		const legacy = new WorkHoursStore(legacyPath)
		const legacyEvent = legacy.record({ threadId: 'T-one', messageId: '1', kind: 'start', atMs: NOW })!
		const spoolPath = join(root, 'shadow.sqlite')
		const value = outbox(spoolPath)
		value.enqueue(engagement(50))
		const shadow = rows(spoolPath)[0]!
		expect(collectorId(spoolPath)).toBe(COLLECTOR)
		expect(collectorId(spoolPath)).not.toBe(legacyEvent.source_instance_id)
		expect(shadow.sequence).toBe(1)
		expect(legacyEvent.source_sequence).toBe(1)
		expect(legacy.pendingEvents(10)).toEqual([legacyEvent])
		const legacyDatabase = new Database(legacyPath, { readonly: true })
		expect(legacyDatabase.query<{ count: number }, []>(
			`SELECT count(*) AS count FROM sqlite_master WHERE name LIKE 'physical_shadow_%'`,
		).get()!.count).toBe(0)
		legacyDatabase.close()
		legacy.close()
	})
})

function editSpool(path: string, action: (db: Database) => void): void {
	const db = new Database(path)
	try { action(db) } finally { db.close() }
}

function synchronizationRow(path: string) {
	const db = new Database(path, { readonly: true })
	try {
		return db.query<{ sequence: number; pending: string | null; stale: number }, []>(
			'SELECT sequence, pending, stale FROM physical_shadow_synchronization',
		).get()!
	} finally { db.close() }
}

function closeOutbox(value: PhysicalShadowEvidenceOutbox) {
	value.close()
	outboxes.splice(outboxes.indexOf(value), 1)
}

function synchronizationHarness(overrides: Partial<PhysicalShadowEvidenceOutboxOptions> = {}) {
	const path = overrides.spoolPath ?? join(directory(), 'shadow.sqlite')
	let monotonic = 0, wall = NOW
	const requests: RequestInit[] = []
	let reply = () => json({ status: 'accepted' })
	const options = {
		monotonicNow: () => monotonic, now: () => wall,
		fetch: async (url: string, init: RequestInit) => {
			if (url.endsWith('/v1/shadow-synchronization')) {
				requests.push(init)
				// This independent connection can write during transport: no snapshot writer lock survives.
				editSpool(path, (db) => db.exec('BEGIN IMMEDIATE; COMMIT'))
				expect(synchronizationRow(path).pending).toBe(init.body as string)
				return reply()
			}
			return url.endsWith('/v1/executor-profile') ? json({ executor_label: HOSTNAME }) : json({ status: 'accepted' })
		}, ...overrides,
	}
	return {
		path, requests, value: outbox(path, options),
		advance: (ms = 60000) => { monotonic += ms },
		wall: (ms: number) => { wall = ms },
		reply: (next: () => Response) => { reply = next },
		reopen: () => outbox(path, options),
		body: () => JSON.parse(String(requests.at(-1)!.body)),
	}
}

describe('Stage 5L inactive synchronization client', () => {
	test('Stage 5K registration, ack loss, rotation and exact duplicate operate end to end without profile writes from status', async () => {
		const store = new ServiceStore(join(directory(), 'service.sqlite'), { now: () => NOW, trusted: () => true })
		serviceStores.push(store)
		const issued = store.issueBearer(NOW)
		store.bindExecutorLabel(issued.tokenId, HOSTNAME)
		let token = issued.token, loseResponse = false
		const urls: string[] = []
		const app = createApp({ store, now: () => NOW, oidcVerifier: { verify: async () => false },
			fleetHostnames: new Set([HOSTNAME]), logger: new ServiceLogger(() => {}) })
		const h = synchronizationHarness({ tokenProvider: { getToken: async () => token }, fetch: async (url, init) => {
			urls.push(new URL(url).pathname)
			const response = await app.fetch(new Request(url, init))
			if (url.endsWith('/v1/shadow-synchronization') && loseResponse) {
				loseResponse = false
				await response.text()
				throw new Error('response lost')
			}
			return response
		} })
		h.advance()
		expect(await h.value.synchronizationStep()).toBe('registration_required')
		expect(urls).toEqual(['/v1/shadow-synchronization'])
		h.value.enqueue(engagement(1))
		expect(await h.value.drainStep()).toMatchObject({ status: 'delivered' })
		loseResponse = true
		h.advance()
		expect(await h.value.synchronizationStep()).toBe('retryable')
		const exact = synchronizationRow(h.path).pending
		closeOutbox(h.value)
		token = store.rotateBearer(issued.tokenId, NOW + 1).token
		const resumed = h.reopen()
		h.advance()
		expect(await resumed.synchronizationStep('retry')).toBe('duplicate')
		expect(JSON.parse(exact!).observation_sequence).toBe(2)
		expect(synchronizationRow(h.path).pending).toBeNull()
		expect(store.shadow.records()).toHaveLength(1)
		expect(urls).toEqual(['/v1/shadow-synchronization', '/v1/executor-profile', '/v1/shadow-evidence',
			'/v1/shadow-synchronization', '/v1/shadow-synchronization'])
	})

	test('samples all retained rows once: blocked precedes retrying, no double count, minimum original recovered occurrence', async () => {
		const h = synchronizationHarness()
		h.value.enqueue(engagement(1))
		h.value.enqueue(engagement(2, { recovered: true, timing: {
			wall_time: '2001-01-01T00:00:00.000Z', provenance: 'native_occurrence', precision_ms: 1,
		} }))
		h.value.enqueue(engagement(3))
		editSpool(h.path, (db) => {
			db.exec(`UPDATE physical_shadow_outbox SET payload_bytes = 200, retry_attempt = 2, retry_at_ms = 1;
				UPDATE physical_shadow_outbox SET state = 'blocked', blocked_reason = 'invalid_record', payload_bytes = 340
				WHERE source_sequence = 3`)
		})
		h.advance()
		expect(await h.value.synchronizationStep()).toBe('accepted')
		expect(h.body()).toEqual({ protocol_version: 1, collector_instance_id: COLLECTOR, observation_sequence: 1,
			observed_at_ms: NOW, state: 'blocked', records: 3, bytes: 740, oldest_queued_at_ms: 978307200000 })
		editSpool(h.path, (db) => db.exec('DELETE FROM physical_shadow_outbox WHERE source_sequence = 3'))
		h.advance()
		await h.value.synchronizationStep()
		expect(h.body()).toMatchObject({ state: 'retrying', records: 2, bytes: 400 })
		editSpool(h.path, (db) => db.exec('UPDATE physical_shadow_outbox SET retry_attempt = 0, retry_at_ms = 0'))
		h.advance()
		await h.value.synchronizationStep()
		expect(h.body()).toMatchObject({ state: 'queued', records: 2 })
		await h.value.drainStep()
		await h.value.drainStep()
		h.advance()
		await h.value.synchronizationStep()
		expect(h.body()).toMatchObject({ state: 'clear', records: 0, bytes: 0, oldest_queued_at_ms: null })
	})

	test('saturates bytes and records independently, preserving exact values below each threshold', async () => {
		const h = synchronizationHarness()
		h.value.enqueue(engagement(1))
		for (const [bytes, expected] of [[8388607, 8388607], [8388609, 8388608]]) {
			editSpool(h.path, (db) => db.query('UPDATE physical_shadow_outbox SET payload_bytes = ?').run(bytes!))
			h.advance()
			await h.value.synchronizationStep()
			expect(h.body()).toMatchObject({ records: 1, bytes: expected })
		}
		editSpool(h.path, (db) => db.transaction(() => {
			db.exec('DELETE FROM physical_shadow_outbox')
			for (let n = 1; n <= 10001; n++) {
				const evidence = engagement(n)
				db.query('INSERT INTO physical_shadow_outbox(evidence_id,envelope_json,payload_bytes) VALUES(?,?,1)').run(
					evidence.evidence_id, JSON.stringify({ protocol: 'cukup.experimental.harness-evidence', protocol_version: 1,
						collector_instance_id: COLLECTOR, capabilities: ['engagement.submission'], evidence: [evidence] }),
				)
			}
		}).immediate())
		h.advance()
		expect(await h.value.synchronizationStep()).toBe('accepted')
		expect(h.body()).toMatchObject({ records: 10000, bytes: 10001 })
	})

	test('migrates recognized schema 2 preserving every row, identity, source high water, settings and modes', async () => {
		const path = join(directory(), 'shadow.sqlite')
		const old = outbox(path)
		old.enqueue(engagement(1))
		old.enqueue(engagement(2))
		closeOutbox(old)
		let before: unknown[] = []
		editSpool(path, (db) => {
			db.exec(`ALTER TABLE physical_shadow_outbox DROP COLUMN record_kind; PRAGMA user_version = 2;
				UPDATE sqlite_sequence SET seq = 42 WHERE name = 'physical_shadow_outbox';
				UPDATE physical_shadow_outbox SET state = 'blocked', blocked_reason = 'transport' WHERE source_sequence = 1;
				UPDATE physical_shadow_outbox SET retry_attempt = 3, retry_at_ms = 99 WHERE source_sequence = 2;
				INSERT INTO physical_shadow_settings VALUES ('preserved', 'setting')`)
			before = db.query(`SELECT source_sequence, evidence_id, envelope_json, payload_bytes, state,
				blocked_reason, retry_attempt, retry_at_ms FROM physical_shadow_outbox`).all()
		})
		const h = synchronizationHarness({ spoolPath: path })
		editSpool(path, (db) => {
			expect(db.query(`SELECT source_sequence, evidence_id, envelope_json, payload_bytes, state,
				blocked_reason, retry_attempt, retry_at_ms FROM physical_shadow_outbox`).all()).toEqual(before)
			expect(db.query('SELECT DISTINCT record_kind FROM physical_shadow_outbox').all()).toEqual([{ record_kind: 'evidence' }])
			expect(db.query("SELECT seq FROM sqlite_sequence WHERE name='physical_shadow_outbox'").get()).toEqual({ seq: 42 })
			expect(db.query("SELECT value FROM physical_shadow_settings WHERE key='preserved'").get()).toEqual({ value: 'setting' })
			expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 })
		})
		expect(collectorId(path)).toBe(COLLECTOR)
		expect(synchronizationRow(path)).toEqual({ sequence: 0, pending: null, stale: 0 })
		h.advance()
		await h.value.synchronizationStep()
		expect(h.body().observation_sequence).toBe(1)
		h.value.enqueue(engagement(3))
		expect(rows(path).at(-1)!.sequence).toBe(43)
		for (const file of [path, `${path}.owner`, `${path}-wal`, `${path}-shm`]) expect(statSync(file).mode & 0o777).toBe(0o600)
		expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
	})

	test('schema 2 migration never recreates missing synchronization state and evidence still drains', async () => {
		for (const missing of ['table', 'singleton'] as const) {
			const path = join(directory(), 'shadow.sqlite')
			let monotonic = 0
			let value = outbox(path, { monotonicNow: () => monotonic })
			value.enqueue(engagement(missing === 'table' ? 1 : 2))
			closeOutbox(value)
			editSpool(path, (db) => db.exec(`
				ALTER TABLE physical_shadow_outbox DROP COLUMN record_kind;
				${missing === 'table' ? 'DROP TABLE physical_shadow_synchronization;' : 'DELETE FROM physical_shadow_synchronization;'}
				PRAGMA user_version = 2;
			`))
			value = outbox(path, { monotonicNow: () => monotonic })
			monotonic = 60_000
			expect(await value.synchronizationStep()).toBe(missing === 'table' ? 'unavailable' : 'disabled')
			editSpool(path, (db) => {
				expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 })
				if (missing === 'table') expect(db.query("SELECT name FROM sqlite_schema WHERE name='physical_shadow_synchronization'").get()).toBeNull()
				else expect(db.query('SELECT * FROM physical_shadow_synchronization').all()).toEqual([])
			})
			expect(await value.drainStep()).toMatchObject({ status: 'delivered' })
			closeOutbox(value)
		}
	})

	test('schema 2 migration preserves nonzero synchronization state exactly', async () => {
		const path = join(directory(), 'shadow.sqlite')
		let monotonic = 0
		let value = outbox(path, { monotonicNow: () => monotonic })
		value.enqueue(engagement(3))
		closeOutbox(value)
		editSpool(path, (db) => db.exec(`
			ALTER TABLE physical_shadow_outbox DROP COLUMN record_kind;
			UPDATE physical_shadow_synchronization SET sequence = 7, stale = 1;
			PRAGMA user_version = 2;
		`))
		value = outbox(path, { monotonicNow: () => monotonic })
		expect(synchronizationRow(path)).toEqual({ sequence: 7, pending: null, stale: 1 })
		monotonic = 60_000
		expect(await value.synchronizationStep()).toBe('suspended')
		expect(await value.drainStep()).toMatchObject({ status: 'delivered' })
	})

	test.each([
		'DELETE FROM physical_shadow_synchronization',
		'PRAGMA ignore_check_constraints=ON; UPDATE physical_shadow_synchronization SET sequence=-1',
		"UPDATE physical_shadow_synchronization SET pending='corrupt'",
		'UPDATE physical_shadow_synchronization SET sequence=9007199254740991',
	])('counter failure or exhaustion disables only synchronization: %s', async (sql) => {
		const h = synchronizationHarness()
		h.value.enqueue(engagement(1))
		editSpool(h.path, (db) => db.exec(sql))
		closeOutbox(h.value)
		const resumed = h.reopen()
		h.advance()
		expect(await resumed.synchronizationStep()).toBe('disabled')
		expect(h.requests).toHaveLength(0)
		expect(await resumed.drainStep()).toMatchObject({ status: 'delivered' })
	})

	test('response loss and restart retry exact durable revision with rotated bearer, fresh replacement advances independently', async () => {
		let token = TOKEN
		const h = synchronizationHarness({ tokenProvider: { getToken: async () => token } })
		h.reply(() => { throw new Error('private transport diagnostic') })
		h.advance()
		expect(await h.value.synchronizationStep()).toBe('retryable')
		const first = h.requests[0]!.body
		closeOutbox(h.value)
		const resumed = h.reopen()
		token = 'cukup_v1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
		expect(await resumed.synchronizationStep('retry')).toBe('waiting')
		h.advance()
		h.wall(NOW + 120000)
		expect(await resumed.synchronizationStep('retry')).toBe('retryable')
		expect(h.requests[1]!.body).toBe(first)
		expect(new Headers(h.requests[1]!.headers).get('authorization')).toBe(`Bearer ${token}`)
		resumed.enqueue(engagement(1))
		h.advance()
		await resumed.synchronizationStep()
		expect(h.body()).toMatchObject({ observation_sequence: 2, records: 1, observed_at_ms: NOW + 120000 })
		expect(rows(h.path)[0]!.sequence).toBe(1)
		h.reply(() => json({ status: 'duplicate' }))
		h.advance()
		expect(await resumed.synchronizationStep('retry')).toBe('duplicate')
		expect(synchronizationRow(h.path)).toEqual({ sequence: 2, pending: null, stale: 0 })
	})

	test('monotonic cadence starts with a wait, ignores wall jumps, and includes failures and concurrent calls', async () => {
		const h = synchronizationHarness()
		expect(await h.value.synchronizationStep()).toBe('waiting')
		h.advance(59999)
		h.wall(NOW + 1000000)
		expect(await h.value.synchronizationStep()).toBe('waiting')
		h.advance(1)
		h.reply(() => json({ error: 'unauthorized' }, 401))
		const first = h.value.synchronizationStep()
		expect(h.value.synchronizationStep()).toBe(first)
		expect(await first).toBe('retryable')
		expect(h.requests).toHaveLength(1)
		h.advance(59999)
		expect(await h.value.synchronizationStep()).toBe('waiting')
		h.advance(1)
		await h.value.synchronizationStep()
		expect(h.requests).toHaveLength(2)
	})

	test('backward monotonic readings between waiting calls disable only status', async () => {
		const h = synchronizationHarness()
		h.advance(59000)
		expect(await h.value.synchronizationStep()).toBe('waiting')
		h.advance(-29000)
		expect(await h.value.synchronizationStep()).toBe('disabled')
		h.value.enqueue(engagement(1))
		expect(await h.value.drainStep()).toMatchObject({ status: 'delivered' })
	})

	test.each(['close', 'step'])('failed stale write keeps ownership until durable repair via %s', async (repair) => {
		const h = synchronizationHarness()
		h.value.enqueue(engagement(1))
		const before = rows(h.path)
		const lock = new Database(h.path)
		try {
			h.reply(() => {
				lock.exec('BEGIN IMMEDIATE')
				return json({ status: 'rejected', reason: 'stale_observation' })
			})
			h.advance()
			expect(await h.value.synchronizationStep()).toBe('unavailable')
			expect(synchronizationRow(h.path).stale).toBe(0)
			expect(() => h.value.close()).toThrow('Physical shadow synchronization suspension must persist before close')
			expect(() => outbox(h.path)).toThrow()
			expect(await h.value.synchronizationStep()).toBe('unavailable')
			expect(h.requests).toHaveLength(1)
			lock.exec('ROLLBACK')
			if (repair === 'step') expect(await h.value.synchronizationStep()).toBe('suspended')
			closeOutbox(h.value)
			const resumed = h.reopen()
			h.advance()
			expect(await resumed.synchronizationStep()).toBe('suspended')
			expect(synchronizationRow(h.path)).toMatchObject({ sequence: 1, stale: 1 })
			expect(rows(h.path)).toEqual(before)
			expect(h.requests).toHaveLength(1)
			expect(await resumed.drainStep()).toMatchObject({ status: 'delivered' })
		} finally { if (lock.inTransaction) lock.exec('ROLLBACK'); lock.close() }
	})

	test('stale suspension survives deliberate restart without guessing counter recovery', async () => {
		const h = synchronizationHarness()
		h.reply(() => json({ status: 'rejected', reason: 'stale_observation' }))
		h.advance()
		expect(await h.value.synchronizationStep()).toBe('suspended')
		expect(synchronizationRow(h.path).stale).toBe(1)
		closeOutbox(h.value)
		const resumed = h.reopen()
		h.advance()
		expect(await resumed.synchronizationStep()).toBe('suspended')
		expect(synchronizationRow(h.path).sequence).toBe(1)
		expect(h.requests).toHaveLength(1)
		resumed.enqueue(engagement(1))
		expect(await resumed.drainStep()).toMatchObject({ status: 'delivered' })
	})

	test.each([
		['collector_not_registered', 'registration_required'], ['invalid_observation_time', 'clock_repair_required'],
	] as const)('permits fresh bounded observation after repair: %s', async (reason, result) => {
		const h = synchronizationHarness()
		h.reply(() => json({ status: 'rejected', reason }))
		h.advance()
		expect(await h.value.synchronizationStep()).toBe(result)
		h.value.enqueue(engagement(1))
		expect(await h.value.drainStep()).toMatchObject({ status: 'delivered' })
		h.wall(NOW + 60000)
		h.reply(() => json({ status: 'accepted' }))
		h.advance()
		expect(await h.value.synchronizationStep()).toBe('accepted')
		expect(h.body()).toMatchObject({ observation_sequence: 2, observed_at_ms: NOW + 60000 })
	})

	const terminal: Array<[number, string]> = [
		[400, 'secure_transport_required'], [400, 'invalid_request'], [400, 'invalid_json'],
		[403, 'physical_bearer_required'], [403, 'executor_profile_required'], [404, 'not_found'],
		[405, 'method_not_allowed'], [413, 'payload_too_large'], [415, 'unsupported_media_type'],
	]
	test.each(terminal)('suspends only a closed terminal HTTP response %i %s', async (http, error) => {
		const h = synchronizationHarness()
		h.reply(() => json({ error }, http))
		h.advance()
		expect(await h.value.synchronizationStep()).toBe('suspended')
		h.advance()
		expect(await h.value.synchronizationStep()).toBe('suspended')
		expect(h.requests).toHaveLength(1)
		expect(synchronizationRow(h.path).sequence).toBe(1)
	})
	test.each(['invalid_record', 'unsupported_version', 'identity_conflict'])('suspends repair-required semantic %s', async (reason) => {
		const h = synchronizationHarness()
		h.reply(() => json({ status: 'rejected', reason }))
		h.advance()
		expect(await h.value.synchronizationStep()).toBe('suspended')
		closeOutbox(h.value)
		const resumed = h.reopen()
		h.reply(() => json({ status: 'accepted' }))
		h.advance()
		expect(await resumed.synchronizationStep()).toBe('accepted')
		expect(h.body().observation_sequence).toBe(2)
	})

	test.each([
		[401, '{"error":"unauthorized"}'], [429, '{"error":"rate_limited"}'],
		[500, '{"error":"internal_error"}'], [503, '{"error":"temporarily_unavailable"}'],
		[502, '<html>failure</html>'], [403, '{"error":"not_found"}'],
		[400, '{"error":"invalid_json","detail":"secret"}'], [200, '{"status":"accepted","extra":0}'],
		[200, '{"status":"rejected","reason":"future_reason"}'],
		[200, '{"status":"rejected","status":"accepted"}'], [200, '{"status":"rejected","sta\\u0074us":"accepted"}'],
		[200, '{"status":"accepted"} trailing'], [200, '[]'], [302, '{"status":"accepted"}'],
	] as const)('retains retryable/invalid response %i %s', async (http, body) => {
		const h = synchronizationHarness()
		h.reply(() => new Response(body, { status: http, headers: { 'content-type': 'application/json' } }))
		h.advance()
		expect(await h.value.synchronizationStep()).toBe('retryable')
		expect(synchronizationRow(h.path).pending).toBe(h.requests[0]!.body as string)
		h.advance()
		expect(await h.value.synchronizationStep()).toBe('retryable')
		expect(h.requests).toHaveLength(2)
		expect(h.requests[0]!.redirect).toBe('manual')
	})

	test('enforces raw 1024-byte response cap, UTF-8 and media framing, not Content-Length', async () => {
		const h = synchronizationHarness()
		const accepted = '{"status":"accepted"}'
		for (const [body, expected] of [[accepted.padEnd(1024), 'accepted'], [accepted.padEnd(1025), 'retryable']] as const) {
			h.reply(() => new Response(body, { headers: { 'content-type': 'application/json', 'content-length': '1' } }))
			h.advance()
			expect(await h.value.synchronizationStep()).toBe(expected)
		}
		for (const response of [new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
			new Response(accepted), new Response(accepted, { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } })]) {
			h.reply(() => response)
			h.advance()
			expect(await h.value.synchronizationStep()).toBe('retryable')
		}
	})

	test('status stalls do not block evidence transport; close retains process ownership until status settles', async () => {
		let release!: (value: Response) => void
		const h = synchronizationHarness({ fetch: async (url, init) => {
			if (url.endsWith('/v1/shadow-synchronization')) {
				expect(init.redirect).toBe('manual')
				return new Promise<Response>((resolve) => { release = resolve })
			}
			return url.endsWith('/v1/executor-profile') ? json({ executor_label: HOSTNAME }) : json({ status: 'accepted' })
		} })
		h.value.enqueue(engagement(1))
		h.advance()
		const pending = h.value.synchronizationStep()
		await Bun.sleep(1)
		expect(() => h.value.close()).toThrow('Physical shadow synchronization must finish before close')
		expect(() => outbox(h.path)).toThrow()
		expect(await h.value.drainStep()).toMatchObject({ status: 'delivered' })
		expect(rows(h.path)).toHaveLength(0)
		release(json({ status: 'accepted' }))
		expect(await pending).toBe('accepted')
		closeOutbox(h.value)
		const resumed = h.reopen()
		expect(await resumed.drainStep()).toMatchObject({ status: 'idle' })
	})

	test('5000ms total deadline bounds even a stalled token provider; late completion cannot fetch or mutate', async () => {
		let release!: (token: string) => void
		const h = synchronizationHarness({ tokenProvider: { getToken: () => new Promise((resolve) => { release = resolve }) } })
		h.advance()
		const start = performance.now()
		expect(await h.value.synchronizationStep()).toBe('retryable')
		expect(performance.now() - start).toBeGreaterThanOrEqual(4900)
		expect(performance.now() - start).toBeLessThan(6000)
		const retained = synchronizationRow(h.path)
		closeOutbox(h.value)
		const resumed = h.reopen()
		release(TOKEN)
		await Bun.sleep(1)
		expect(h.requests).toHaveLength(0)
		expect(synchronizationRow(h.path)).toEqual(retained)
		expect(await resumed.synchronizationStep()).toBe('waiting')
	}, 7000)

	test('deadline also bounds stalled fetch and response stream; late responses cannot clear retained state', async () => {
		await Promise.all(['fetch', 'stream'].map(async (phase) => {
			let release!: (response: Response) => void
			let signal: AbortSignal | null | undefined
			let canceled = false
			const h = synchronizationHarness({ fetch: async (_url, init) => {
				signal = init.signal
				if (phase === 'fetch') return new Promise<Response>((resolve) => { release = resolve })
				return new Response(new ReadableStream<Uint8Array>({
					start(controller) { controller.enqueue(new TextEncoder().encode('{"status":')) },
					cancel() { canceled = true },
				}), { headers: { 'content-type': 'application/json' } })
			} })
			h.advance()
			const start = performance.now()
			expect(await h.value.synchronizationStep()).toBe('retryable')
			expect(performance.now() - start).toBeGreaterThanOrEqual(4900)
			expect(performance.now() - start).toBeLessThan(6000)
			expect(signal?.aborted).toBe(true)
			const retained = synchronizationRow(h.path)
			closeOutbox(h.value)
			h.reopen()
			if (phase === 'fetch') release(json({ status: 'accepted' }))
			else expect(canceled).toBe(true)
			await Bun.sleep(1)
			expect(synchronizationRow(h.path)).toEqual(retained)
		}))
	}, 7000)

	test('snapshot lock acquisition is bounded and corruption never yields clear or advances sequence', async () => {
		const h = synchronizationHarness()
		h.value.enqueue(engagement(1))
		editSpool(h.path, (db) => db.exec("UPDATE physical_shadow_outbox SET envelope_json='{}'"))
		h.advance()
		expect(await h.value.synchronizationStep()).toBe('unavailable')
		expect(synchronizationRow(h.path).sequence).toBe(0)
		const lock = new Database(h.path)
		try {
			lock.exec('BEGIN IMMEDIATE')
			h.advance()
			const start = performance.now()
			expect(await h.value.synchronizationStep()).toBe('unavailable')
			expect(performance.now() - start).toBeLessThan(200)
		} finally { lock.exec('ROLLBACK'); lock.close() }
		expect(h.requests).toHaveLength(0)
	})

	test('missing initialized table remains absent across restart and evidence still drains', async () => {
		const h = synchronizationHarness()
		h.value.enqueue(engagement(1))
		editSpool(h.path, (db) => db.exec('DROP TABLE physical_shadow_synchronization'))
		closeOutbox(h.value)
		const resumed = h.reopen()
		h.advance()
		expect(await resumed.synchronizationStep()).toBe('unavailable')
		expect(h.requests).toHaveLength(0)
		expect(await resumed.drainStep()).toMatchObject({ status: 'delivered' })
		editSpool(h.path, (db) => expect(db.query("SELECT name FROM sqlite_master WHERE name='physical_shadow_synchronization'").get()).toBeNull())
	})

	test('last legal observation allocates without wrap then only status exhausts', async () => {
		const h = synchronizationHarness()
		editSpool(h.path, (db) => db.exec('UPDATE physical_shadow_synchronization SET sequence=9007199254740990'))
		h.advance()
		expect(await h.value.synchronizationStep()).toBe('accepted')
		expect(h.body().observation_sequence).toBe(9007199254740991)
		h.advance()
		expect(await h.value.synchronizationStep()).toBe('disabled')
		h.value.enqueue(engagement(1))
		expect(await h.value.drainStep()).toMatchObject({ status: 'delivered' })
	})

	test('acknowledgement cannot clear a different pending revision', async () => {
		const h = synchronizationHarness()
		h.reply(() => {
			const replacement = { ...h.body(), observation_sequence: 2, observed_at_ms: NOW + 1 }
			editSpool(h.path, (db) => db.query('UPDATE physical_shadow_synchronization SET sequence=2, pending=?').run(JSON.stringify(replacement)))
			return json({ status: 'accepted' })
		})
		h.advance()
		expect(await h.value.synchronizationStep()).toBe('accepted')
		expect(JSON.parse(synchronizationRow(h.path).pending!)).toMatchObject({ observation_sequence: 2, observed_at_ms: NOW + 1 })
	})

	test('persists no bearer/hostname/profile/diagnostics in status and exposes only fixed result strings', async () => {
		const h = synchronizationHarness()
		h.reply(() => { throw new Error(`${TOKEN} ${HOSTNAME} private body https://api.cukup.dev`) })
		h.value.enqueue(engagement(1))
		h.advance()
		expect(await h.value.synchronizationStep()).toBe('retryable')
		const pending = synchronizationRow(h.path).pending!
		for (const prohibited of [TOKEN, HOSTNAME, PROJECT, engagement(1).evidence_id, 'api.cukup.dev', 'private body', 'executor_profile']) {
			expect(pending).not.toContain(prohibited)
		}
		for (const file of [h.path, `${h.path}-wal`]) {
			for (const prohibited of [TOKEN, HOSTNAME, 'api.cukup.dev', 'private body', 'executor_profile']) {
				expect(readFileSync(file).toString()).not.toContain(prohibited)
			}
		}
		expect(Object.keys(JSON.parse(pending))).toHaveLength(8)
	})
})
