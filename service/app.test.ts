import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { MAX_CLOCK_SKEW_MS } from './config.ts'
import { ServiceLogger, redactSensitive } from './logger.ts'
import { ServiceStore } from './store.ts'

const now = Date.parse('2026-08-31T05:00:00.000Z')
const source = '7ebc7d16-3945-4e30-b46e-2c288d747f6f'
const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const temporaryDirectories: string[] = []

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

function databasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), 'cukup-service-app-'))
	temporaryDirectories.push(directory)
	return join(directory, 'service.sqlite')
}

function workloadToken(): string {
	return ['eyJhbGciOiJSUzI1NiJ9', 'eyJ1c2VyX2lkIjoiYWxsb3dlZCJ9', 'signature'].join('.')
}

function wireEvent(
	sequence: number,
	kind: 'agent.start' | 'agent.end' = 'agent.start',
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schema_version: 1,
		event_id: `01990b2e-1c00-7000-8000-${String(sequence).padStart(12, '0')}`,
		source_instance_id: source,
		source_sequence: sequence,
		session_id: session,
		kind,
		occurred_at: new Date(now - (15 - sequence * 5) * 60_000).toISOString(),
		...overrides,
	}
}

function fixture(path = databasePath()): {
	store: ServiceStore
	token: string
	logs: string[]
	app: ReturnType<typeof createApp>
} {
	const store = new ServiceStore(path)
	const issued = store.issueBearer(now)
	const logs: string[] = []
	return {
		store,
		token: issued.token,
		logs,
		app: createApp({
			store,
			oidcVerifier: { verify: async (value) => value === workloadToken() },
			now: () => now,
			logger: new ServiceLogger((line) => logs.push(line)),
			fleetHostnames: new Set(['zain-macbook', 'vikas-mac-mini']),
		}),
	}
}

function request(
	path: string,
	options: RequestInit & { token?: string; origin?: string } = {},
): Request {
	const { token, origin = 'https://api.cukup.dev', ...init } = options
	const headers = new Headers(init.headers)
	if (token) headers.set('authorization', `Bearer ${token}`)
	return new Request(`${origin}${path}`, { ...init, headers })
}

