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

export type Timeline = {
	date: string
	intervals: ActivityInterval[]
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

export type Trend = {
	start_date: string
	end_date: string
	series: TrendSeries[]
}

export type ExecutorSummary = {
	label: string
	last_activity_at: string | null
	last_synchronized_at: string | null
	credential_state: 'active' | 'revoked' | 'not-applicable'
}

export type DashboardReport = {
	schema_version: 1
	as_of: string
	timezone: string
	available_projects: string[]
	available_executors: string[]
	overall: Panel<OverallSummary>
	timeline: Panel<Timeline>
	trend: Panel<Trend>
	executors: Panel<ExecutorSummary[]>
}

export type DashboardSelection = {
	projects: string[]
	executors: string[]
	range:
		| { preset: 7 | 30 | 90 }
		| { preset: 'custom'; start_date: string; end_date: string }
}

export interface DashboardTransport {
	load(selection: DashboardSelection): Promise<DashboardReport>
}
