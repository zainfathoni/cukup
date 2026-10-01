import type {
	DashboardReport,
	DashboardSelection,
	DashboardTransport,
	DayDetail,
	TrendSeries,
} from './report.ts'

const LONG_SLUG = 'deep-work-instrumentation-and-attribution'

function trendSeries(kind: TrendSeries['kind'], label: string, minutes: readonly number[]): TrendSeries {
	return {
		kind,
		label,
		points: minutes.map((value, index) => ({
			date: `2026-08-${String(25 + index).padStart(2, '0')}`,
			minutes: value,
		})),
	}
}

function dayDetail(
	date: string,
	minutes: number,
	target: number,
	spans: { count: number; first: string | null; last: string | null },
	projects: ReadonlyArray<[string, number]>,
	executors: ReadonlyArray<[string, number]>,
): DayDetail {
	const softLimit = target + 60
	const upperLimit = target + 120
	return {
		date,
		period: {
			status: minutes > upperLimit ? 'EXCEEDED' : minutes > softLimit ? 'TOLERANCE' : 'WITHIN',
			worked_minutes: minutes,
			target_minutes: softLimit,
			upper_limit_minutes: upperLimit,
			difference_minutes: Math.abs(minutes - (minutes > upperLimit ? upperLimit : softLimit)),
		},
		interval_count: spans.count,
		first_activity_at: spans.first,
		last_activity_at: spans.last,
		projects: projects.map(([label, value]) => ({ label, minutes: value })),
		executors: executors.map(([label, value]) => ({ label, minutes: value })),
	}
}

