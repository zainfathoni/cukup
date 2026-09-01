import { describe, expect, test } from 'bun:test'
import {
	CAPABILITIES_SCHEMA_VERSION,
	CukupServiceClient,
	EVENT_SCHEMA_VERSION_V1,
	EVENT_SCHEMA_VERSION_V2,
	isTargetOverrideDate,
	SUMMARY_SCHEMA_VERSION,
	ServiceRequestError,
	type OutboxEvent,
} from './protocol.ts'

const token = 'test-bearer-token-abcdefghijklmnopqrstuvwxyz'
const event: OutboxEvent = {
	schema_version: EVENT_SCHEMA_VERSION_V1,
	event_id: '018f3f32-7f00-7000-8000-000000000001',
	source_instance_id: '6a19480a-2d4d-4a29-8dbf-735f8300aba0',
	source_sequence: 1,
	session_id: '72828178-f318-4fd3-81e8-cf8049ebc194',
	kind: 'agent.start',
	occurred_at: '2026-08-30T00:00:00.000Z',
}

describe('CukupServiceClient', () => {
	test('keeps event, summary, and capability schema contracts separate', () => {
		expect(EVENT_SCHEMA_VERSION_V1).toBe(1)
		expect(EVENT_SCHEMA_VERSION_V2).toBe(2)
		expect(SUMMARY_SCHEMA_VERSION).toBe(1)
		expect(CAPABILITIES_SCHEMA_VERSION).toBe(1)
	})

	test('sends only the allowed event fields and keeps bearer auth in the header', async () => {
		let request: { url: string; init: RequestInit } | undefined
		const client = new CukupServiceClient('https://cukup.dev', async (url, init) => {
			request = { url, init }
			return Response.json({ results: [{ event_id: event.event_id, status: 'accepted' }] })
		})
		await client.uploadBatch(token, [event])
		const body = JSON.parse(String(request?.init.body))
		expect(request?.url).toBe('https://cukup.dev/v1/events:batch')
		expect(new Headers(request?.init.headers).get('authorization')).toBe(`Bearer ${token}`)
		expect(Object.keys(body.events[0]).sort()).toEqual([
			'event_id',
			'kind',
			'occurred_at',
			'schema_version',
			'session_id',
			'source_instance_id',
			'source_sequence',
		])
		for (const prohibited of [
			'thread',
			'message',
			'hostname',
			'username',
			'repo',
			'workspace',
			'workspace_root',
			'path',
			'remote',
			'prompt',
			'content',
			'model',
		]) {
			expect(JSON.stringify(body).toLowerCase()).not.toContain(prohibited)
		}
	})

	test('serializes a v2 Project Slug only from the supplied immutable event', async () => {
		let body: { events: unknown[] } | undefined
		const v2Event: OutboxEvent = {
			...event,
			schema_version: EVENT_SCHEMA_VERSION_V2,
			project_slug: 'cukup-plugin',
		}
		const client = new CukupServiceClient('https://cukup.dev', async (_url, init) => {
			body = JSON.parse(String(init.body))
			return Response.json({ results: [{ event_id: event.event_id, status: 'accepted' }] })
		})
		await client.uploadBatch(token, [v2Event])
		expect(body?.events).toEqual([v2Event])
	})

	test('uses the explicit capability and physical executor-profile API boundary', async () => {
		const requests: Array<{ url: string; init: RequestInit }> = []
		const client = new CukupServiceClient('https://cukup.dev', async (url, init) => {
			requests.push({ url, init })
			if (url.endsWith('/v1/capabilities')) {
				return Response.json({
					schema_version: CAPABILITIES_SCHEMA_VERSION,
					accepted_event_schema_versions: [1, 2],
					preferred_new_event_schema_version: 2,
				})
			}
			return Response.json({ executor_label: 'fleet-host-1' })
		})

		expect(await client.fetchCapabilities(token)).toEqual({
			acceptedEventSchemaVersions: [1, 2],
			preferredNewEventSchemaVersion: 2,
		})
		await client.bindExecutorProfile(token, 'fleet-host-1')
		expect(requests.map((request) => request.url)).toEqual([
			'https://cukup.dev/v1/capabilities',
			'https://cukup.dev/v1/executor-profile',
		])
		expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
			hostname: 'fleet-host-1',
		})
	})

	test('marks and clears an exact day-off target through the strict authenticated boundary', async () => {
		const requests: Array<{ url: string; init: RequestInit }> = []
		const client = new CukupServiceClient('https://cukup.dev', async (url, init) => {
			requests.push({ url, init })
			return init.method === 'PUT'
				? Response.json({ date: '2026-09-01', target_minutes: 0 })
				: new Response(null, { status: 204 })
		})
		expect(await client.putTargetOverride(token, '2026-09-01')).toEqual({
			date: '2026-09-01',
			target_minutes: 0,
		})
		await client.clearTargetOverride(token, '2026-09-01')
		expect(requests.map(({ url, init }) => [url, init.method])).toEqual([
			['https://cukup.dev/v1/target-overrides/2026-09-01', 'PUT'],
			['https://cukup.dev/v1/target-overrides/2026-09-01', 'DELETE'],
		])
		expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ target_minutes: 0 })
		for (const request of requests) {
			expect(new Headers(request.init.headers).get('authorization')).toBe(`Bearer ${token}`)
		}

		for (const date of ['2026-02-29', '2026-9-01', '2026-09-01/extra']) {
			expect(isTargetOverrideDate(date)).toBeFalse()
			await expect(client.putTargetOverride(token, date)).rejects.toMatchObject({ kind: 'protocol' })
		}
		expect(requests).toHaveLength(2)
	})

	test('treats a missing capability endpoint as v1-only compatibility', async () => {
		const client = new CukupServiceClient('https://cukup.dev', async () =>
			new Response(null, { status: 404 }),
		)
		expect(await client.fetchCapabilities(token)).toBeUndefined()
	})

	test('samples server offset from the request midpoint', async () => {
		const times = [1_000, 1_100]
		const client = new CukupServiceClient(
			'https://cukup.dev',
			async () => Response.json({ server_time: '1970-01-01T00:00:02.050Z' }),
			() => times.shift() ?? 1_100,
		)
		expect(await client.sampleTime(token)).toEqual({
			offsetMs: 1_000,
			roundTripMs: 100,
			sampledAtMs: 1_100,
		})
	})

	test('does not include response bodies or bearer tokens in errors', async () => {
		const client = new CukupServiceClient('https://cukup.dev', async () =>
			new Response(`Bearer ${token}`, { status: 500 }),
		)
		try {
			await client.fetchSummary(token)
			throw new Error('expected request failure')
		} catch (error) {
			expect(error).toBeInstanceOf(ServiceRequestError)
			expect(String(error)).not.toContain(token)
			expect(String(error)).not.toContain('Bearer')
		}
	})

	test('treats revocation responses as visible non-retryable authentication failures', async () => {
		for (const status of [401, 403]) {
			const client = new CukupServiceClient('https://cukup.dev', async () =>
				new Response(null, { status }),
			)
			try {
				await client.sampleTime(token)
				throw new Error('expected auth failure')
			} catch (error) {
				expect(error).toBeInstanceOf(ServiceRequestError)
				expect((error as ServiceRequestError).kind).toBe('authentication')
				expect((error as ServiceRequestError).retryable).toBeFalse()
			}
		}
	})
})
