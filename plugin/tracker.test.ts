import { describe, expect, test } from 'bun:test'
import {
	IDLE_GRACE_MS,
	classifyWork,
	formatStatus,
	latestUnmatchedStarts,
	localDayBounds,
	parseDailyTarget,
	turnKey,
	type WorkEvent,
	workedMilliseconds,
} from './tracker.ts'

const minute = 60_000
const hour = 60 * minute
const dayStart = 1_000_000_000
const dayEnd = dayStart + 24 * hour

function start(messageId: string, at: number, threadId = 'T-one'): WorkEvent {
	return { threadId, messageId, kind: 'start', atMs: dayStart + at }
}

function end(messageId: string, at: number, threadId = 'T-one'): WorkEvent {
	return { threadId, messageId, kind: 'end', atMs: dayStart + at, status: 'done' }
}

describe('workedMilliseconds', () => {
	test('counts a completed turn and the post-turn idle grace only through now', () => {
		const events = [start('1', 0), end('1', 10 * minute)]
		expect(workedMilliseconds(events, dayStart + 20 * minute, dayStart, dayEnd)).toBe(
			20 * minute,
		)
		expect(workedMilliseconds(events, dayStart + hour, dayStart, dayEnd)).toBe(
			10 * minute + IDLE_GRACE_MS,
		)
	})

	test('bridges another prompt inside the grace period', () => {
		const events = [
			start('1', 0),
			end('1', 5 * minute),
			start('2', 15 * minute),
			end('2', 20 * minute),
		]
		expect(workedMilliseconds(events, dayStart + hour, dayStart, dayEnd)).toBe(35 * minute)
	})

	test('excludes a gap beyond the idle grace period', () => {
		const events = [
			start('1', 0),
			end('1', 5 * minute),
			start('2', 30 * minute),
			end('2', 35 * minute),
		]
		expect(workedMilliseconds(events, dayStart + hour, dayStart, dayEnd)).toBe(40 * minute)
	})

	test('unions overlapping turns from concurrent threads', () => {
		const events = [
			start('1', 0),
			end('1', 30 * minute),
			start('2', 10 * minute, 'T-two'),
			end('2', 40 * minute, 'T-two'),
		]
		expect(workedMilliseconds(events, dayStart + hour, dayStart, dayEnd)).toBe(55 * minute)
	})

	test('counts an unmatched active turn through now and caps a stale turn', () => {
		const event = start('1', 0)
		expect(
			workedMilliseconds(
				[event],
				dayStart + 2 * hour,
				dayStart,
				dayEnd,
				new Set([turnKey(event)]),
			),
		).toBe(2 * hour)
		expect(workedMilliseconds([event], dayStart + 2 * hour, dayStart, dayEnd)).toBe(
			IDLE_GRACE_MS,
		)
	})

	test('clips work crossing the current day boundary', () => {
		const events: WorkEvent[] = [
			{ threadId: 'T-one', messageId: '1', kind: 'start', atMs: dayStart - 10 * minute },
			{ threadId: 'T-one', messageId: '1', kind: 'end', atMs: dayStart + 5 * minute },
		]
		expect(workedMilliseconds(events, dayStart + hour, dayStart, dayEnd)).toBe(20 * minute)
	})
})

test('latestUnmatchedStarts returns only the newest unmatched turn per thread', () => {
	const events = [start('old', 0), start('done', minute), end('done', 2 * minute), start('new', 3 * minute)]
	expect(latestUnmatchedStarts(events).map((event) => event.messageId)).toEqual(['new'])
})

describe('status and target formatting', () => {
	test('formats under, complete, over, and no-hours-due states', () => {
		expect(formatStatus(classifyWork(5 * hour + 42 * minute, 8 * 60))).toBe(
			'UNDER · 5h 42m / 8h 00m today · 2h 18m remaining',
		)
		expect(formatStatus(classifyWork(8 * hour, 8 * 60))).toBe(
			'COMPLETE · 8h 00m / 8h 00m today',
		)
		expect(formatStatus(classifyWork(9 * hour + 5 * minute, 8 * 60))).toBe(
			'OVER · 9h 05m / 8h 00m today · 1h 05m over',
		)
		expect(formatStatus(classifyWork(0, 0))).toBe('NO HOURS DUE · 0m / 0m today')
		expect(classifyWork(minute, 0).classification).toBe('OVER')
	})

	test('parses only bounded H:MM targets', () => {
		expect(parseDailyTarget('8:00')).toBe(480)
		expect(parseDailyTarget('0:00')).toBe(0)
		expect(parseDailyTarget('24:00')).toBe(1440)
		expect(parseDailyTarget('24:01')).toBeUndefined()
		expect(parseDailyTarget('8')).toBeUndefined()
	})

	test('uses local civil-day boundaries across daylight-saving changes', () => {
		const previousTimezone = process.env.TZ
		process.env.TZ = 'America/New_York'
		try {
			const spring = localDayBounds(new Date('2026-03-08T12:00:00-04:00').getTime())
			const fall = localDayBounds(new Date('2026-11-01T12:00:00-05:00').getTime())
			expect(spring.endMs - spring.startMs).toBe(23 * hour)
			expect(fall.endMs - fall.startMs).toBe(25 * hour)
			expect(spring.weekend).toBeTrue()
		} finally {
			if (previousTimezone === undefined) delete process.env.TZ
			else process.env.TZ = previousTimezone
		}
	})
})
