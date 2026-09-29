/**
 * The synthetic day behind every number in the explainer.
 *
 * All events are invented. The first three turns repeat the landing-page
 * illustration, so the site and the video agree. The real service code
 * computes every total from these events; nothing here is hand-summed.
 */
import { buildGlobalIntervals, buildSessionIntervals, type Interval } from '../../../service/aggregation.ts'
import { buildDashboardReport, type DashboardReportStore } from '../../../service/dashboard/report-builder.ts'
import { renderDashboardDocument } from '../../../service/dashboard/render.ts'
import type { DashboardSelection } from '../../../service/dashboard/report.ts'
import type { AttributedStoredWorkEvent } from '../../../service/types.ts'

const minute = 60_000

/** A Tuesday in the service timezone (Asia/Jakarta, UTC+7, no daylight saving). */
export const civilDate = '2026-09-15'
const at = (clock: string) => Date.parse(`${civilDate}T${clock}:00+07:00`)

/** The report is taken in the evening, after the last turn and its grace period. */
export const nowMs = at('20:45')

/** One Amp turn: `end` is null when the turn never reported an end. */
export type SyntheticTurn = { start: string; end: string | null; machine: string; project: string }

export const turns: SyntheticTurn[] = [
	// The landing-page example.
	{ start: '09:10', end: '09:25', machine: 'laptop', project: 'garden' },
	{ start: '09:32', end: '09:50', machine: 'laptop', project: 'garden' },
	{ start: '10:40', end: '10:52', machine: 'laptop', project: 'garden' },
	// The rest of the day.
	{ start: '11:30', end: '12:20', machine: 'laptop', project: 'garden' },
	{ start: '13:30', end: '15:10', machine: 'laptop', project: 'garden' },
	// Parallel work on a second machine. It overlaps and counts once.
	{ start: '14:00', end: '14:40', machine: 'desktop', project: 'lantern' },
	{ start: '15:40', end: '17:30', machine: 'desktop', project: 'lantern' },
	{ start: '18:30', end: '19:40', machine: 'laptop', project: 'garden' },
	// A turn that never reported an end counts only its first 15 minutes.
	{ start: '20:10', end: null, machine: 'laptop', project: 'garden' },
]

export const events: AttributedStoredWorkEvent[] = turns.flatMap((turn, index) => {
	const n = index + 1
	const event = (kind: 'agent.start' | 'agent.end', sequence: number, ms: number): AttributedStoredWorkEvent => ({
		schemaVersion: 2,
		projectSlug: turn.project,
		eventId: `00000000-0000-7000-8000-${String(n * 10 + sequence).padStart(12, '0')}`,
		sourceInstance: `synthetic-${turn.machine}`,
		sourceSequence: sequence,
		sessionId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`,
		kind,
		occurredAt: new Date(ms).toISOString(),
		occurredAtMs: ms,
		receivedAt: new Date(ms + minute).toISOString(),
		receivedAtMs: ms + minute,
		executorLabel: turn.machine,
	})
	const start = event('agent.start', 1, at(turn.start))
	return turn.end === null ? [start] : [start, event('agent.end', 2, at(turn.end))]
})

const store: DashboardReportStore = {
	events: () => events.map(({ executorLabel: _, ...event }) => event),
	attributedEvents: () => events,
	targetOverrides: () => new Map(),
	listBearerMetadata: () => [
		{ executorLabel: 'laptop', revokedAt: null },
		{ executorLabel: 'desktop', revokedAt: null },
	],
}

const selection: DashboardSelection = { projects: [], executors: [], range: { preset: 7 } }

export const report = buildDashboardReport(store, selection, nowMs)

/** The real signed-in dashboard document for the synthetic day. */
export function dashboardDocument(): string {
	return renderDashboardDocument(report, selection)
}

const clock = (ms: number) =>
	new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Asia/Jakarta',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).format(new Date(ms))

const minutes = (intervals: readonly Interval[]) =>
	intervals.reduce((sum, interval) => sum + (interval.endMs - interval.startMs) / minute, 0)

/** Morning window shown in the explainer: the three landing-page turns. */
function morning() {
	const morningEvents = events.filter((event) => event.occurredAtMs < at('11:00'))
	const sessions = buildSessionIntervals(morningEvents, nowMs)
	const union = buildGlobalIntervals(morningEvents, nowMs)
	return {
		turns: turns.slice(0, 3).map((turn, index) => ({
			start: turn.start,
			end: turn.end,
			countedUntil: clock(sessions[index]!.endMs),
		})),
		union: union.map((interval) => ({ start: clock(interval.startMs), end: clock(interval.endMs) })),
		minutes: minutes(union),
	}
}

/** Everything the animation needs, as plain data. */
export function explainerData() {
	const today = report.overall.state === 'unavailable' ? null : report.overall.data.today
	if (!today) throw new Error('The synthetic report has no Today summary')
	const union = buildGlobalIntervals(events, nowMs)
	return {
		civilDate,
		timezone: report.timezone,
		asOf: clock(nowMs),
		morning: morning(),
		day: {
			turns: turns.map((turn, index) => ({ ...turn, index })),
			union: union.map((interval) => ({ start: clock(interval.startMs), end: clock(interval.endMs) })),
			minutes: minutes(union),
		},
		today,
	}
}
