import {
	addDays,
	buildSessionIntervals,
	localDateAt,
	periodStatus,
	startOfZonedDay,
	summarizeWork,
	targetMinutesFor,
	unionIntervals,
	type CivilDate,
	type Interval,
	type SessionInterval,
} from '../aggregation.ts'
import { SERVICE_TIMEZONE } from '../config.ts'
import type { AttributedStoredWorkEvent, StoredWorkEvent } from '../types.ts'
import type {
	ActivityInterval,
	DashboardReport,
	DashboardSelection,
	DayBreakdown,
	DayDetail,
	ExecutorSummary,
	Panel,
	Timeline,
	TimelineLane,
	Trend,
	TrendSeries,
} from './report.ts'

export type DashboardReportStore = {
	events(): StoredWorkEvent[]
	attributedEvents(): AttributedStoredWorkEvent[]
	targetOverrides(): ReadonlyMap<string, number>
	listBearerMetadata(): Array<{
		revokedAt: string | null
		executorLabel: string | null
	}>
}

export type DashboardLabels = { projects: string[]; executors: string[] }

type AttributedInterval = SessionInterval<AttributedStoredWorkEvent> & {
	project: string
	executor: string
}

export function availableDashboardLabels(store: DashboardReportStore): DashboardLabels {
	const projects = new Set<string>(['Unassigned'])
	const executors = new Set<string>()
	for (const event of store.attributedEvents()) {
		if (event.kind === 'agent.start') projects.add(event.projectSlug ?? 'Unassigned')
		executors.add(event.executorLabel)
	}
	for (const credential of store.listBearerMetadata()) {
		executors.add(credential.executorLabel ?? 'unassigned-executor')
	}
	return {
		projects: [...projects].sort(labelOrder),
		executors: [...executors].sort(labelOrder),
	}
}

export function parseDashboardSelection(
	value: unknown,
	labels: DashboardLabels,
): DashboardSelection | undefined {
	if (
		!isRecord(value) ||
		(!hasExactKeys(value, ['projects', 'executors', 'range']) &&
			!hasExactKeys(value, ['projects', 'executors', 'range', 'timeline_date']))
	) {
		return undefined
	}
	const projects = parseSelectionValues(value.projects, new Set(labels.projects))
	const executors = parseSelectionValues(value.executors, new Set(labels.executors))
	if (!projects || !executors || !isRecord(value.range)) return undefined
	const timelineDate = value.timeline_date
	if (timelineDate !== undefined && (typeof timelineDate !== 'string' || !parseCivilDate(timelineDate))) {
		return undefined
	}
	const selectedDate = timelineDate === undefined ? {} : { timeline_date: timelineDate }
	const range = value.range
	if (range.preset === 7 || range.preset === 30 || range.preset === 90) {
		if (!hasExactKeys(range, ['preset'])) return undefined
		return { projects, executors, ...selectedDate, range: { preset: range.preset } }
	}
	if (
		range.preset !== 'custom' ||
		!hasExactKeys(range, ['preset', 'start_date', 'end_date']) ||
		typeof range.start_date !== 'string' ||
		typeof range.end_date !== 'string'
	) {
		return undefined
	}
	const start = parseCivilDate(range.start_date)
	const end = parseCivilDate(range.end_date)
	if (!start || !end) return undefined
	const days = civilDayNumber(end) - civilDayNumber(start)
	if (days < 0 || days > 365) return undefined
	return {
		projects,
		executors,
		...selectedDate,
		range: {
			preset: 'custom',
			start_date: range.start_date,
			end_date: range.end_date,
		},
	}
}

