import { describe, expect, test } from 'bun:test'
import type { AttributedStoredWorkEvent, StoredWorkEvent } from '../types.ts'
import type { ShadowDisclosureLane } from '../shadow-disclosures.ts'
import {
	availableDashboardLabels,
	buildDashboardReport,
	parseDashboardSelection,
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
			shadowDisclosures: () => ({
				delivery: { availability: 'ready', disclosures: [] },
				labels: new Map(),
			}),
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

describe('dashboard report aggregation', () => {
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
		expect(report.overall.data.today.target_minutes).toBe(480)

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

	test('applies and clears overrides only in the authoritative overall target panel', () => {
		const targetOverrides = new Map([['2026-08-31', 0]])
		const selection: DashboardSelection = { projects: [], executors: [], range: { preset: 7 } }
		const dayOff = buildDashboardReport(fixture(targetOverrides).store, selection, now)
		if (dayOff.overall.state === 'unavailable') throw new Error('Expected overall summary')
		expect(dayOff.overall.data.today).toMatchObject({ status: 'OVER', target_minutes: 0 })
		expect(dayOff.overall.data.week.target_minutes).toBe(1_920)

		targetOverrides.set('2026-08-31', 240)
		const halfDay = buildDashboardReport(fixture(targetOverrides).store, selection, now)
		if (halfDay.overall.state === 'unavailable') throw new Error('Expected overall summary')
		expect(halfDay.overall.data.today).toMatchObject({
			status: 'UNDER',
			worked_minutes: 105,
			target_minutes: 240,
			difference_minutes: 135,
		})
		expect(halfDay.overall.data.week.target_minutes).toBe(2_160)

		targetOverrides.clear()
		const restored = buildDashboardReport(fixture(targetOverrides).store, selection, now)
		if (restored.overall.state === 'unavailable') throw new Error('Expected overall summary')
		expect(restored.overall.data.today).toMatchObject({ status: 'UNDER', target_minutes: 480 })
		expect(restored.overall.data.week.target_minutes).toBe(2_400)
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

	test('reports mixed-v1/v2 attribution and separate activity/synchronization and lineage states', () => {
		const report = buildDashboardReport(
			fixture().store,
			{ projects: [], executors: [], range: { preset: 7 } },
			now,
		)
		expect(report.available_projects).toEqual(['alpha', 'beta', 'Unassigned'])
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
		const report = buildDashboardReport(
			fixture().store,
			{ projects: [], executors: [], timeline_date: '2026-08-30', range: { preset: 7 } },
			now,
		)
		if (report.timeline.state === 'unavailable') throw new Error('Expected timeline')
		expect(report.timeline.data.date).toBe('2026-08-30')
		expect(report.timeline.data.minutes).toBe(20)
		expect(report.timeline.data.lanes.map((lane) => `${lane.kind}:${lane.label}`)).toEqual([
			'project:Unassigned',
			'executor:retired-machine',
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
			status: 'UNDER',
			worked_minutes: 105,
			target_minutes: 480,
			difference_minutes: 375,
		})
		expect(today.executors).toEqual([
			{ label: 'machine-a', minutes: 90 },
			{ label: 'amp-orb', minutes: 75 },
		])

		// Sunday carries a zero target, so a short session reads as OVER.
		const sunday = days.find((day) => day.date === '2026-08-30')!
		expect(sunday.period).toEqual({
			status: 'OVER',
			worked_minutes: 20,
			target_minutes: 0,
			difference_minutes: 20,
		})
		expect(sunday.projects).toEqual([{ label: 'Unassigned', minutes: 20 }])

		const idle = days.find((day) => day.date === '2026-08-27')!
		expect(idle).toMatchObject({ interval_count: 0, first_activity_at: null, last_activity_at: null })
		expect(idle.period.status).toBe('UNDER')
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
			status: 'OVER',
			worked_minutes: 105,
			target_minutes: 0,
			difference_minutes: 105,
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
		expect(report.shadow_disclosures.state).toBe('ready')
	})

	test('sanitizes asymmetric ready disclosure lanes without coupling them to totals', () => {
		const value = fixture()
		const lane = (
			collector: string,
			site: string,
			synchronization: ShadowDisclosureLane['synchronization'],
		): ShadowDisclosureLane => ({
			collectorId: collector,
			executionSiteId: site,
			startMs: now - 2 * minute,
			endMs: now,
			capabilityIntervals: [{
				startMs: now - 2 * minute,
				endMs: now,
				workingTimeV1: {
					status: 'declared_limited',
					missingCapabilities: ['engagement.composition'],
					missingRecoveryCapabilities: ['recovery.engagement.composition'],
				},
				agentRuntimeV1: {
					status: 'declared_for_scope',
					missingRecoveryCapabilities: ['recovery.execution_end.native'],
				},
			}],
			collectionIntegrity: {
				otherwise: 'unknown',
				losses: [{
					status: 'known_loss',
					factId: `fact-${collector}`,
					startMs: now - minute,
					endMs: now,
					capabilities: ['engagement.submission'],
					reason: 'operator_discard',
				}],
			},
			executionClosure: {
				status: 'pending',
				starts: [{ evidenceId: `evidence-${collector}`, segmentId: `segment-${collector}`, startMs: now - minute }],
			},
			synchronization,
		})
		const states: ShadowDisclosureLane['synchronization'][] = ['clear', 'queued', 'retrying', 'blocked', 'unknown']
		const disclosures = states.map((state, index) => lane(`collector-${index}`, `site-${index}`, state))
		const report = buildDashboardReport({
			...value.store,
			shadowDisclosures: (bounds) => {
				expect(bounds).toEqual({
					startMs: Date.parse('2026-08-24T17:00:00.000Z'),
					endMs: now,
				})
				return {
					delivery: { availability: 'ready', disclosures },
					labels: new Map([
						['site-0', 'machine-a'],
						['site-1', 'machine-b'],
					]),
				}
			},
		}, { projects: [], executors: [], range: { preset: 7 } }, now)
		expect(report.schema_version).toBe(2)
		expect(report.shadow_disclosures.state).toBe('ready')
		if (report.shadow_disclosures.state !== 'ready') throw new Error('Expected disclosures')
		expect(report.shadow_disclosures.data.lanes.map((entry) => [entry.label, entry.synchronization])).toEqual([
			['machine-a', 'clear'],
			['machine-b', 'queued'],
			['Shadow collector · collector 1', 'retrying'],
			['Shadow collector · collector 2', 'blocked'],
			['Shadow collector · collector 3', 'unknown'],
		])
		const first = report.shadow_disclosures.data.lanes[0]!
		expect(first.known_losses).toEqual([{
			start: '2026-08-31T04:59:00.000Z',
			end: '2026-08-31T05:00:00.000Z',
			capabilities: ['engagement.submission'],
			reason: 'operator_discard',
		}])
		expect(first.pending_execution).toEqual({ status: 'pending', started_at: ['2026-08-31T04:59:00.000Z'] })
		const serialized = JSON.stringify(report.shadow_disclosures)
		for (const prohibited of ['collector-0', 'site-0', 'fact-', 'evidence-', 'segment-', 'records', 'bytes']) {
			expect(serialized).not.toContain(prohibited)
		}
		if (report.overall.state !== 'ready') throw new Error('Expected legacy overall')
		expect(report.overall.data.today.worked_minutes).toBe(105)
	})

	test('keeps empty-ready and disclosure failure distinct while other panels remain independent', () => {
		const value = fixture()
		const empty = buildDashboardReport(value.store, { projects: [], executors: [], range: { preset: 7 } }, now)
		expect(empty.shadow_disclosures).toEqual({
			state: 'ready',
			data: {
				start: '2026-08-24T17:00:00.000Z',
				end: '2026-08-31T05:00:00.000Z',
				lanes: [],
			},
		})
		const unavailable = buildDashboardReport({
			...value.store,
			shadowDisclosures: () => { throw new Error('shadow query failure') },
		}, { projects: [], executors: [], range: { preset: 7 } }, now)
		expect(unavailable.shadow_disclosures).toEqual({
			state: 'unavailable',
			message: 'Shadow disclosures are unavailable.',
		})
		expect(unavailable.overall.state).toBe('ready')
		expect(unavailable.timeline.state).toBe('ready')
		expect(unavailable.trend.state).toBe('ready')
		expect(unavailable.executors.state).toBe('ready')
	})

	test('does not misreport a wholly future custom disclosure window as ready-empty', () => {
		const value = fixture()
		let queried = false
		const report = buildDashboardReport({
			...value.store,
			shadowDisclosures: () => {
				queried = true
				return { delivery: { availability: 'ready', disclosures: [] }, labels: new Map() }
			},
		}, {
			projects: [],
			executors: [],
			range: { preset: 'custom', start_date: '2026-09-01', end_date: '2026-09-02' },
		}, now)
		expect(queried).toBeFalse()
		expect(report.shadow_disclosures).toEqual({
			state: 'unavailable',
			message: 'The selected disclosure window has not started.',
		})
	})
})
