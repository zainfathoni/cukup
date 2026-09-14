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
