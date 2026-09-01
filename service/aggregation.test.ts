import { describe, expect, test } from 'bun:test'
import {
	buildGlobalIntervals,
	startOfZonedDay,
	summarizeWork,
	type AggregationConfig,
} from './aggregation.ts'
import type { StoredWorkEvent } from './types.ts'

const minute = 60_000
const hour = 60 * minute
const sourceA = '7ebc7d16-3945-4e30-b46e-2c288d747f6f'
const sourceB = 'ca3dfd5f-823b-4339-aefd-ade5f762b6f7'

function event(
	index: number,
	sourceInstance: string,
	sessionId: string,
	kind: 'agent.start' | 'agent.end',
	atMs: number,
): StoredWorkEvent {
	const at = new Date(atMs).toISOString()
	return {
		schemaVersion: 1,
		eventId: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
		sourceInstance,
		sourceSequence: index,
		sessionId,
		kind,
		occurredAt: at,
		occurredAtMs: atMs,
		receivedAt: at,
		receivedAtMs: atMs,
	}
}

function fixedConfig(timezone: string): AggregationConfig {
	return {
		timezone,
		dailyTargetMinutes: [0, 480, 480, 480, 480, 480, 0],
		idleGraceMs: 15 * minute,
		crashCapMs: 15 * minute,
	}
}

describe('global interval construction', () => {
	test('unions overlapping sessions from separate random sources exactly once', () => {
		const base = Date.parse('2026-08-31T02:00:00.000Z')
		const events = [
			event(1, sourceA, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'agent.start', base),
			event(2, sourceA, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'agent.end', base + 30 * minute),
			event(1, sourceB, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'agent.start', base + 15 * minute),
			event(2, sourceB, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'agent.end', base + hour),
		]
		expect(buildGlobalIntervals(events, base + 2 * hour)).toEqual([
			{ startMs: base, endMs: base + hour + 15 * minute },
		])
	})

	test('renews grace, clips future grace at now, and crash-caps an unmatched start', () => {
		const base = Date.parse('2026-08-31T02:00:00.000Z')
		const sessions = [
			event(1, sourceA, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'agent.start', base),
			event(2, sourceA, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'agent.end', base + 5 * minute),
			event(3, sourceA, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'agent.start', base + 15 * minute),
			event(4, sourceA, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'agent.end', base + 25 * minute),
		]
		expect(buildGlobalIntervals(sessions, base + 30 * minute)).toEqual([
			{ startMs: base, endMs: base + 30 * minute },
		])

		const unmatched = event(
			5,
			sourceA,
			'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
			'agent.start',
			base,
		)
		expect(buildGlobalIntervals([unmatched], base + 4 * hour)).toEqual([
			{ startMs: base, endMs: base + 15 * minute },
		])
	})

	test('prefers monotonic turn duration when wall-clock evidence moves', () => {
		const base = Date.parse('2026-08-31T02:00:00.000Z')
		const start = event(1, sourceA, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'agent.start', base)
		const end = {
			...event(
				2,
				sourceA,
				'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				'agent.end',
				base - hour,
			),
			monotonicDurationMs: 20 * minute,
		}
		expect(buildGlobalIntervals([start, end], base + hour)).toEqual([
			{ startMs: base, endMs: base + 35 * minute },
		])
	})
})