export function buildDashboardReport(
	store: DashboardReportStore,
	selection: DashboardSelection,
	nowMs: number,
): DashboardReport {
	const asOf = new Date(nowMs).toISOString()
	let labels: DashboardLabels = { projects: [], executors: [] }
	try {
		labels = availableDashboardLabels(store)
	} catch {
		// Label discovery is not allowed to make otherwise independent panels look healthy.
	}
	return {
		schema_version: 1,
		as_of: asOf,
		timezone: SERVICE_TIMEZONE,
		available_projects: labels.projects,
		available_executors: labels.executors,
		overall: buildPanel('Working-time summary is unavailable.', () => {
			const summary = summarizeWork(store.events(), nowMs, undefined, store.targetOverrides())
			return { today: summary.daily, week: summary.weekly }
		}),
		timeline: buildPanel('Activity timeline is unavailable.', () =>
			buildTimeline(attributedIntervals(store.attributedEvents(), nowMs), selection, nowMs),
		),
		trend: buildPanel('Activity trend is unavailable.', () =>
			buildTrend(
				attributedIntervals(store.attributedEvents(), nowMs),
				selection,
				nowMs,
				store.targetOverrides(),
			),
		),
		executors: buildPanel('Executor details are unavailable.', () =>
			buildExecutors(store.attributedEvents(), store.listBearerMetadata()),
		),
	}
}

function attributedIntervals(
	events: readonly AttributedStoredWorkEvent[],
	nowMs: number,
): AttributedInterval[] {
	return buildSessionIntervals(events, nowMs).map((interval) => ({
		...interval,
		project: interval.start.projectSlug ?? 'Unassigned',
		executor: interval.start.executorLabel,
	}))
}

type ClippedInterval = Interval & { project: string; executor: string }

function buildTimeline(
	intervals: readonly AttributedInterval[],
	selection: DashboardSelection,
	nowMs: number,
): Timeline {
	const today = localDateAt(nowMs, SERVICE_TIMEZONE)
	const date = selection.timeline_date === undefined ? today : parseCivilDate(selection.timeline_date)!
	const startMs = startOfZonedDay(date, SERVICE_TIMEZONE)
	const endMs = Math.min(startOfZonedDay(addDays(date, 1), SERVICE_TIMEZONE), nowMs)
	const selectedIntervals = intervals.filter((interval) => matchesSelection(interval, selection))
	const selected = clipAttributedIntervals(selectedIntervals, startMs, endMs)
	const weekStart = addDays(date, -mondayOffset(date))
	const weekStartMs = startOfZonedDay(weekStart, SERVICE_TIMEZONE)
	const weekEndMs = Math.min(startOfZonedDay(addDays(weekStart, 7), SERVICE_TIMEZONE), nowMs)
	const selectedWeek = clipAttributedIntervals(selectedIntervals, weekStartMs, weekEndMs)
	const dayLanes = [
		...timelineLanes('project', selected, (interval) => interval.project),
		...timelineLanes('executor', selected, (interval) => interval.executor),
	]
	return {
		date: civilDateString(date),
		week: isoWeek(date),
		minutes: totalMinutes(unionIntervals(selected)),
		week_minutes: totalMinutes(unionIntervals(selectedWeek)),
		intervals: concurrencyIntervals(selected),
		lanes: dayLanes,
	}
}

function clipAttributedIntervals(
	intervals: readonly AttributedInterval[],
	startMs: number,
	endMs: number,
): ClippedInterval[] {
	return intervals
		.map((interval) => ({
			startMs: Math.max(interval.startMs, startMs),
			endMs: Math.min(interval.endMs, endMs),
			project: interval.project,
			executor: interval.executor,
		}))
		.filter((interval) => interval.endMs > interval.startMs)
}
/**
 * One Gantt lane per label with selected activity today. Bars are unioned
 * within a lane, so a lane never overlaps itself and every visible overlap is
 * genuine cross-lane concurrency. Lanes are ordered by first activity.
 */
