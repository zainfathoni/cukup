import { describe, expect, test } from 'bun:test'
import {
	parseBatch,
	parseExecutorProfile,
	parseTargetOverride,
	parseTargetOverrideDate,
} from './protocol.ts'

const baseEvent = {
	schema_version: 1,
	event_id: '01990b2e-1c00-7000-8000-000000000001',
	source_instance_id: '7ebc7d16-3945-4e30-b46e-2c288d747f6f',
	source_sequence: 1,
	session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
	kind: 'agent.start',
	occurred_at: '2026-08-31T05:00:00.000Z',
}

describe('event protocol validation', () => {
	test('accepts the unchanged append-only v1 schema and canonicalizes random identifiers', () => {
		const parsed = parseBatch({
			events: [
				{
					...baseEvent,
					event_id: baseEvent.event_id.toUpperCase(),
					source_instance_id: baseEvent.source_instance_id.toUpperCase(),
					monotonic_duration_ms: 42,
				},
			],
		})
		expect(parsed).toEqual([
			expect.objectContaining({
				index: 0,
				eventId: baseEvent.event_id.toUpperCase(),
				event: expect.objectContaining({
					eventId: baseEvent.event_id,
					sourceInstance: baseEvent.source_instance_id,
					monotonicDurationMs: 42,
				}),
			}),
		])
	})

	test('accepts the separate closed v2 schema with an optional canonical project slug', () => {
		for (const project_slug of ['cukup-service', undefined]) {
			const parsed = parseBatch({
				events: [{ ...baseEvent, schema_version: 2, ...(project_slug ? { project_slug } : {}) }],
			})
			expect(parsed?.[0]).toEqual(
				expect.objectContaining({
					event: expect.objectContaining({
						schemaVersion: 2,
						...(project_slug ? { projectSlug: project_slug } : {}),
					}),
				}),
			)
		}
		expect(parseBatch({ events: [{ ...baseEvent, project_slug: 'cukup' }] })?.[0]).toEqual(
			expect.objectContaining({ reason: 'prohibited_field' }),
		)
	})

	test('accepts deterministic UUIDv5 event and session identities from legacy migration', () => {
		const parsed = parseBatch({
			events: [
				{
					...baseEvent,
					event_id: '01990b2e-1c00-5000-8000-000000000001',
					session_id: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa',
				},
			],
		})
		expect(parsed?.[0]).toEqual(expect.objectContaining({ event: expect.any(Object) }))
	})

	test('rejects every prohibited metadata category instead of ignoring it', () => {
		for (const prohibited of [
			'hostname',
			'username',
			'repository_id',
			'project_id',
			'thread_id',
			'message_id',
			'prompt',
			'content',
			'model_name',
			'fleet_source',
		]) {
			const parsed = parseBatch({ events: [{ ...baseEvent, [prohibited]: 'private' }] })
			expect(parsed).toEqual([
				expect.objectContaining({ reason: 'prohibited_field', eventId: baseEvent.event_id }),
			])
		}
	})

	test('reports malformed records independently and rejects descending per-source order', () => {
		const parsed = parseBatch({
			events: [
				{ ...baseEvent, source_sequence: 2 },
				{ ...baseEvent, event_id: 'not-a-uuid', source_sequence: 3 },
				{
					...baseEvent,
					event_id: '01990b2e-1c00-7000-8000-000000000002',
					source_sequence: 1,
				},
			],
		})
		expect(parsed?.map((entry) => ('event' in entry ? 'valid' : entry.reason))).toEqual([
			'valid',
			'invalid_event',
			'source_sequence_order',
		])
	})

	test('rejects invalid root shapes, versions, IDs, timestamps, and durations', () => {
		expect(parseBatch([])).toBeUndefined()
		expect(parseBatch({ events: [], extra: true })).toBeUndefined()
		for (const override of [
			{ schema_version: 3 },
			{ event_id: '01990b2e-1c00-4000-8000-000000000001' },
			{ source_instance_id: '01990b2e-1c00-7000-8000-000000000001' },
			{ source_sequence: 0 },
			{ session_id: '01990b2e-1c00-7000-8000-000000000001' },
			{ kind: 'other' },
			{ occurred_at: '2026-08-31T05:00:00Z' },
			{ occurred_at: '2026-02-30T05:00:00.000Z' },
			{ monotonic_duration_ms: -1 },
		]) {
			expect(parseBatch({ events: [{ ...baseEvent, ...override }] })).toEqual([
				expect.objectContaining({ reason: 'invalid_event' }),
			])
		}
		for (const project_slug of ['', 'Cukup', '-cukup', 'cukup-', 'cukup--service', 'cukup!']) {
			expect(
				parseBatch({ events: [{ ...baseEvent, schema_version: 2, project_slug }] }),
			).toEqual([expect.objectContaining({ reason: 'invalid_event' })])
		}
	})

	test('accepts only the exact executor profile envelope', () => {
		expect(parseExecutorProfile({ hostname: 'zain-macbook' })).toBe('zain-macbook')
		expect(parseExecutorProfile({ hostname: 'zain-macbook', extra: true })).toBeUndefined()
		expect(parseExecutorProfile({ hostname: 1 })).toBeUndefined()
	})

	test('accepts only a real exact civil date and the closed zero-target override', () => {
		for (const date of ['2026-09-01', '2024-02-29']) {
			expect(parseTargetOverrideDate(date)).toBe(date)
		}
		for (const date of [
			'2026-9-01',
			'2026-09-1',
			'2026-02-29',
			'2026-04-31',
			'0000-01-01',
			' 2026-09-01',
		]) {
			expect(parseTargetOverrideDate(date)).toBeUndefined()
		}
		expect(parseTargetOverride({ target_minutes: 0 })).toEqual({ targetMinutes: 0 })
		for (const body of [
			{},
			{ target_minutes: 1 },
			{ target_minutes: 0, reason: 'private' },
			{ target_minutes: '0' },
		]) {
			expect(parseTargetOverride(body)).toBeUndefined()
		}
	})
})
