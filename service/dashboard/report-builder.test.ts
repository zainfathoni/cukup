import { describe, expect, test } from 'bun:test'
import type { AttributedStoredWorkEvent, StoredWorkEvent } from '../types.ts'
import {
	availableDashboardLabels,
	buildDashboardReport,
	parseDashboardSelection,
	trackPeriod,
	type DashboardReportStore,
} from './report-builder.ts'
import type { DashboardSelection, TimelineLane, TrendSeries } from './report.ts'

const minute = 60_000
const now = Date.parse('2026-08-31T05:00:00.000Z') // Monday noon in Jakarta

type Credential = ReturnType<DashboardReportStore['listBearerMetadata']>[number]

function session(options: {
	index: number
	source: string
	project?: string
	executor: string
	start: number
	end?: number
	schema?: 1 | 2
	receivedOffset?: number
}): AttributedStoredWorkEvent[] {
	const schemaVersion = options.schema ?? (options.project ? 2 : 1)
	const event = (
		kind: 'agent.start' | 'agent.end',
		sequence: number,
		at: number,
	): AttributedStoredWorkEvent => ({
		schemaVersion,
		...(options.project ? { projectSlug: options.project } : {}),
		eventId: `00000000-0000-7000-8000-${String(options.index * 10 + sequence).padStart(12, '0')}`,
		sourceInstance: options.source,
		sourceSequence: sequence,
		sessionId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(options.index).padStart(12, '0')}`,
		kind,
		occurredAt: new Date(at).toISOString(),
		occurredAtMs: at,
		receivedAt: new Date(at + (options.receivedOffset ?? minute)).toISOString(),
		receivedAtMs: at + (options.receivedOffset ?? minute),
		executorLabel: options.executor,
	})
	const values = [event('agent.start', options.index * 2 - 1, options.start)]
	if (options.end !== undefined) values.push(event('agent.end', options.index * 2, options.end))
	return values
}

function fixture(targetOverrides = new Map<string, number>()): {
	store: DashboardReportStore
	events: AttributedStoredWorkEvent[]
	credentials: Credential[]
} {
	const base = Date.parse('2026-08-31T01:00:00.000Z')
	const events = [
		...session({
			index: 1,
			source: 'source-a',
			project: 'alpha',
			executor: 'machine-a',
			start: base,
			end: base + 60 * minute,
			receivedOffset: 5 * minute,
		}),
		...session({
			index: 2,
			source: 'source-b',
			project: 'alpha',
			executor: 'amp-orb',
			start: base + 30 * minute,
			end: base + 90 * minute,
			receivedOffset: 10 * minute,
		}),
		...session({
			index: 3,
			source: 'source-c',
			project: 'beta',
			executor: 'machine-a',
			start: base + 45 * minute,
			end: base + 75 * minute,
			receivedOffset: 20 * minute,
		}),
		...session({
			index: 4,
			source: 'source-d',
			executor: 'retired-machine',
			start: base - 24 * 60 * minute,
			end: base - 24 * 60 * minute + 5 * minute,
			schema: 1,
		}),
	]
	const credentials: Credential[] = [
		{ executorLabel: 'machine-a', revokedAt: '2026-08-01T00:00:00.000Z' },
		{ executorLabel: 'machine-a', revokedAt: null },
		{ executorLabel: 'retired-machine', revokedAt: '2026-08-02T00:00:00.000Z' },
		{ executorLabel: null, revokedAt: null },
	]
	return {
		events,
		credentials,
		store: {
			events: () => events.map(({ executorLabel: _, ...event }) => event),
			attributedEvents: () => events,
			targetOverrides: () => targetOverrides,
			listBearerMetadata: () => credentials,
		},
	}
}

function readySeries(report: ReturnType<typeof buildDashboardReport>): TrendSeries[] {
	if (report.trend.state === 'unavailable') throw new Error('Expected trend')
	return report.trend.data.series
}

/** Minutes covered by a whole lane dimension, unioned across its lanes. */
function laneUnionMinutes(lanes: readonly TimelineLane[]): number {
	const merged: Array<{ start: number; end: number }> = []
	for (const { start, end } of lanes.flatMap((lane) => lane.intervals)) {
		merged.push({ start: Date.parse(start), end: Date.parse(end) })
	}
	merged.sort((left, right) => left.start - right.start)
	let total = 0
	let cursor = -Infinity
	for (const interval of merged) {
		total += Math.max(0, interval.end - Math.max(interval.start, cursor))
		cursor = Math.max(cursor, interval.end)
	}
	return Math.floor(total / 60_000)
}

describe('dashboard selection validation', () => {
	test('accepts the three tracks and keeps omitted track compatible with All', () => {
		const labels = availableDashboardLabels(fixture().store)
		const base: DashboardSelection = { projects: [], executors: [], range: { preset: 7 } }
		for (const track of ['work', 'play', 'all'] as const) {
			expect(parseDashboardSelection({ ...base, track }, labels)).toEqual({ ...base, track })
		}
		for (const track of ['', 'WORK', 'unknown', null, [], true]) {
			expect(parseDashboardSelection({ ...base, track }, labels)).toBeUndefined()
		}
		expect(parseDashboardSelection(base, labels)).toEqual(base)
		expect(parseDashboardSelection({ ...base, track: 'all', extra: true }, labels)).toBeUndefined()
	})

	test('accepts only known labels and exact 7/30/90 or inclusive custom ranges up to 366 days', () => {
		const labels = availableDashboardLabels(fixture().store)
		expect(labels.projects).toContain('Unassigned')
		expect(labels.executors).toContain('unassigned-executor')
		expect(
			parseDashboardSelection(
				{
					projects: ['alpha'],
					executors: ['machine-a'],
					timeline_date: '2026-08-30',
					range: { preset: 30 },
				},
				labels,
			),
		).toEqual({
			projects: ['alpha'],
			executors: ['machine-a'],
			timeline_date: '2026-08-30',
			range: { preset: 30 },
		})
		expect(
			parseDashboardSelection(
				{
					projects: [],
					executors: [],
					range: { preset: 'custom', start_date: '2025-09-01', end_date: '2026-09-01' },
				},
				labels,
			),
		).toBeDefined()

		for (const invalid of [
			{ projects: [], executors: [], timeline_date: '2026-02-30', range: { preset: 7 } },
			{ projects: ['unknown'], executors: [], range: { preset: 7 } },
			{ projects: ['alpha', 'alpha'], executors: [], range: { preset: 7 } },
			{ projects: [], executors: ['unknown'], range: { preset: 7 } },
			{ projects: [], executors: [], range: { preset: 8 } },
			{ projects: [], executors: [], range: { preset: 7, extra: true } },
			{
				projects: [],
				executors: [],
				range: { preset: 'custom', start_date: '2025-08-31', end_date: '2026-09-01' },
			},
			{
				projects: [],
				executors: [],
				range: { preset: 'custom', start_date: '2026-02-30', end_date: '2026-03-01' },
			},
		]) {
			expect(parseDashboardSelection(invalid, labels)).toBeUndefined()
		}
	})
})

describe('track policy', () => {
	const monday = { year: 2026, month: 8, day: 31 }
	const none = new Map<string, number>()

	test('uses weekday Work goals and daily Play allowances on all seven days', () => {
		for (const day of [24, 25, 26, 27, 28, 29, 30]) {
			const date = { year: 2026, month: 8, day }
			const work = day < 29 ? 480 : 0
			expect(trackPeriod('work', 0, date, none).target_minutes).toBe(work)
			expect(trackPeriod('play', 0, date, none)).toMatchObject({ status: 'WITHIN', target_minutes: 60, upper_limit_minutes: 120 })
			expect(trackPeriod('all', 0, date, none)).toMatchObject({ status: 'WITHIN', target_minutes: work + 60, upper_limit_minutes: work + 120 })
		}
	})

	test('changes limit status only after each boundary, with no minimum to reach', () => {
		for (const [track, offset] of [['play', 0], ['all', 480]] as const) {
			for (const [minutes, status, difference] of [
				[0, 'WITHIN', 60], [59, 'WITHIN', 1], [60, 'WITHIN', 0],
				[61, 'TOLERANCE', 1], [120, 'TOLERANCE', 60], [121, 'EXCEEDED', 1],
			] as const) {
				expect(trackPeriod(track, offset + minutes, monday, none)).toEqual({
					status, worked_minutes: offset + minutes, target_minutes: offset + 60,
					upper_limit_minutes: offset + 120, difference_minutes: difference,
				})
			}
		}
		expect(trackPeriod('all', 0, monday, none).status).toBe('WITHIN')
		for (const [minutes, status] of [[479, 'UNDER'], [480, 'COMPLETE'], [481, 'OVER']] as const) {
			expect(trackPeriod('work', minutes, monday, none).status).toBe(status)
		}
	})

	test('sums seven daily allowances and applies Work overrides without reducing Play', () => {
		expect(trackPeriod('work', 0, monday, none, 7).target_minutes).toBe(2400)
		expect(trackPeriod('play', 0, monday, none, 7)).toMatchObject({ target_minutes: 420, upper_limit_minutes: 840 })
		expect(trackPeriod('all', 0, monday, none, 7)).toMatchObject({ target_minutes: 2820, upper_limit_minutes: 3240 })
		for (const [goal, soft, upper] of [[0, 60, 120], [240, 300, 360]] as const) {
			const overrides = new Map([['2026-08-31', goal]])
			expect(trackPeriod('work', 0, monday, overrides).target_minutes).toBe(goal)
			expect(trackPeriod('all', 0, monday, overrides)).toMatchObject({ target_minutes: soft, upper_limit_minutes: upper })
			expect(trackPeriod('play', 0, monday, overrides)).toMatchObject({ target_minutes: 60, upper_limit_minutes: 120 })
		}
	})
})

describe('dashboard report aggregation', () => {
	test('does not let Play fill a Work shortfall or weekly headroom hide a daily limit breach', () => {
		const { store, events } = fixture()
		const base = Date.parse('2026-08-31T01:00:00Z')
		events.splice(0, events.length,
			...session({ index: 1, source: 'work', project: 'bta', executor: 'machine-a', start: base, end: base + 405 * minute }),
			...session({ index: 2, source: 'play', project: 'cukup', executor: 'machine-a', start: base + 420 * minute, end: base + 525 * minute }),
		)
		const evening = Date.parse('2026-08-31T14:00:00Z')
		for (const [track, minutes, status, target, difference] of [
			['work', 420, 'UNDER', 480, 60],
			['play', 120, 'TOLERANCE', 60, 60],
			['all', 540, 'WITHIN', 540, 0],
		] as const) {
			const report = buildDashboardReport(store, { track, projects: [], executors: [], range: { preset: 7 } }, evening)
			if (report.overall.state === 'unavailable') throw new Error('Expected summary')
			expect(report.overall.data.today).toMatchObject({ worked_minutes: minutes, status, target_minutes: target, difference_minutes: difference })
		}
		// One extra minute exceeds today's Play limit even with room in the week.
		const end = events.at(-1)!
		end.occurredAtMs += minute
		end.occurredAt = new Date(end.occurredAtMs).toISOString()
		const play = buildDashboardReport(store, { track: 'play', projects: [], executors: [], range: { preset: 7 } }, evening)
		if (play.overall.state === 'unavailable' || play.trend.state === 'unavailable') throw new Error('Expected panels')
		expect(play.overall.data.today.status).toBe('EXCEEDED')
		expect(play.overall.data.week.status).toBe('WITHIN')
		expect(play.trend.data.days.at(-1)!.period.status).toBe('EXCEEDED')
	})

	test('partitions sessions by exact start project before union, with Unassigned in Play', () => {
		const { store, events } = fixture()
		for (const event of events) {
			if (event.sourceInstance === 'source-a') event.projectSlug = 'bta'
			if (event.sourceInstance === 'source-b') event.projectSlug = 'bta-notes'
			if (event.sourceInstance === 'source-c') event.projectSlug = 'bta-notes-extra'
		}
		// Attribution belongs to the start, even if an end has a different label.
		events.find((event) => event.sourceInstance === 'source-a' && event.kind === 'agent.end')!.projectSlug = 'other'
		const base = Date.parse('2026-08-31T01:00:00.000Z')
		events.push(...session({ index: 5, source: 'unassigned', executor: 'machine-a', start: base + 120 * minute, end: base + 140 * minute }))
		const selection: DashboardSelection = { projects: [], executors: [], range: { preset: 7 } }
		// Includes the 15-minute idle grace: Work [0,105], Play [45,90] + [120,155].
		for (const [track, minutes, projects] of [
			['work', 105, ['bta', 'bta-notes']],
			['play', 80, ['bta-notes-extra', 'Unassigned']],
			['all', 140, ['bta', 'bta-notes', 'bta-notes-extra', 'Unassigned']],
		] as const) {
			const report = buildDashboardReport(store, { ...selection, track }, now)
			if (report.overall.state === 'unavailable' || report.timeline.state === 'unavailable' || report.trend.state === 'unavailable') throw new Error('Expected ready panels')
			expect(report.track).toBe(track)
			expect(report.available_projects).toEqual([...projects])
			expect(report.overall.data.today.worked_minutes).toBe(minutes)
			expect(report.overall.data.week.worked_minutes).toBe(minutes)
			expect(report.timeline.data.minutes).toBe(minutes)
			expect(report.timeline.data.week_minutes).toBe(minutes)
			expect(report.trend.data.series[0]!.points.at(-1)!.minutes).toBe(minutes)
			expect(report.trend.data.days.at(-1)!.period.worked_minutes).toBe(minutes)
			for (const period of [report.overall.data.today, report.overall.data.week, report.timeline.data.day_period, report.timeline.data.week_period, report.trend.data.days.at(-1)!.period]) {
				expect(period).toHaveProperty('target_minutes')
				if (track === 'work') expect(period).not.toHaveProperty('upper_limit_minutes')
				else expect(period).toHaveProperty('upper_limit_minutes')
			}
			const sunday = report.trend.data.days.find((day) => day.date === '2026-08-30')!
			expect(sunday.period.worked_minutes).toBe(track === 'work' ? 0 : 20)
		}
		expect(buildDashboardReport(store, selection, now)).toEqual(buildDashboardReport(store, { ...selection, track: 'all' }, now))
		const filtered = buildDashboardReport(store, { ...selection, track: 'work', projects: ['bta'], executors: ['machine-a'] }, now)
		if (filtered.overall.state === 'unavailable' || filtered.timeline.state === 'unavailable') throw new Error('Expected ready panels')
		expect(filtered.overall.data.today.worked_minutes).toBe(105)
		expect(filtered.timeline.data.minutes).toBe(75)
	})

	test('clips track time at Jakarta midnight and Monday, including sessions that cross the boundary', () => {
		const { store, events } = fixture()
		events.splice(0, events.length, ...session({
			index: 1, source: 'boundary', project: 'bta', executor: 'machine-a',
			start: Date.parse('2026-08-30T16:50:00Z'), end: Date.parse('2026-08-30T17:05:00Z'),
		}))
		for (const [track, today, sunday] of [['work', 20, 10], ['play', 0, 0]] as const) {
			const report = buildDashboardReport(store, { track, projects: [], executors: [], timeline_date: '2026-08-30', range: { preset: 7 } }, now)
			if (report.overall.state === 'unavailable' || report.timeline.state === 'unavailable' || report.trend.state === 'unavailable') throw new Error('Expected ready panels')
			expect(report.overall.data).toMatchObject({ today: { worked_minutes: today }, week: { worked_minutes: today } })
			expect(report.timeline.data.minutes).toBe(sunday)
			expect(report.timeline.data.week_minutes).toBe(sunday)
			expect(report.trend.data.days.at(-1)!.period).toMatchObject({ worked_minutes: today })
			expect(report.timeline.data.day_period.target_minutes).toBe(track === 'work' ? 0 : 60)
			expect(report.overall.data.today.target_minutes).toBe(track === 'work' ? 480 : 60)
		}
	})

	test('keeps global targets and trend globally unioned while OR/AND selections union underlying intervals', () => {
		const selection: DashboardSelection = {
			projects: ['alpha', 'beta'],
			executors: ['machine-a'],
			range: { preset: 7 },
		}
		const report = buildDashboardReport(fixture().store, selection, now)
		expect(report.overall.state).toBe('ready')
		if (report.overall.state === 'unavailable') throw new Error('Expected overall summary')
		expect(report.overall.data.today.worked_minutes).toBe(105)
		expect(report.overall.data.today.target_minutes).toBe(540)

		const series = readySeries(report)
		const today = (kind: TrendSeries['kind'], label?: string) =>
			series.find((value) => value.kind === kind && (label === undefined || value.label === label))!
				.points.at(-1)!.minutes
		expect(today('overall')).toBe(105)
		expect(today('project', 'alpha')).toBe(75)
		expect(today('project', 'beta')).toBe(45)
		expect(today('executor', 'machine-a')).toBe(90)
		expect(today('combined')).toBe(90)
		for (const targetless of series.filter((value) => value.kind !== 'overall')) {
			expect(targetless).not.toHaveProperty('status')
			expect(targetless).not.toHaveProperty('target_minutes')
		}
	})

	test('applies and clears overrides in the authoritative current summary without changing trend work', () => {
		const targetOverrides = new Map([['2026-08-31', 0]])
		const selection: DashboardSelection = { projects: [], executors: [], range: { preset: 7 } }
		const dayOff = buildDashboardReport(fixture(targetOverrides).store, selection, now)
		if (dayOff.overall.state === 'unavailable') throw new Error('Expected overall summary')
		expect(dayOff.overall.data.today).toMatchObject({ status: 'TOLERANCE', target_minutes: 60, upper_limit_minutes: 120 })
		expect(dayOff.overall.data.week.target_minutes).toBe(2_340)

		targetOverrides.set('2026-08-31', 240)
		const halfDay = buildDashboardReport(fixture(targetOverrides).store, selection, now)
		if (halfDay.overall.state === 'unavailable') throw new Error('Expected overall summary')
		expect(halfDay.overall.data.today).toMatchObject({
			status: 'WITHIN',
			worked_minutes: 105,
			target_minutes: 300,
			upper_limit_minutes: 360,
			difference_minutes: 195,
		})
		expect(halfDay.overall.data.week.target_minutes).toBe(2_580)

		targetOverrides.clear()
		const restored = buildDashboardReport(fixture(targetOverrides).store, selection, now)
		if (restored.overall.state === 'unavailable') throw new Error('Expected overall summary')
		expect(restored.overall.data.today).toMatchObject({ status: 'WITHIN', target_minutes: 540, upper_limit_minutes: 600 })
		expect(restored.overall.data.week.target_minutes).toBe(2_820)
		expect(readySeries(restored)).toEqual(readySeries(dayOff))
		expect(readySeries(halfDay)).toEqual(readySeries(dayOff))
	})

	test('derives concurrency from matching raw intervals instead of displayed-series sums', () => {
		const report = buildDashboardReport(
			fixture().store,
			{ projects: ['alpha', 'beta'], executors: ['machine-a'], range: { preset: 7 } },
			now,
		)
		if (report.timeline.state === 'unavailable') throw new Error('Expected timeline')
		expect(report.timeline.data.intervals.map(({ concurrency, start, end }) => ({
			concurrency,
			start: Date.parse(start),
			end: Date.parse(end),
		}))).toEqual([
			{
				concurrency: 1,
				start: Date.parse('2026-08-31T01:00:00.000Z'),
				end: Date.parse('2026-08-31T01:45:00.000Z'),
			},
			{
				concurrency: 2,
				start: Date.parse('2026-08-31T01:45:00.000Z'),
				end: Date.parse('2026-08-31T02:15:00.000Z'),
			},
			{
				concurrency: 1,
				start: Date.parse('2026-08-31T02:15:00.000Z'),
				end: Date.parse('2026-08-31T02:30:00.000Z'),
			},
		])
	})

	test('limits filter labels to activity in the selected ISO week', () => {
		const value = fixture()
		value.events.push(
			...session({
				index: 5,
				source: 'source-e',
				project: 'ends-at-boundary',
				executor: 'boundary-machine',
				start: Date.parse('2026-08-30T16:30:00.000Z'),
				end: Date.parse('2026-08-30T16:45:00.000Z'),
			}),
			...session({
				index: 6,
				source: 'source-f',
				project: 'crosses-boundary',
				executor: 'crossing-machine',
				start: Date.parse('2026-08-30T16:46:00.000Z'),
				end: Date.parse('2026-08-30T16:47:00.000Z'),
			}),
		)
		const report = buildDashboardReport(
			value.store,
			{ projects: [], executors: [], range: { preset: 7 } },
			now,
		)
		expect(report.timeline_date).toBe('2026-08-31')
		expect(report.available_projects).toEqual(['alpha', 'beta', 'crosses-boundary'])
		expect(report.available_executors).toEqual(['amp-orb', 'crossing-machine', 'machine-a'])

		const historical = buildDashboardReport(
			value.store,
			{
				projects: [],
				executors: [],
				timeline_date: '2026-08-30',
				range: { preset: 7 },
			},
			now,
		)
		expect(historical.timeline_date).toBe('2026-08-30')
		expect(historical.available_projects).toEqual([
			'crosses-boundary',
			'ends-at-boundary',
			'Unassigned',
		])
		expect(historical.available_executors).toEqual([
			'boundary-machine',
			'crossing-machine',
			'retired-machine',
		])
	})

	test('reports mixed-v1/v2 attribution and separate activity/synchronization and lineage states', () => {
		const report = buildDashboardReport(
			fixture().store,
			{ projects: [], executors: [], range: { preset: 7 } },
			now,
		)
		if (report.executors.state === 'unavailable') throw new Error('Expected executors')
		expect(report.executors.data.find((value) => value.label === 'machine-a')).toEqual({
			label: 'machine-a',
			last_activity_at: '2026-08-31T02:15:00.000Z',
			last_synchronized_at: '2026-08-31T02:35:00.000Z',
			credential_state: 'active',
		})
		expect(report.executors.data.find((value) => value.label === 'retired-machine')).toMatchObject({
			credential_state: 'revoked',
			last_activity_at: '2026-08-30T01:05:00.000Z',
		})
		expect(report.executors.data.find((value) => value.label === 'amp-orb')).toMatchObject({
			credential_state: 'not-applicable',
		})
		expect(report.executors.data.find((value) => value.label === 'unassigned-executor')).toEqual({
			label: 'unassigned-executor',
			last_activity_at: null,
			last_synchronized_at: null,
			credential_state: 'active',
		})
	})

	test('builds project and executor lanes that cover the same time without overlapping themselves', () => {
		const report = buildDashboardReport(
			fixture().store,
			{ projects: [], executors: [], range: { preset: 7 } },
			now,
		)
		if (report.timeline.state === 'unavailable') throw new Error('Expected timeline')
		const timeline = report.timeline.data
		expect(timeline.minutes).toBe(105)
		expect(timeline.week).toBe('2026-W36')
		expect(timeline.week_minutes).toBe(105)
		expect(timeline.lanes.map((lane) => `${lane.kind}:${lane.label}`)).toEqual([
			'project:alpha',
			'project:beta',
			'executor:machine-a',
			'executor:amp-orb',
		])
		expect(timeline.lanes.map((lane) => lane.minutes)).toEqual([105, 45, 90, 75])

		for (const lane of timeline.lanes) {
			for (let index = 1; index < lane.intervals.length; index += 1) {
				expect(Date.parse(lane.intervals[index]!.start)).toBeGreaterThan(
					Date.parse(lane.intervals[index - 1]!.end),
				)
			}
		}

		const projects = timeline.lanes.filter((lane) => lane.kind === 'project')
		const executors = timeline.lanes.filter((lane) => lane.kind === 'executor')
		expect(laneUnionMinutes(projects)).toBe(timeline.minutes)
		expect(laneUnionMinutes(executors)).toBe(timeline.minutes)
		// Each dimension covers the whole day, so adding its lanes overstates it.
		expect(projects.reduce((total, lane) => total + lane.minutes, 0)).toBeGreaterThan(timeline.minutes)
		expect(executors.reduce((total, lane) => total + lane.minutes, 0)).toBeGreaterThan(timeline.minutes)
	})

	test('builds the activity timeline for the selected historical date', () => {
		const targetOverrides = new Map([['2026-08-26', 240]])
		const report = buildDashboardReport(
			fixture(targetOverrides).store,
			{ projects: [], executors: [], timeline_date: '2026-08-30', range: { preset: 7 } },
			now,
		)
		if (report.timeline.state === 'unavailable') throw new Error('Expected timeline')
		expect(report.timeline.data.date).toBe('2026-08-30')
		expect(report.timeline.data.week).toBe('2026-W35')
		expect(report.timeline.data.minutes).toBe(20)
		expect(report.timeline.data.week_minutes).toBe(20)
		expect(report.timeline.data.day_period).toEqual({
			status: 'WITHIN',
			worked_minutes: 20,
			target_minutes: 60,
			upper_limit_minutes: 120,
			difference_minutes: 40,
		})
		expect(report.timeline.data.week_period).toEqual({
			status: 'WITHIN',
			worked_minutes: 20,
			target_minutes: 2_580,
			upper_limit_minutes: 3_000,
			difference_minutes: 2_560,
		})
		expect(report.timeline.data.lanes.map((lane) => `${lane.kind}:${lane.label}`)).toEqual([
			'project:Unassigned',
			'executor:retired-machine',
		])
	})

	test('applies and clears an override on the selected historical day without changing worked totals', () => {
		const targetOverrides = new Map([['2026-08-30', 60]])
		const value = fixture(targetOverrides)
		const selection: DashboardSelection = {
			projects: [],
			executors: [],
			timeline_date: '2026-08-30',
			range: { preset: 7 },
		}
		const overridden = buildDashboardReport(value.store, selection, now)
		if (overridden.timeline.state === 'unavailable') throw new Error('Expected timeline')
		expect(overridden.timeline.data.day_period).toEqual({
			status: 'WITHIN',
			worked_minutes: 20,
			target_minutes: 120,
			upper_limit_minutes: 180,
			difference_minutes: 100,
		})
		expect({
			minutes: overridden.timeline.data.minutes,
			week_minutes: overridden.timeline.data.week_minutes,
		}).toEqual({ minutes: 20, week_minutes: 20 })

		targetOverrides.clear()
		const restored = buildDashboardReport(value.store, selection, now)
		if (restored.timeline.state === 'unavailable') throw new Error('Expected timeline')
		expect(restored.timeline.data.day_period).toEqual({
			status: 'WITHIN',
			worked_minutes: 20,
			target_minutes: 60,
			upper_limit_minutes: 120,
			difference_minutes: 40,
		})
		expect({
			minutes: restored.timeline.data.minutes,
			week_minutes: restored.timeline.data.week_minutes,
		}).toEqual({ minutes: 20, week_minutes: 20 })
	})

	test('reports filtered time for the selected date and its ISO week, including week-only activity', () => {
		const value = fixture()
		value.events.push(
			...session({
				index: 5,
				source: 'source-e',
				project: 'alpha',
				executor: 'machine-a',
				start: Date.parse('2026-08-29T01:00:00.000Z'),
				end: Date.parse('2026-08-29T01:15:00.000Z'),
			}),
		)
		const report = buildDashboardReport(
			value.store,
			{ projects: [], executors: [], timeline_date: '2026-08-30', range: { preset: 7 } },
			now,
		)
		if (report.timeline.state === 'unavailable') throw new Error('Expected timeline')
		expect(report.timeline.data).toMatchObject({
			date: '2026-08-30',
			week: '2026-W35',
			minutes: 20,
			week_minutes: 50,
		})
	})

	test('uses the full ISO week across a calendar-year boundary independently of trend range', () => {
		const selection: DashboardSelection = {
			projects: [],
			executors: [],
			timeline_date: '2021-01-01',
			range: { preset: 'custom', start_date: '2026-08-31', end_date: '2026-08-31' },
		}
		const insideOnly = new Map([['2021-01-03', 240]])
		const beforeBoundary = new Map([...insideOnly, ['2020-12-27', 240]])
		const outsideBothBoundaries = new Map([...beforeBoundary, ['2021-01-04', 0]])
		const report = buildDashboardReport(fixture(outsideBothBoundaries).store, selection, now)
		if (report.timeline.state === 'unavailable') throw new Error('Expected timeline')
		expect(report.timeline.data.week).toBe('2020-W53')
		// Work contributes 2640m; seven daily allowances add 420m and 840m.
		expect(report.timeline.data.week_period).toEqual({
			status: 'WITHIN',
			worked_minutes: 0,
			target_minutes: 3_060,
			upper_limit_minutes: 3_480,
			difference_minutes: 3_060,
		})
		for (const overrides of [insideOnly, beforeBoundary]) {
			const boundaryReport = buildDashboardReport(fixture(overrides).store, selection, now)
			if (boundaryReport.timeline.state === 'unavailable') throw new Error('Expected timeline')
			expect(boundaryReport.timeline.data.week_period.target_minutes).toBe(3_060)
		}
		if (report.trend.state === 'unavailable') throw new Error('Expected trend')
		expect([report.trend.data.start_date, report.trend.data.end_date]).toEqual([
			'2026-08-31',
			'2026-08-31',
		])
	})

	test('restricts lanes to the selection without changing the globally unioned day details', () => {
		const selected = buildDashboardReport(
			fixture().store,
			{ projects: ['beta'], executors: [], range: { preset: 7 } },
			now,
		)
		if (selected.timeline.state === 'unavailable') throw new Error('Expected timeline')
		expect(selected.timeline.data.lanes.map((lane) => `${lane.kind}:${lane.label}`)).toEqual([
			'project:beta',
			'executor:machine-a',
		])
		expect(selected.timeline.data.minutes).toBe(45)
		expect(selected.timeline.data.day_period).toMatchObject({
			worked_minutes: 45,
			target_minutes: 540,
			status: 'WITHIN',
		})
		expect(selected.timeline.data.week_period).toMatchObject({
			worked_minutes: 45,
			target_minutes: 2_820,
			status: 'WITHIN',
		})

		if (selected.trend.state === 'unavailable') throw new Error('Expected trend')
		const today = selected.trend.data.days.at(-1)!
		expect(today.period.worked_minutes).toBe(105)
		expect(today.projects).toEqual([
			{ label: 'alpha', minutes: 105 },
			{ label: 'beta', minutes: 45 },
		])
	})

	test('gives every heatmap day a target-bearing verdict and a non-additive breakdown', () => {
		const report = buildDashboardReport(
			fixture().store,
			{ projects: [], executors: [], range: { preset: 7 } },
			now,
		)
		if (report.trend.state === 'unavailable') throw new Error('Expected trend')
		const days = report.trend.data.days
		const overall = readySeries(report).find((series) => series.kind === 'overall')!
		expect(days.map((day) => day.date)).toEqual(overall.points.map((point) => point.date))
		expect(days.map((day) => day.period.worked_minutes)).toEqual(
			overall.points.map((point) => point.minutes),
		)

		const today = days.at(-1)!
		expect(today).toMatchObject({
			date: '2026-08-31',
			interval_count: 1,
			first_activity_at: '2026-08-31T01:00:00.000Z',
			last_activity_at: '2026-08-31T02:45:00.000Z',
		})
		expect(today.period).toEqual({
			status: 'WITHIN',
			worked_minutes: 105,
			target_minutes: 540,
			upper_limit_minutes: 600,
			difference_minutes: 435,
		})
		expect(today.executors).toEqual([
			{ label: 'machine-a', minutes: 90 },
			{ label: 'amp-orb', minutes: 75 },
		])

		// Sunday still allows Play, so a short session stays within the limit.
		const sunday = days.find((day) => day.date === '2026-08-30')!
		expect(sunday.period).toEqual({
			status: 'WITHIN',
			worked_minutes: 20,
			target_minutes: 60,
			upper_limit_minutes: 120,
			difference_minutes: 40,
		})
		expect(sunday.projects).toEqual([{ label: 'Unassigned', minutes: 20 }])

		const idle = days.find((day) => day.date === '2026-08-27')!
		expect(idle).toMatchObject({ interval_count: 0, first_activity_at: null, last_activity_at: null })
		expect(idle.period.status).toBe('WITHIN')
		expect(idle.projects).toEqual([])
	})

	test('applies exact-date target overrides to heatmap day details', () => {
		const overrides = new Map([['2026-08-31', 0]])
		const report = buildDashboardReport(
			fixture(overrides).store,
			{ projects: [], executors: [], range: { preset: 7 } },
			now,
		)
		if (report.trend.state === 'unavailable') throw new Error('Expected trend')
		expect(report.trend.data.days.at(-1)!.period).toEqual({
			status: 'TOLERANCE',
			worked_minutes: 105,
			target_minutes: 60,
			upper_limit_minutes: 120,
			difference_minutes: 45,
		})
	})

	test('marks independently failed panels unavailable instead of replacing them with zero', () => {
		const value = fixture()
		const store: DashboardReportStore = {
			...value.store,
			events: () => {
				throw new Error('summary query failure')
			},
		}
		const report = buildDashboardReport(
			store,
			{ projects: [], executors: [], range: { preset: 7 } },
			now,
		)
		expect(report.overall).toEqual({
			state: 'unavailable',
			message: 'Working-time summary is unavailable.',
		})
		expect(report.timeline.state).toBe('ready')
		expect(report.trend.state).toBe('ready')
		expect(report.executors.state).toBe('ready')
	})
})
