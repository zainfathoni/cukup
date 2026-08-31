import type { DashboardReport, DashboardSelection, DashboardTransport } from './report.ts'

export const mockDashboardReport: DashboardReport = {
	schema_version: 1,
	as_of: '2026-08-31T09:42:00.000Z',
	timezone: 'Asia/Jakarta',
	available_projects: ['cukup', 'personal-site', 'Unassigned'],
	available_executors: ['amp-orb', 'nixos-workstation', 'unassigned-executor'],
	overall: {
		state: 'ready',
		data: {
			today: { status: 'UNDER', worked_minutes: 326, target_minutes: 480, difference_minutes: 154 },
			week: { status: 'UNDER', worked_minutes: 326, target_minutes: 2400, difference_minutes: 2074 },
		},
	},
	timeline: {
		state: 'ready',
		data: {
			date: '2026-08-31',
			intervals: [
				{ start: '2026-08-31T01:15:00.000Z', end: '2026-08-31T03:05:00.000Z', concurrency: 1 },
				{ start: '2026-08-31T04:00:00.000Z', end: '2026-08-31T05:20:00.000Z', concurrency: 2 },
				{ start: '2026-08-31T07:10:00.000Z', end: '2026-08-31T08:46:00.000Z', concurrency: 1 },
			],
		},
	},
	trend: {
		state: 'ready',
		data: {
			start_date: '2026-08-25',
			end_date: '2026-08-31',
			series: [
				{
					kind: 'overall',
					label: 'Overall working time',
					points: [410, 505, 472, 538, 386, 64, 326].map((minutes, index) => ({
						date: `2026-08-${String(25 + index).padStart(2, '0')}`,
						minutes,
					})),
				},
				{
					kind: 'project',
					label: 'cukup',
					points: [120, 205, 188, 240, 90, 44, 260].map((minutes, index) => ({
						date: `2026-08-${String(25 + index).padStart(2, '0')}`,
						minutes,
					})),
				},
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
				last_activity_at: '2026-08-31T08:46:00.000Z',
				last_synchronized_at: '2026-08-31T08:46:08.000Z',
				credential_state: 'not-applicable',
			},
			{
				label: 'nixos-workstation',
				last_activity_at: '2026-08-30T12:18:00.000Z',
				last_synchronized_at: '2026-08-30T12:20:11.000Z',
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