function timelineLanes(
	kind: TimelineLane['kind'],
	intervals: readonly ClippedInterval[],
	labelOf: (interval: ClippedInterval) => string,
): TimelineLane[] {
	const grouped = new Map<string, ClippedInterval[]>()
	for (const interval of intervals) {
		const label = labelOf(interval)
		const lane = grouped.get(label) ?? []
		lane.push(interval)
		grouped.set(label, lane)
	}
	return [...grouped]
		.map(([label, lane]) => {
			const union = unionIntervals(lane)
			return {
				kind,
				label,
				minutes: totalMinutes(union),
				startMs: union[0]!.startMs,
				intervals: union.map((interval) => ({
					start: new Date(interval.startMs).toISOString(),
					end: new Date(interval.endMs).toISOString(),
				})),
			}
		})
		.sort((left, right) => left.startMs - right.startMs || labelOrder(left.label, right.label))
		.map(({ startMs: _startMs, ...lane }) => lane)
}

function totalMinutes(union: readonly Interval[]): number {
	let total = 0
	for (const interval of union) total += interval.endMs - interval.startMs
	return Math.floor(total / 60_000)
}

function concurrencyIntervals(intervals: readonly Interval[]): ActivityInterval[] {
	const changes = new Map<number, number>()
	for (const interval of intervals) {
		changes.set(interval.startMs, (changes.get(interval.startMs) ?? 0) + 1)
		changes.set(interval.endMs, (changes.get(interval.endMs) ?? 0) - 1)
	}
	const boundaries = [...changes].sort(([left], [right]) => left - right)
	const result: ActivityInterval[] = []
	let concurrency = 0
	for (let index = 0; index < boundaries.length - 1; index += 1) {
		const [at, change] = boundaries[index]!
		concurrency += change
		const next = boundaries[index + 1]![0]
		if (concurrency <= 0 || next <= at) continue
		const previous = result.at(-1)
		if (previous?.concurrency === concurrency && previous.end === new Date(at).toISOString()) {
			previous.end = new Date(next).toISOString()
		} else {
			result.push({
				start: new Date(at).toISOString(),
				end: new Date(next).toISOString(),
				concurrency,
			})
		}
	}
	return result
}

function buildTrend(
	intervals: readonly AttributedInterval[],
	selection: DashboardSelection,
	nowMs: number,
	targetOverrides: ReadonlyMap<string, number>,
): Trend {
	const range = trendRange(selection, nowMs)
	const dates: CivilDate[] = []
	for (let date = range.start; civilDayNumber(date) <= civilDayNumber(range.end); date = addDays(date, 1)) {
		dates.push(date)
	}
	const days = dayBounds(dates)
	const series: TrendSeries[] = [
		trendSeries('overall', 'Overall working time', intervals, dates, days),
	]
	for (const project of selection.projects) {
		series.push(
			trendSeries(
				'project',
				project,
				intervals.filter(
					(interval) =>
						interval.project === project &&
						(selection.executors.length === 0 || selection.executors.includes(interval.executor)),
				),
				dates,
				days,
			),
		)
	}
	for (const executor of selection.executors) {
		series.push(
			trendSeries(
				'executor',
				executor,
				intervals.filter(
					(interval) =>
						interval.executor === executor &&
						(selection.projects.length === 0 || selection.projects.includes(interval.project)),
				),
				dates,
				days,
			),
		)
	}
	if (selection.projects.length > 0 && selection.executors.length > 0) {
		series.push(
			trendSeries(
				'combined',
				'Selected project and executor activity',
				intervals.filter((interval) => matchesSelection(interval, selection)),
				dates,
				days,
			),
		)
	}
	return {
		start_date: civilDateString(range.start),
		end_date: civilDateString(range.end),
		series,
		days: buildDayDetails(intervals, dates, days, targetOverrides),
	}
}

/** Zoned midnight-to-midnight bounds, resolved once per date and shared by every series. */
function dayBounds(dates: readonly CivilDate[]): Interval[] {
	const last = dates.at(-1)
	if (last === undefined) return []
	const starts = dates.map((date) => startOfZonedDay(date, SERVICE_TIMEZONE))
	starts.push(startOfZonedDay(addDays(last, 1), SERVICE_TIMEZONE))
	return dates.map((_date, index) => ({ startMs: starts[index]!, endMs: starts[index + 1]! }))
}

