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

export type OverallSummary = {
	today: TargetPeriod
	week: TargetPeriod
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
	minutes: number
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
 * Globally unioned detail behind one heatmap cell. `period` is target-bearing
 * because it describes Overall Working Time; the breakdowns are Project and
 * Executor Activity and are intentionally non-additive.
 */
export type DayDetail = {
	date: string
	period: TargetPeriod
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

export type ShadowCapabilityAssessment =
	| { status: 'unknown' }
	| { status: 'declared_for_scope'; missing_recovery_capabilities: string[] }
	| {
		status: 'declared_limited'
		missing_capabilities: string[]
		missing_recovery_capabilities: string[]
	}

export type ShadowDisclosureLaneReport = {
	label: string
	capability_intervals: Array<{
		start: string
		end: string
		working_time_v1: ShadowCapabilityAssessment
		agent_runtime_v1: ShadowCapabilityAssessment
	}>
	known_losses: Array<{
		start: string
		end: string
		capabilities: string[]
		reason: string
	}>
	pending_execution: { status: 'none_pending' | 'pending'; started_at: string[] }
	synchronization: 'clear' | 'queued' | 'retrying' | 'blocked' | 'unknown'
}

export type ShadowDisclosuresReport = {
	start: string
	end: string
	lanes: ShadowDisclosureLaneReport[]
}

export type DashboardReport = {
	schema_version: 2
	as_of: string
	timezone: string
	available_projects: string[]
	available_executors: string[]
	overall: Panel<OverallSummary>
	timeline: Panel<Timeline>
	trend: Panel<Trend>
	executors: Panel<ExecutorSummary[]>
	shadow_disclosures: Panel<ShadowDisclosuresReport>
}

type DashboardReportV1 = Omit<DashboardReport, 'schema_version' | 'shadow_disclosures'> & {
	schema_version: 1
}

function withoutCurrentSynchronization(report: DashboardReport): DashboardReport {
	if (report.shadow_disclosures.state === 'unavailable') return report
	return {
		...report,
		shadow_disclosures: {
			...report.shadow_disclosures,
			data: {
				...report.shadow_disclosures.data,
				lanes: report.shadow_disclosures.data.lanes.map((lane) => ({
					...lane,
					synchronization: 'unknown',
				})),
			},
		},
	}
}

/** Keeps a mixed-version dashboard response usable without inventing shadow data. */
export function normalizeDashboardReport(value: unknown): DashboardReport {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Invalid dashboard report')
	}
	const report = value as Record<string, unknown>
	if (report.schema_version === 2 && report.shadow_disclosures !== undefined) {
		return withoutCurrentSynchronization(report as DashboardReport)
	}
	if (report.schema_version === 1 && report.shadow_disclosures === undefined) {
		return {
			...(report as DashboardReportV1),
			schema_version: 2,
			shadow_disclosures: {
				state: 'unavailable',
				message: 'Shadow disclosures require the current dashboard report version.',
			},
		}
	}
	throw new Error('Unsupported dashboard report version')
}

export type DashboardSelection = {
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
