export const IDLE_GRACE_MS = 15 * 60 * 1_000
export const DEFAULT_WEEKDAY_TARGET_MINUTES = 8 * 60
export const PRODUCT_TIME_ZONE = 'Asia/Jakarta'
export const PRODUCT_WEEK_START = 'Monday'

export type WorkEvent = {
	threadId: string
	messageId: string
	kind: 'start' | 'end'
	atMs: number
	status?: 'done' | 'error' | 'cancelled'
}

export type WorkStatus = {
	classification: 'NO HOURS DUE' | 'UNDER' | 'COMPLETE' | 'OVER'
	workedMinutes: number
	targetMinutes: number
	differenceMinutes: number
}

type Interval = { startMs: number; endMs: number }

export function turnKey(event: Pick<WorkEvent, 'threadId' | 'messageId'>): string {
	return `${event.threadId}\u0000${event.messageId}`
}

export function latestUnmatchedStarts(events: readonly WorkEvent[]): WorkEvent[] {
	const starts = new Map<string, WorkEvent>()
	const ended = new Set<string>()

	for (const event of events) {
		const key = turnKey(event)
		if (event.kind === 'start') {
			starts.set(key, event)
		} else {
			ended.add(key)
		}
	}

	const latestByThread = new Map<string, WorkEvent>()
	for (const [key, start] of starts) {
		if (ended.has(key)) continue
		const current = latestByThread.get(start.threadId)
		if (!current || start.atMs > current.atMs) latestByThread.set(start.threadId, start)
	}
	return [...latestByThread.values()]
}

export function workedMilliseconds(
	events: readonly WorkEvent[],
	nowMs: number,
	dayStartMs: number,
	dayEndMs: number,
	activeTurnKeys: ReadonlySet<string> = new Set(),
): number {
	const starts = new Map<string, WorkEvent>()
	const ends = new Map<string, WorkEvent>()
	for (const event of events) {
		const key = turnKey(event)
		if (event.kind === 'start') starts.set(key, event)
		else ends.set(key, event)
	}

	const intervals: Interval[] = []
	for (const [key, start] of starts) {
		const end = ends.get(key)
		let inferredEndMs: number
		if (end) {
			inferredEndMs = Math.max(start.atMs, end.atMs) + IDLE_GRACE_MS
		} else if (activeTurnKeys.has(key)) {
			inferredEndMs = nowMs
		} else {
			inferredEndMs = start.atMs + IDLE_GRACE_MS
		}

		const clippedStart = Math.max(start.atMs, dayStartMs)
		const clippedEnd = Math.min(inferredEndMs, nowMs, dayEndMs)
		if (clippedEnd > clippedStart) intervals.push({ startMs: clippedStart, endMs: clippedEnd })
	}

	intervals.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
	let total = 0
	let current: Interval | undefined
	for (const interval of intervals) {
		if (!current) {
			current = { ...interval }
			continue
		}
		if (interval.startMs <= current.endMs) {
			current.endMs = Math.max(current.endMs, interval.endMs)
			continue
		}
		total += current.endMs - current.startMs
		current = { ...interval }
	}
	if (current) total += current.endMs - current.startMs
	return total
}

export function classifyWork(workedMs: number, targetMinutes: number): WorkStatus {
	const workedMinutes = Math.floor(workedMs / 60_000)
	const differenceMinutes = Math.abs(workedMinutes - targetMinutes)
	if (targetMinutes === 0 && workedMinutes === 0) {
		return { classification: 'NO HOURS DUE', workedMinutes, targetMinutes, differenceMinutes: 0 }
	}
	return {
		classification:
			workedMinutes < targetMinutes
				? 'UNDER'
				: workedMinutes === targetMinutes
					? 'COMPLETE'
					: 'OVER',
		workedMinutes,
		targetMinutes,
		differenceMinutes,
	}
}

export function formatStatus(status: WorkStatus): string {
	const progress = `${formatMinutes(status.workedMinutes)} / ${formatMinutes(status.targetMinutes)} today`
	if (status.classification === 'NO HOURS DUE') return `NO HOURS DUE · ${progress}`
	if (status.classification === 'COMPLETE') return `COMPLETE · ${progress}`
	const difference = formatMinutes(status.differenceMinutes)
	const suffix = status.classification === 'UNDER' ? `${difference} remaining` : `${difference} over`
	return `${status.classification} · ${progress} · ${suffix}`
}

export function formatMinutes(minutes: number): string {
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function localDayBounds(nowMs: number): { startMs: number; endMs: number; weekend: boolean } {
	const now = new Date(nowMs)
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
	const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
	return {
		startMs: start.getTime(),
		endMs: end.getTime(),
		weekend: now.getDay() === 0 || now.getDay() === 6,
	}
}

export function jakartaDayBounds(nowMs: number): { startMs: number; endMs: number; weekend: boolean } {
	const jakartaOffsetMs = 7 * 60 * 60 * 1_000
	const shifted = new Date(nowMs + jakartaOffsetMs)
	const startMs =
		Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - jakartaOffsetMs
	const day = shifted.getUTCDay()
	return { startMs, endMs: startMs + 24 * 60 * 60 * 1_000, weekend: day === 0 || day === 6 }
}

export function parseDailyTarget(input: string): number | undefined {
	const match = /^(\d{1,2}):([0-5]\d)$/.exec(input.trim())
	if (!match) return undefined
	const hours = Number(match[1])
	const minutes = Number(match[2])
	if (hours > 24 || (hours === 24 && minutes !== 0)) return undefined
	return hours * 60 + minutes
}