describe('timezone-aware summaries', () => {
	test('clips at Jakarta midnight and keeps Monday as the weekly boundary', () => {
		const now = Date.parse('2026-09-01T02:00:00.000Z') // Tuesday 09:00 Jakarta
		const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
		const events = [
			event(1, sourceA, session, 'agent.start', Date.parse('2026-08-31T16:50:00.000Z')),
			event(2, sourceA, session, 'agent.end', Date.parse('2026-08-31T17:10:00.000Z')),
		]
		const summary = summarizeWork(events, now)
		expect(summary.daily.worked_minutes).toBe(25)
		expect(summary.weekly.worked_minutes).toBe(35)
	})

	test('returns UNDER, COMPLETE, and OVER with the appropriate difference field', () => {
		const weekdayNow = Date.parse('2026-08-31T05:00:00.000Z')
		const under = summarizeWork([], weekdayNow)
		expect(under.daily).toEqual({
			status: 'UNDER',
			worked_minutes: 0,
			target_minutes: 480,
			difference_minutes: 480,
		})

		const weekendNow = Date.parse('2026-09-05T05:00:00.000Z')
		const complete = summarizeWork([], weekendNow)
		expect(complete.daily).toEqual({
			status: 'COMPLETE',
			worked_minutes: 0,
			target_minutes: 0,
			difference_minutes: 0,
		})

		const start = weekendNow - 30 * minute
		const over = summarizeWork(
			[event(1, sourceA, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'agent.start', start)],
			weekendNow,
		)
		expect(over.daily).toEqual({
			status: 'OVER',
			worked_minutes: 15,
			target_minutes: 0,
			difference_minutes: 15,
		})
	})

	test('reduces and restores daily and Monday-week targets without changing evidence', () => {
		const mondayNow = Date.parse('2026-08-31T05:00:00.000Z')
		const overrides = new Map([['2026-08-31', 0]])
		const complete = summarizeWork([], mondayNow, undefined, overrides)
		expect(complete.daily).toEqual({
			status: 'COMPLETE',
			worked_minutes: 0,
			target_minutes: 0,
			difference_minutes: 0,
		})
		expect(complete.weekly.target_minutes).toBe(1_920)

		const evidence = [
			event(
				1,
				sourceA,
				'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				'agent.start',
				mondayNow - 30 * minute,
			),
		]
		const dayOff = summarizeWork(evidence, mondayNow, undefined, overrides)
		const halfDay = summarizeWork(
			evidence,
			mondayNow,
			undefined,
			new Map([['2026-08-31', 240]]),
		)
		const restored = summarizeWork(evidence, mondayNow)
		expect(dayOff.daily).toEqual({
			status: 'OVER',
			worked_minutes: 15,
			target_minutes: 0,
			difference_minutes: 15,
		})
		expect(halfDay.daily).toEqual({
			status: 'UNDER',
			worked_minutes: 15,
			target_minutes: 240,
			difference_minutes: 225,
		})
		expect(halfDay.weekly.target_minutes).toBe(2_160)
		expect(restored.daily).toEqual({
			status: 'UNDER',
			worked_minutes: 15,
			target_minutes: 480,
			difference_minutes: 465,
		})
		expect(restored.weekly.target_minutes).toBe(2_400)
		expect(restored.weekly.worked_minutes).toBe(dayOff.weekly.worked_minutes)
		expect(halfDay.weekly.worked_minutes).toBe(dayOff.weekly.worked_minutes)
	})

	test('resolves 23-hour and 25-hour civil days without depending on the process timezone', () => {
		const springStart = startOfZonedDay({ year: 2026, month: 3, day: 8 }, 'America/New_York')
		const springEnd = startOfZonedDay({ year: 2026, month: 3, day: 9 }, 'America/New_York')
		const fallStart = startOfZonedDay({ year: 2026, month: 11, day: 1 }, 'America/New_York')
		const fallEnd = startOfZonedDay({ year: 2026, month: 11, day: 2 }, 'America/New_York')
		expect(springEnd - springStart).toBe(23 * hour)
		expect(fallEnd - fallStart).toBe(25 * hour)

		const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
		const summary = summarizeWork(
			[
				event(1, sourceA, session, 'agent.start', Date.parse('2026-03-08T06:30:00.000Z')),
				event(2, sourceA, session, 'agent.end', Date.parse('2026-03-08T07:30:00.000Z')),
			],
			Date.parse('2026-03-08T16:00:00.000Z'),
			fixedConfig('America/New_York'),
		)
		expect(summary.daily.worked_minutes).toBe(75)
	})

	test('splits a Sunday-to-Monday interval at the configured week boundary in a DST timezone', () => {
		const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
		const summary = summarizeWork(
			[
				event(1, sourceA, session, 'agent.start', Date.parse('2026-11-02T04:30:00.000Z')),
				event(2, sourceA, session, 'agent.end', Date.parse('2026-11-02T05:30:00.000Z')),
			],
			Date.parse('2026-11-02T12:00:00.000Z'),
			fixedConfig('America/New_York'),
		)
		expect(summary.weekly.worked_minutes).toBe(45)
	})
})
