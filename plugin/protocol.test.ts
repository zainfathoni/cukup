import { describe, expect, test } from 'bun:test'
import {
	CukupServiceClient,
	PROTOCOL_SCHEMA_VERSION,
	ServiceRequestError,
	type OutboxEvent,
} from './protocol.ts'

const token = 'test-bearer-token-abcdefghijklmnopqrstuvwxyz'
const event: OutboxEvent = {
	schema_version: PROTOCOL_SCHEMA_VERSION,
	event_id: '018f3f32-7f00-7000-8000-000000000001',
	source_instance_id: '6a19480a-2d4d-4a29-8dbf-735f8300aba0',
	source_sequence: 1,
	session_id: '72828178-f318-4fd3-81e8-cf8049ebc194',
	kind: 'agent.start',
	occurred_at: '2026-08-30T00:00:00.000Z',
}

describe('CukupServiceClient', () => {
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
			'prompt',
			'content',
			'model',
		]) {
			expect(JSON.stringify(body).toLowerCase()).not.toContain(prohibited)
		}
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
