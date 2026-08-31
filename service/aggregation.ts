import {
	CRASH_CAP_MS,
	DAILY_TARGET_MINUTES,
	IDLE_GRACE_MS,
	SERVICE_TIMEZONE,
} from './config.ts'
import type { StoredWorkEvent, SummaryPeriod, WorkSummary } from './types.ts'

export type Interval = { startMs: number; endMs: number }
export type SessionInterval<T extends StoredWorkEvent = StoredWorkEvent> = Interval & {
	start: T
	end?: T
}
export type CivilDate = { year: number; month: number; day: number }

export type AggregationConfig = {
	timezone: string
	dailyTargetMinutes: readonly number[]
	idleGraceMs: number
	crashCapMs: number
}

const defaultConfig: AggregationConfig = {
	timezone: SERVICE_TIMEZONE,
	dailyTargetMinutes: DAILY_TARGET_MINUTES,
	idleGraceMs: IDLE_GRACE_MS,
	crashCapMs: CRASH_CAP_MS,
}

const formatters = new Map<string, Intl.DateTimeFormat>()

export function buildGlobalIntervals(
	events: readonly StoredWorkEvent[],
	nowMs: number,
	config: Pick<AggregationConfig, 'idleGraceMs' | 'crashCapMs'> = defaultConfig,
): Interval[] {
	return unionIntervals(buildSessionIntervals(events, nowMs, config))
}

export function buildSessionIntervals<T extends StoredWorkEvent>(
	events: readonly T[],
	nowMs: number,
	config: Pick<AggregationConfig, 'idleGraceMs' | 'crashCapMs'> = defaultConfig,
): SessionInterval<T>[] {
	const sessions = new Map<string, T[]>()
	for (const event of events) {
		const key = `${event.sourceInstance}\u0000${event.sessionId}`
		const session = sessions.get(key) ?? []
		session.push(event)
		sessions.set(key, session)
	}

	const intervals: SessionInterval<T>[] = []
	for (const evidence of sessions.values()) {
		evidence.sort((left, right) => left.sourceSequence - right.sourceSequence)
		const start = evidence.find((event) => event.kind === 'agent.start')
		if (!start) continue
		let end: T | undefined
		for (const event of evidence) {
			if (event.kind === 'agent.end' && event.sourceSequence > start.sourceSequence) end = event
		}
		const completedAtMs = end
			? end.monotonicDurationMs === undefined
				? Math.max(start.occurredAtMs, end.occurredAtMs)
				: start.occurredAtMs + end.monotonicDurationMs
			: undefined
		const inferredEndMs =
			completedAtMs === undefined
				? start.occurredAtMs + config.crashCapMs
				: Math.max(start.occurredAtMs, completedAtMs) + config.idleGraceMs
		const clippedEndMs = Math.min(inferredEndMs, nowMs)
		if (clippedEndMs > start.occurredAtMs) {
			intervals.push({
				startMs: start.occurredAtMs,
				endMs: clippedEndMs,
				start,
				...(end ? { end } : {}),
			})
		}
	}
	return intervals
}

export function unionIntervals(intervals: readonly Interval[]): Interval[] {
	const sorted = intervals
		.filter((interval) => interval.endMs > interval.startMs)
		.map((interval) => ({ startMs: interval.startMs, endMs: interval.endMs }))
		.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
	const union: Interval[] = []
	for (const interval of sorted) {
		const current = union.at(-1)
		if (!current || interval.startMs > current.endMs) {
			union.push(interval)
		} else {
			current.endMs = Math.max(current.endMs, interval.endMs)
		}
	}
	return union
}

