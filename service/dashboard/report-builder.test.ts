import { describe, expect, test } from 'bun:test'
import type { AttributedStoredWorkEvent, StoredWorkEvent } from '../types.ts'
import {
	availableDashboardLabels,
	buildDashboardReport,
	parseDashboardSelection,
	type DashboardReportStore,
} from './report-builder.ts'
import type { DashboardSelection, TrendSeries } from './report.ts'

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

function fixture(): {
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
			listBearerMetadata: () => credentials,
		},
	}
}

function readySeries(report: ReturnType<typeof buildDashboardReport>): TrendSeries[] {
	if (report.trend.state === 'unavailable') throw new Error('Expected trend')
	return report.trend.data.series
}

describe('dashboard selection validation', () => {
	test('accepts only known labels and exact 7/30/90 or inclusive custom ranges up to 366 days', () => {
		const labels = availableDashboardLabels(fixture().store)
		expect(labels.projects).toContain('Unassigned')
		expect(labels.executors).toContain('unassigned-executor')
		expect(
			parseDashboardSelection(
				{ projects: ['alpha'], executors: ['machine-a'], range: { preset: 30 } },
				labels,
			),
		).toEqual({ projects: ['alpha'], executors: ['machine-a'], range: { preset: 30 } })
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