describe('HTTP boundary', () => {
	test('keeps health minimal and protects v1 route knowledge', async () => {
		const value = fixture()
		const health = await value.app.fetch(request('/healthz'))
		expect(health.status).toBe(200)
		expect(await health.json()).toEqual({ ok: true })
		expect([...health.headers.keys()].sort()).toEqual([
			'cache-control',
			'content-type',
			'x-content-type-options',
		])
		const readiness = await value.app.fetch(
			new Request('https://container.internal/up', { headers: { host: 'container.internal' } }),
		)
		expect(readiness.status).toBe(200)
		expect(await readiness.json()).toEqual({ ok: true })

		const unauthenticated = await value.app.fetch(request('/v1/not-real'))
		expect(unauthenticated.status).toBe(401)
		expect(await unauthenticated.json()).toEqual({ error: 'unauthorized' })
		const authenticated = await value.app.fetch(request('/v1/not-real', { token: value.token }))
		expect(authenticated.status).toBe(404)
		expect(await authenticated.json()).toEqual({ error: 'not_found' })
		value.store.close()
	})

	test('serves time to bearer and workload OIDC callers over secure boundaries', async () => {
		const value = fixture()
		for (const token of [value.token, workloadToken()]) {
			const response = await value.app.fetch(request('/v1/time', { token }))
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({ server_time: '2026-08-31T05:00:00.000Z' })
		}
		const insecure = await value.app.fetch(
			request('/v1/time', { token: value.token, origin: 'http://api.cukup.dev' }),
		)
		expect(insecure.status).toBe(400)

		const proxied = createApp({
			store: value.store,
			oidcVerifier: { verify: async () => false },
			now: () => now,
			logger: new ServiceLogger(() => {}),
			trustTlsProxy: true,
		})
		const response = await proxied.fetch(
			request('/v1/time', {
				token: value.token,
				origin: 'http://api.cukup.dev',
				headers: { 'x-forwarded-proto': 'https' },
			}),
		)
		expect(response.status).toBe(200)
		value.store.close()
	})

	test('advertises permanent mixed ingestion while defaulting only future starts to v1', async () => {
		const value = fixture()
		const response = await value.app.fetch(request('/v1/capabilities', { token: value.token }))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			schema_version: 1,
			accepted_event_schema_versions: [1, 2],
			preferred_new_event_schema_version: 1,
		})

		const v2Preferred = createApp({
			store: value.store,
			oidcVerifier: { verify: async () => false },
			now: () => now,
			logger: new ServiceLogger(() => {}),
			preferredNewEventSchemaVersion: 2,
		})
		const enabled = await v2Preferred.fetch(
			request('/v1/capabilities', { token: value.token }),
		)
		expect((await enabled.json() as any).preferred_new_event_schema_version).toBe(2)
		value.store.close()
	})

	test('binds a physical executor profile idempotently without exposing labels in errors or logs', async () => {
		const value = fixture()
		const bind = (token: string, body: unknown) =>
			value.app.fetch(
				request('/v1/executor-profile', {
					method: 'PUT',
					token,
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				}),
			)

		for (let attempt = 0; attempt < 2; attempt += 1) {
			const response = await bind(value.token, { hostname: 'zain-macbook' })
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({ executor_label: 'zain-macbook' })
		}
		const mismatch = await bind(value.token, { hostname: 'vikas-mac-mini' })
		expect(mismatch.status).toBe(409)
		expect(await mismatch.json()).toEqual({ error: 'executor_profile_conflict' })

		const second = value.store.issueBearer(now + 1)
		const duplicate = await bind(second.token, { hostname: 'zain-macbook' })
		expect(duplicate.status).toBe(409)
		expect(await duplicate.json()).toEqual({ error: 'executor_profile_conflict' })
		const unrecognized = await bind(second.token, { hostname: 'unknown-machine' })
		expect(unrecognized.status).toBe(422)
		expect(await unrecognized.json()).toEqual({ error: 'invalid_executor_profile' })
		const extra = await bind(second.token, { hostname: 'vikas-mac-mini', extra: true })
		expect(extra.status).toBe(422)

		const oidc = await bind(workloadToken(), { hostname: 'vikas-mac-mini' })
		expect(oidc.status).toBe(403)
		expect(await oidc.json()).toEqual({ error: 'physical_bearer_required' })
		for (const label of ['zain-macbook', 'vikas-mac-mini', 'unknown-machine']) {
			expect(value.logs.join('\n')).not.toContain(label)
		}
		value.store.close()
	})

	test('requires a bound physical profile for v2 while OIDC derives amp-orb', async () => {
		const value = fixture()
		const upload = (token: string, event: Record<string, unknown>) =>
			value.app.fetch(
				request('/v1/events:batch', {
					method: 'POST',
					token,
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ events: [event] }),
				}),
			)
		const v2 = wireEvent(1, 'agent.start', { schema_version: 2, project_slug: 'cukup' })
		expect(await (await upload(value.token, v2)).json()).toEqual({
			results: [{ event_id: v2.event_id, status: 'rejected' }],
		})
		await value.app.fetch(
			request('/v1/executor-profile', {
				method: 'PUT',
				token: value.token,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ hostname: 'zain-macbook' }),
			}),
		)
		expect(await (await upload(value.token, v2)).json()).toEqual({
			results: [{ event_id: v2.event_id, status: 'accepted' }],
		})

		const oidcV2 = wireEvent(1, 'agent.start', {
			schema_version: 2,
			project_slug: 'cukup',
			event_id: '01990b2e-1c00-7000-8000-000000000099',
			source_instance_id: 'ca3dfd5f-823b-4339-aefd-ade5f762b6f7',
		})
		expect((await (await upload(workloadToken(), oidcV2)).json() as any).results[0].status).toBe(
			'accepted',
		)
		expect(value.store.attributedEvents().map((event) => event.executorLabel)).toEqual([
			'zain-macbook',
			'amp-orb',
		])
		const summary = await value.app.fetch(request('/v1/summary', { token: value.token }))
		expect((await summary.json() as any).schema_version).toBe(1)
		value.store.close()
	})

	test('returns accepted, duplicate, conflicted, and rejected records in one partial result', async () => {
		const value = fixture()
		const accepted = wireEvent(1)
		const response = await value.app.fetch(
			request('/v1/events:batch', {
				method: 'POST',
				token: value.token,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					events: [
						accepted,
						accepted,
						{ ...accepted, session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
						wireEvent(1, 'agent.start', {
							event_id: '01990b2e-1c00-7000-8000-000000000099',
						}),
						wireEvent(2, 'agent.end', { prompt: 'must never persist' }),
						wireEvent(2, 'agent.end', {
							occurred_at: new Date(now + MAX_CLOCK_SKEW_MS + 1).toISOString(),
						}),
						{ event_id: '01990b2e-1c00-7000-8000-000000000007' },
					],
				}),
			}),
		)
		expect(response.status).toBe(200)
		const body = (await response.json()) as { results: Array<Record<string, unknown>> }
		expect(body.results.map((result) => result.status)).toEqual([
			'accepted',
			'duplicate',
			'conflict',
			'conflict',
			'rejected',
			'rejected',
			'rejected',
		])
		expect(Object.keys(body)).toEqual(['results'])
		expect(body.results).toHaveLength(7)
		for (const result of body.results) expect(Object.keys(result).sort()).toEqual(['event_id', 'status'])
		expect(value.store.events()).toHaveLength(1)
		value.store.close()
	})

	test('returns the authoritative daily and weekly summary', async () => {
		const value = fixture()
		await value.app.fetch(
			request('/v1/events:batch', {
				method: 'POST',
				token: value.token,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ events: [wireEvent(1), wireEvent(2, 'agent.end')] }),
			}),
		)
		const response = await value.app.fetch(request('/v1/summary', { token: value.token }))
		expect(await response.json()).toEqual({
			schema_version: 1,
			as_of: '2026-08-31T05:00:00.000Z',
			daily: {
				status: 'UNDER',
				worked_minutes: 10,
				target_minutes: 480,
				difference_minutes: 470,
			},
			weekly: {
				status: 'UNDER',
				worked_minutes: 10,
				target_minutes: 2400,
				difference_minutes: 2390,
			},
		})
		value.store.close()
	})

	test('uses generic request and internal error responses without credential leakage', async () => {
		const value = fixture()
		const wrongMethod = await value.app.fetch(
			request('/v1/time', { method: 'POST', token: value.token }),
		)
		expect(wrongMethod.status).toBe(405)
		expect(wrongMethod.headers.get('allow')).toBe('GET')
		expect(await wrongMethod.json()).toEqual({ error: 'method_not_allowed' })

		const wrongMediaType = await value.app.fetch(
			request('/v1/events:batch', {
				method: 'POST',
				token: value.token,
				headers: { 'content-type': 'application/json-patch+json' },
				body: '{}',
			}),
		)
		expect(wrongMediaType.status).toBe(415)
		expect(await wrongMediaType.json()).toEqual({ error: 'unsupported_media_type' })

		const oversized = await value.app.fetch(
			request('/v1/events:batch', {
				method: 'POST',
				token: value.token,
				headers: { 'content-type': 'application/json', 'content-length': '1048577' },
				body: '{}',
			}),
		)
		expect(oversized.status).toBe(413)
		expect(await oversized.json()).toEqual({ error: 'payload_too_large' })

		const invalid = await value.app.fetch(
			request('/v1/events:batch', {
				method: 'POST',
				token: value.token,
				headers: { 'content-type': 'application/json' },
				body: '{',
			}),
		)
		expect(invalid.status).toBe(400)
		expect(await invalid.json()).toEqual({ error: 'invalid_request' })

		value.store.close()
		const failed = await value.app.fetch(request('/v1/time', { token: value.token }))
		expect(failed.status).toBe(500)
		expect(await failed.json()).toEqual({ error: 'internal_error' })
		expect(value.logs.join('\n')).not.toContain(value.token)
	})
})