export function summarizeWork(
	events: readonly StoredWorkEvent[],
	nowMs: number,
	config: AggregationConfig = defaultConfig,
): WorkSummary {
	if (config.dailyTargetMinutes.length !== 7) {
		throw new Error('Daily targets must contain Sunday through Saturday')
	}
	const localToday = localDateAt(nowMs, config.timezone)
	const dayStartMs = startOfZonedDay(localToday, config.timezone)
	const dayEndMs = startOfZonedDay(addDays(localToday, 1), config.timezone)
	const weekStartDate = addDays(localToday, -mondayOffset(localToday))
	const weekEndDate = addDays(weekStartDate, 7)
	const weekStartMs = startOfZonedDay(weekStartDate, config.timezone)
	const weekEndMs = startOfZonedDay(weekEndDate, config.timezone)
	const intervals = buildGlobalIntervals(events, nowMs, config)

	const dailyTargetMs = targetMinutes(localToday, config.dailyTargetMinutes) * 60_000
	let weeklyTargetMs = 0
	for (let offset = 0; offset < 7; offset += 1) {
		weeklyTargetMs += targetMinutes(addDays(weekStartDate, offset), config.dailyTargetMinutes) * 60_000
	}

	return {
		schema_version: 1,
		as_of: new Date(nowMs).toISOString(),
		daily: periodStatus(
			overlapMilliseconds(intervals, dayStartMs, Math.min(dayEndMs, nowMs)),
			dailyTargetMs,
		),
		weekly: periodStatus(
			overlapMilliseconds(intervals, weekStartMs, Math.min(weekEndMs, nowMs)),
			weeklyTargetMs,
		),
	}
}

export function startOfZonedDay(date: CivilDate, timezone: string): number {
	const utc = Date.UTC(date.year, date.month - 1, date.day)
	let below = utc - 36 * 60 * 60 * 1_000
	let atOrAbove = utc + 36 * 60 * 60 * 1_000
	if (compareCivilDates(localDateAt(below, timezone), date) >= 0) {
		throw new Error(`Cannot resolve start of day in ${timezone}`)
	}
	if (compareCivilDates(localDateAt(atOrAbove, timezone), date) < 0) {
		throw new Error(`Cannot resolve start of day in ${timezone}`)
	}
	while (atOrAbove - below > 1) {
		const middle = Math.floor((below + atOrAbove) / 2)
		if (compareCivilDates(localDateAt(middle, timezone), date) < 0) below = middle
		else atOrAbove = middle
	}
	return atOrAbove
}

export function localDateAt(timestampMs: number, timezone: string): CivilDate {
	let formatter = formatters.get(timezone)
	if (!formatter) {
		formatter = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			calendar: 'gregory',
			numberingSystem: 'latn',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		})
		formatters.set(timezone, formatter)
	}
	const values: Record<string, number> = {}
	for (const part of formatter.formatToParts(new Date(timestampMs))) {
		if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
			values[part.type] = Number(part.value)
		}
	}
	return { year: values.year!, month: values.month!, day: values.day! }
}

export function addDays(date: CivilDate, amount: number): CivilDate {
	const value = new Date(Date.UTC(date.year, date.month - 1, date.day + amount))
	return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() }
}

function targetMinutes(date: CivilDate, targets: readonly number[]): number {
	return targets[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()]!
}

function mondayOffset(date: CivilDate): number {
	const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
	return (weekday + 6) % 7
}

function overlapMilliseconds(intervals: readonly Interval[], startMs: number, endMs: number): number {
	let total = 0
	for (const interval of intervals) {
		total += Math.max(0, Math.min(interval.endMs, endMs) - Math.max(interval.startMs, startMs))
	}
	return total
}

function periodStatus(workedMs: number, targetMs: number): SummaryPeriod {
	const workedMinutes = Math.floor(workedMs / 60_000)
	const targetMinutes = Math.floor(targetMs / 60_000)
	const differenceMinutes = Math.abs(workedMinutes - targetMinutes)
	if (workedMinutes < targetMinutes) {
		return {
			status: 'UNDER',
			worked_minutes: workedMinutes,
			target_minutes: targetMinutes,
			difference_minutes: differenceMinutes,
		}
	}
	if (workedMinutes > targetMinutes) {
		return {
			status: 'OVER',
			worked_minutes: workedMinutes,
			target_minutes: targetMinutes,
			difference_minutes: differenceMinutes,
		}
	}
	return {
		status: 'COMPLETE',
		worked_minutes: workedMinutes,
		target_minutes: targetMinutes,
		difference_minutes: 0,
	}
}

function compareCivilDates(left: CivilDate, right: CivilDate): number {
	return (
		Date.UTC(left.year, left.month - 1, left.day) - Date.UTC(right.year, right.month - 1, right.day)
	)
}