export const mockDashboardReport: DashboardReport = {
	schema_version: 1,
	as_of: '2026-08-31T09:42:00.000Z',
	timezone: 'Asia/Jakarta',
	timeline_date: '2026-08-31',
	available_projects: ['cukup', LONG_SLUG, 'personal-site', 'Unassigned'],
	available_executors: ['amp-orb', 'nixos-workstation', 'unassigned-executor'],
	overall: {
		state: 'ready',
		data: {
			today: { status: 'WITHIN', worked_minutes: 380, target_minutes: 540, upper_limit_minutes: 600, difference_minutes: 160 },
			week: { status: 'WITHIN', worked_minutes: 380, target_minutes: 2820, upper_limit_minutes: 3240, difference_minutes: 2440 },
		},
	},
	timeline: {
		state: 'ready',
		data: {
			date: '2026-08-31',
			week: '2026-W36',
			minutes: 380,
			week_minutes: 380,
			day_period: {
				status: 'WITHIN',
				worked_minutes: 380,
				target_minutes: 540,
				upper_limit_minutes: 600,
				difference_minutes: 160,
			},
			week_period: {
				status: 'WITHIN',
				worked_minutes: 380,
				target_minutes: 2_820,
				upper_limit_minutes: 3_240,
				difference_minutes: 2_440,
			},
			intervals: [
				{ start: '2026-08-31T01:15:00.000Z', end: '2026-08-31T03:05:00.000Z', concurrency: 1 },
				{ start: '2026-08-31T04:00:00.000Z', end: '2026-08-31T04:40:00.000Z', concurrency: 1 },
				{ start: '2026-08-31T04:40:00.000Z', end: '2026-08-31T05:20:00.000Z', concurrency: 2 },
				{ start: '2026-08-31T05:20:00.000Z', end: '2026-08-31T06:10:00.000Z', concurrency: 1 },
				{ start: '2026-08-31T07:10:00.000Z', end: '2026-08-31T08:20:00.000Z', concurrency: 1 },
				{ start: '2026-08-31T08:20:00.000Z', end: '2026-08-31T08:46:00.000Z', concurrency: 2 },
				{ start: '2026-08-31T08:46:00.000Z', end: '2026-08-31T09:30:00.000Z', concurrency: 1 },
			],
			lanes: [
				{
					kind: 'project',
					label: 'cukup',
					minutes: 260,
					intervals: [
						{ start: '2026-08-31T01:15:00.000Z', end: '2026-08-31T03:05:00.000Z' },
						{ start: '2026-08-31T04:00:00.000Z', end: '2026-08-31T05:20:00.000Z' },
						{ start: '2026-08-31T08:20:00.000Z', end: '2026-08-31T09:30:00.000Z' },
					],
				},
				{
					kind: 'project',
					label: LONG_SLUG,
					minutes: 90,
					intervals: [{ start: '2026-08-31T04:40:00.000Z', end: '2026-08-31T06:10:00.000Z' }],
				},
				{
					kind: 'project',
					label: 'personal-site',
					minutes: 96,
					intervals: [{ start: '2026-08-31T07:10:00.000Z', end: '2026-08-31T08:46:00.000Z' }],
				},
				{
					kind: 'executor',
					label: 'nixos-workstation',
					minutes: 190,
					intervals: [
						{ start: '2026-08-31T01:15:00.000Z', end: '2026-08-31T03:05:00.000Z' },
						{ start: '2026-08-31T04:00:00.000Z', end: '2026-08-31T05:20:00.000Z' },
					],
				},
				{
					kind: 'executor',
					label: 'amp-orb',
					minutes: 230,
					intervals: [
						{ start: '2026-08-31T04:40:00.000Z', end: '2026-08-31T06:10:00.000Z' },
						{ start: '2026-08-31T07:10:00.000Z', end: '2026-08-31T09:30:00.000Z' },
					],
				},
			],
		},
	},
	trend: {
		state: 'ready',
		data: {
			start_date: '2026-08-25',
			end_date: '2026-08-31',
			series: [
				trendSeries('overall', 'Overall working time', [410, 505, 480, 538, 386, 0, 380]),
				trendSeries('project', 'cukup', [120, 205, 188, 240, 90, 0, 260]),
			],
			days: [
				dayDetail(
					'2026-08-25',
					410,
					480,
					{ count: 4, first: '2026-08-25T01:30:00.000Z', last: '2026-08-25T11:10:00.000Z' },
					[
						['personal-site', 210],
						['cukup', 120],
						['Unassigned', 95],
					],
					[
						['nixos-workstation', 300],
						['amp-orb', 180],
					],
				),
				dayDetail(
					'2026-08-26',
					505,
					480,
					{ count: 5, first: '2026-08-26T01:05:00.000Z', last: '2026-08-26T12:40:00.000Z' },
					[
						['personal-site', 260],
						['cukup', 205],
						[LONG_SLUG, 80],
					],
					[
						['nixos-workstation', 420],
						['amp-orb', 190],
					],
				),
				dayDetail(
					'2026-08-27',
					480,
					480,
					{ count: 3, first: '2026-08-27T02:00:00.000Z', last: '2026-08-27T11:15:00.000Z' },
					[
						['personal-site', 240],
						['cukup', 188],
						['Unassigned', 60],
					],
					[
						['nixos-workstation', 300],
						['amp-orb', 260],
					],
				),
				dayDetail(
					'2026-08-28',
					538,
					480,
					{ count: 6, first: '2026-08-28T00:50:00.000Z', last: '2026-08-28T13:05:00.000Z' },
					[
						['cukup', 240],
						[LONG_SLUG, 205],
						['personal-site', 150],
					],
					[
						['nixos-workstation', 380],
						['amp-orb', 240],
					],
				),
				dayDetail(
					'2026-08-29',
					386,
					0,
					{ count: 2, first: '2026-08-29T05:30:00.000Z', last: '2026-08-29T12:20:00.000Z' },
					[
						['personal-site', 300],
						['cukup', 90],
					],
					[['amp-orb', 386]],
				),
				dayDetail('2026-08-30', 0, 0, { count: 0, first: null, last: null }, [], []),
				dayDetail(
					'2026-08-31',
					380,
					480,
					{ count: 7, first: '2026-08-31T01:15:00.000Z', last: '2026-08-31T09:30:00.000Z' },
					[
						['cukup', 260],
						['personal-site', 96],
						[LONG_SLUG, 90],
					],
					[
						['amp-orb', 230],
						['nixos-workstation', 190],
					],
				),
			],
		},
	},
	executors: {
		state: 'stale',
		last_successful_at: '2026-08-31T09:37:00.000Z',
		message: 'Executor details could not be updated. Showing the last successful values.',
		data: [
			{
				label: 'amp-orb',
				last_activity_at: '2026-08-31T09:30:00.000Z',
				last_synchronized_at: '2026-08-31T09:30:08.000Z',
				credential_state: 'not-applicable',
			},
			{
				label: 'nixos-workstation',
				last_activity_at: '2026-08-31T05:20:00.000Z',
				last_synchronized_at: '2026-08-31T05:22:11.000Z',
				credential_state: 'active',
			},
		],
	},
}

export class MockDashboardTransport implements DashboardTransport {
	readonly requests: DashboardSelection[] = []

	constructor(private readonly report: DashboardReport = mockDashboardReport) {}

	async load(selection: DashboardSelection): Promise<DashboardReport> {
		this.requests.push(structuredClone(selection))
		return structuredClone(this.report)
	}
}