test('persists authenticated ingestion across a clean store restart', async () => {
	const path = databasePath()
	const first = fixture(path)
	await first.app.fetch(
		request('/v1/events:batch', {
			method: 'POST',
			token: first.token,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ events: [wireEvent(1)] }),
		}),
	)
	first.store.close()

	const reopened = new ServiceStore(path)
	const app = createApp({
		store: reopened,
		oidcVerifier: { verify: async () => false },
		now: () => now,
		logger: new ServiceLogger(() => {}),
	})
	const response = await app.fetch(request('/v1/summary', { token: first.token }))
	expect(response.status).toBe(200)
	expect((await response.json() as any).daily.worked_minutes).toBe(10)
	reopened.close()
})

test('redacts credentials and OIDC claims and never persists workload identity', async () => {
	const token = ['cukup_v1_', 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQ'].join('')
	const jwt = workloadToken()
	const serialized = JSON.stringify(
		redactSensitive({
			authorization: `Bearer ${token}`,
			message: `failed for ${token} and ${jwt}`,
			claims: { user_id: 'private', thread_id: 'T-private' },
		}),
	)
	for (const forbidden of [token, jwt, 'private']) expect(serialized).not.toContain(forbidden)
	expect(serialized).toContain('[REDACTED]')

	const path = databasePath()
	const value = fixture(path)
	const response = await value.app.fetch(
		request('/v1/events:batch', {
			method: 'POST',
			token: jwt,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ events: [wireEvent(1)] }),
		}),
	)
	expect(response.status).toBe(200)
	value.store.close()
	const databaseBytes = readFileSync(path)
	for (const forbidden of [jwt, 'allowed', 'user_id', 'thread_id']) {
		expect(databaseBytes.includes(Buffer.from(forbidden))).toBeFalse()
	}
	expect(value.logs.join('\n')).not.toContain(jwt)
})