function trendSeries(
	kind: TrendSeries['kind'],
	label: string,
	intervals: readonly Interval[],
	dates: readonly CivilDate[],
	days: readonly Interval[],
): TrendSeries {
	const stats = dayStatistics(unionIntervals(intervals), days)
	return {
		kind,
		label,
		points: dates.map((date, index) => ({
			date: civilDateString(date),
			minutes: stats[index]!.minutes,
		})),
	}
}

/**
 * Globally unioned detail behind every heatmap cell. These values ignore the
 * filter selection for the same reason the Overall panel does: they describe
 * Overall Working Time, which filters never alter.
 */
function buildDayDetails(
	intervals: readonly AttributedInterval[],
	dates: readonly CivilDate[],
	days: readonly Interval[],
	targetOverrides: ReadonlyMap<string, number>,
): DayDetail[] {
	const overall = dayStatistics(unionIntervals(intervals), days)
	const projects = breakdownByDay(intervals, days, (interval) => interval.project)
	const executors = breakdownByDay(intervals, days, (interval) => interval.executor)
	return dates.map((date, index) => {
		const statistics = overall[index]!
		return {
			date: civilDateString(date),
			period: periodStatus(
				statistics.minutes * 60_000,
				targetMinutesFor(date, targetOverrides) * 60_000,
			),
			interval_count: statistics.count,
			first_activity_at: statistics.firstMs === null ? null : new Date(statistics.firstMs).toISOString(),
			last_activity_at: statistics.lastMs === null ? null : new Date(statistics.lastMs).toISOString(),
			projects: breakdownAt(projects, index),
			executors: breakdownAt(executors, index),
		}
	})
}

function breakdownByDay(
	intervals: readonly AttributedInterval[],
	days: readonly Interval[],
	labelOf: (interval: AttributedInterval) => string,
): Map<string, DayStatistics[]> {
	const grouped = new Map<string, AttributedInterval[]>()
	for (const interval of intervals) {
		const label = labelOf(interval)
		const group = grouped.get(label) ?? []
		group.push(interval)
		grouped.set(label, group)
	}
	return new Map(
		[...grouped].map(([label, group]) => [label, dayStatistics(unionIntervals(group), days)]),
	)
}

function breakdownAt(statistics: Map<string, DayStatistics[]>, index: number): DayBreakdown[] {
	return [...statistics]
		.map(([label, days]) => ({ label, minutes: days[index]!.minutes }))
		.filter((entry) => entry.minutes > 0)
		.sort((left, right) => right.minutes - left.minutes || labelOrder(left.label, right.label))
}

type DayStatistics = {
	minutes: number
	count: number
	firstMs: number | null
	lastMs: number | null
}

/**
 * Single forward walk over sorted unioned intervals and ascending day bounds,
 * so a 366-day range costs one pass per series rather than one pass per day.
 */
function dayStatistics(union: readonly Interval[], days: readonly Interval[]): DayStatistics[] {
	const statistics: DayStatistics[] = []
	let cursor = 0
	for (const day of days) {
		while (cursor < union.length && union[cursor]!.endMs <= day.startMs) cursor += 1
		let scan = cursor
		let overlapMs = 0
		let count = 0
		let firstMs: number | null = null
		let lastMs: number | null = null
		while (scan < union.length && union[scan]!.startMs < day.endMs) {
			const start = Math.max(union[scan]!.startMs, day.startMs)
			const end = Math.min(union[scan]!.endMs, day.endMs)
			overlapMs += end - start
			count += 1
			if (firstMs === null) firstMs = start
			lastMs = end
			scan += 1
		}
		statistics.push({ minutes: Math.floor(overlapMs / 60_000), count, firstMs, lastMs })
	}
	return statistics
}

