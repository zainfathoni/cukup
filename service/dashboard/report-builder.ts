import {
	addDays,
	buildSessionIntervals,
	localDateAt,
	startOfZonedDay,
	summarizeWork,
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
	ExecutorSummary,
	Panel,
	Timeline,
	Trend,
	TrendPoint,
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
	if (!isRecord(value) || !hasExactKeys(value, ['projects', 'executors', 'range'])) {
		return undefined
	}
	const projects = parseSelectionValues(value.projects, new Set(labels.projects))
	const executors = parseSelectionValues(value.executors, new Set(labels.executors))
	if (!projects || !executors || !isRecord(value.range)) return undefined
	const range = value.range
	if (range.preset === 7 || range.preset === 30 || range.preset === 90) {
		if (!hasExactKeys(range, ['preset'])) return undefined
		return { projects, executors, range: { preset: range.preset } }
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
			buildTrend(attributedIntervals(store.attributedEvents(), nowMs), selection, nowMs),
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

function buildTimeline(
	intervals: readonly AttributedInterval[],
	selection: DashboardSelection,
	nowMs: number,
): Timeline {
	const today = localDateAt(nowMs, SERVICE_TIMEZONE)
	const startMs = startOfZonedDay(today, SERVICE_TIMEZONE)
	const endMs = Math.min(startOfZonedDay(addDays(today, 1), SERVICE_TIMEZONE), nowMs)
	const selected = intervals
		.filter((interval) => matchesSelection(interval, selection))
		.map((interval) => ({
			startMs: Math.max(interval.startMs, startMs),
			endMs: Math.min(interval.endMs, endMs),
		}))
		.filter((interval) => interval.endMs > interval.startMs)
	return { date: civilDateString(today), intervals: concurrencyIntervals(selected) }
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
): Trend {
	const range = trendRange(selection, nowMs)
	const series: TrendSeries[] = [
		trendSeries('overall', 'Overall working time', intervals, range.start, range.end),
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
				range.start,
				range.end,
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
				range.start,
				range.end,
			),
		)
	}
	if (selection.projects.length > 0 && selection.executors.length > 0) {
		series.push(
			trendSeries(
				'combined',
				'Selected project and executor activity',
				intervals.filter((interval) => matchesSelection(interval, selection)),
				range.start,
				range.end,
			),
		)
	}
	return {
		start_date: civilDateString(range.start),
		end_date: civilDateString(range.end),
		series,
	}
}

function trendSeries(
	kind: TrendSeries['kind'],
	label: string,
	intervals: readonly Interval[],
	start: CivilDate,
	end: CivilDate,
): TrendSeries {
	const union = unionIntervals(intervals)
	const points: TrendPoint[] = []
	for (let date = start; civilDayNumber(date) <= civilDayNumber(end); date = addDays(date, 1)) {
		const dayStart = startOfZonedDay(date, SERVICE_TIMEZONE)
		const dayEnd = startOfZonedDay(addDays(date, 1), SERVICE_TIMEZONE)
		points.push({
			date: civilDateString(date),
			minutes: Math.floor(overlapMilliseconds(union, dayStart, dayEnd) / 60_000),
		})
	}
	return { kind, label, points }
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

function overlapMilliseconds(intervals: readonly Interval[], startMs: number, endMs: number): number {
	let total = 0
	for (const interval of intervals) {
		total += Math.max(0, Math.min(interval.endMs, endMs) - Math.max(interval.startMs, startMs))
	}
	return total
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
