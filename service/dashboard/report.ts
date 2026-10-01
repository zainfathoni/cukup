export type Panel<T> =
	| { state: 'ready'; data: T }
	| { state: 'stale'; data: T; last_successful_at: string; message: string }
	| { state: 'unavailable'; message: string }

export type TargetStatus = 'UNDER' | 'COMPLETE' | 'OVER'

export type TargetPeriod = {
	status: TargetStatus
	worked_minutes: number
	target_minutes: number
	difference_minutes: number
}

export type LimitPeriod = {
	status: 'WITHIN' | 'TOLERANCE' | 'EXCEEDED'
	worked_minutes: number
	target_minutes: number
	upper_limit_minutes: number
	difference_minutes: number
}

export type ActivityPeriod = TargetPeriod | LimitPeriod

export type Track = 'work' | 'play' | 'all'

export type OverallSummary = {
	today: ActivityPeriod
	week: ActivityPeriod
}

export type ActivityInterval = {
	start: string
	end: string
	concurrency: number
}

/** One unioned bar in a Gantt lane. Same-lane concurrency is already merged. */
export type LaneInterval = {
	start: string
	end: string
}

export type TimelineLane = {
	kind: 'project' | 'executor'
	label: string
	minutes: number
	intervals: LaneInterval[]
}

export type Timeline = {
	date: string
	week: string
	minutes: number
	week_minutes: number
	day_period: ActivityPeriod
	week_period: ActivityPeriod
	intervals: ActivityInterval[]
	lanes: TimelineLane[]
}

export type TrendPoint = {
	date: string
	minutes: number
}

export type TrendSeries = {
	kind: 'overall' | 'project' | 'executor' | 'combined'
	label: string
	points: TrendPoint[]
}

export type DayBreakdown = {
	label: string
	minutes: number
}

/**
 * Unioned detail for one track and day. Work has a goal; Play and All have
 * limits. Project and Executor Activity can overlap and must not be added.
 */
export type DayDetail = {
	date: string
	period: ActivityPeriod
	interval_count: number
	first_activity_at: string | null
	last_activity_at: string | null
	projects: DayBreakdown[]
	executors: DayBreakdown[]
}

export type Trend = {
	start_date: string
	end_date: string
	series: TrendSeries[]
	days: DayDetail[]
}

export type ExecutorSummary = {
	label: string
	last_activity_at: string | null
	last_synchronized_at: string | null
	credential_state: 'active' | 'revoked' | 'not-applicable'
}

export type DashboardReport = {
	schema_version: 1
	track?: Track
	as_of: string
	timezone: string
	timeline_date: string
	available_projects: string[]
	available_executors: string[]
	overall: Panel<OverallSummary>
	timeline: Panel<Timeline>
	trend: Panel<Trend>
	executors: Panel<ExecutorSummary[]>
}

export type DashboardSelection = {
	track?: Track
	projects: string[]
	executors: string[]
	timeline_date?: string
	range:
		| { preset: 7 | 30 | 90 }
		| { preset: 'custom'; start_date: string; end_date: string }
}

export interface DashboardTransport {
	load(selection: DashboardSelection): Promise<DashboardReport>
}

export function reportTimelineDate(report: DashboardReport): string {
	return report.timeline_date
}

export function effectiveTimelineDate(
	report: DashboardReport,
	selection: DashboardSelection,
): string {
	return selection.timeline_date ?? reportTimelineDate(report)
}

export function isoWeekStart(value: string): string {
	const date = new Date(`${value}T00:00:00Z`)
	date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
	return date.toISOString().slice(0, 10)
}

export function sameIsoWeek(left: string, right: string): boolean {
	return isoWeekStart(left) === isoWeekStart(right)
}