function trendRange(
	selection: DashboardSelection,
	nowMs: number,
): { start: CivilDate; end: CivilDate } {
	if (selection.range.preset === 'custom') {
		return {
			start: parseCivilDate(selection.range.start_date)!,
			end: parseCivilDate(selection.range.end_date)!,
		}
	}
	const end = localDateAt(nowMs, SERVICE_TIMEZONE)
	return { start: addDays(end, -(selection.range.preset - 1)), end }
}

function buildExecutors(
	events: readonly AttributedStoredWorkEvent[],
	credentials: ReturnType<DashboardReportStore['listBearerMetadata']>,
): ExecutorSummary[] {
	const labels = new Set(events.map((event) => event.executorLabel))
	for (const credential of credentials) {
		labels.add(credential.executorLabel ?? 'unassigned-executor')
	}
	return [...labels].sort(labelOrder).map((label) => {
		const matchingEvents = events.filter((event) => event.executorLabel === label)
		const matchingCredentials = credentials.filter(
			(credential) => (credential.executorLabel ?? 'unassigned-executor') === label,
		)
		return {
			label,
			last_activity_at: latestTimestamp(matchingEvents.map((event) => event.occurredAtMs)),
			last_synchronized_at: latestTimestamp(matchingEvents.map((event) => event.receivedAtMs)),
			credential_state:
				label === 'amp-orb'
					? 'not-applicable'
					: matchingCredentials.some((credential) => credential.revokedAt === null)
						? 'active'
						: 'revoked',
		}
	})
}

function matchesSelection(interval: AttributedInterval, selection: DashboardSelection): boolean {
	return (
		(selection.projects.length === 0 || selection.projects.includes(interval.project)) &&
		(selection.executors.length === 0 || selection.executors.includes(interval.executor))
	)
}

function parseSelectionValues(value: unknown, allowed: ReadonlySet<string>): string[] | undefined {
	if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== 'string')) {
		return undefined
	}
	const values = value as string[]
	if (new Set(values).size !== values.length || values.some((item) => !allowed.has(item))) {
		return undefined
	}
	return [...values]
}

function parseCivilDate(value: string): CivilDate | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
	if (!match) return undefined
	const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
	return civilDateString(date) === value ? date : undefined
}

function civilDateString(date: CivilDate): string {
	const normalized = new Date(Date.UTC(date.year, date.month - 1, date.day))
	return [
		String(normalized.getUTCFullYear()).padStart(4, '0'),
		String(normalized.getUTCMonth() + 1).padStart(2, '0'),
		String(normalized.getUTCDate()).padStart(2, '0'),
	].join('-')
}

function civilDayNumber(date: CivilDate): number {
	return Date.UTC(date.year, date.month - 1, date.day) / 86_400_000
}

function mondayOffset(date: CivilDate): number {
	return (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7
}

/** ISO week-year and Monday-based week number for a civil date. */
function isoWeek(date: CivilDate): string {
	const thursday = addDays(date, 3 - mondayOffset(date))
	const firstThursday = addDays({ year: thursday.year, month: 1, day: 4 }, 3 - mondayOffset({
		year: thursday.year,
		month: 1,
		day: 4,
	}))
	const week = 1 + Math.round((civilDayNumber(thursday) - civilDayNumber(firstThursday)) / 7)
	return `${String(thursday.year).padStart(4, '0')}-W${String(week).padStart(2, '0')}`
}

function latestTimestamp(values: readonly number[]): string | null {
	return values.length === 0 ? null : new Date(Math.max(...values)).toISOString()
}

function buildPanel<T>(message: string, build: () => T): Panel<T> {
	try {
		return { state: 'ready', data: build() }
	} catch {
		return { state: 'unavailable', message }
	}
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort()
	const expectedKeys = [...expected].sort()
	return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function labelOrder(left: string, right: string): number {
	return left.localeCompare(right, 'en')
}
