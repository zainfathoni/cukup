import { addDays, startOfZonedDay, unionIntervals, type CivilDate, type Interval } from './aggregation.ts'
import type { ProjectAttribution } from './harness-evidence-protocol.ts'
import type { ShadowRecord } from './shadow-evidence.ts'

export type ShadowInterval = Interval & {
	projectAttribution: ProjectAttribution
	executionSiteId: string
}
export type ShadowIntervals = {
	workingTimeEstimated: ShadowInterval[]
	agentRuntime: ShadowInterval[]
}
export type ShadowTotals = { workingTimeEstimatedMs: number; agentRuntimeMs: number }
export type ShadowReport = {
	asOfMs: number
	date: CivilDate
	period: 'day' | 'week'
	timezone: string
}

/** Pure internal boundary: input is a complete snapshot from Stage 5A records(), not wire data.
 * asOfMs caps duration, not knowledge: late accepted endpoints can revise earlier reports.
 */
export function buildShadowIntervals(records: readonly ShadowRecord[], asOfMs: number): ShadowIntervals {
	const result: ShadowIntervals = { workingTimeEstimated: [], agentRuntime: [] }
	const ends = new Map<string, ShadowRecord>()
	const key = (collector: string, segment: string) => `${collector}\u0000${segment}`
	for (const row of records) {
		if (row.evidence.family === 'execution_end') ends.set(key(row.collectorId, row.evidence.segment_id), row)
	}
	for (const row of records) {
		const evidence = row.evidence
		if (evidence.family === 'execution_end') continue
		const startMs = Date.parse(evidence.timing.wall_time)
		let endMs: number
		if (evidence.family === 'engagement') {
			endMs = startMs + 15 * 60_000
		} else {
			const end = ends.get(key(row.collectorId, evidence.segment_id))
			if (!end) continue
			endMs = Date.parse(end.evidence.timing.wall_time)
		}
		endMs = Math.min(endMs, asOfMs)
		if (endMs <= startMs) continue
		result[evidence.family === 'engagement' ? 'workingTimeEstimated' : 'agentRuntime'].push({
			startMs, endMs,
			projectAttribution: { ...evidence.project_attribution },
			executionSiteId: row.executionSiteId,
		})
	}
	return result
}

/** Half-open civil day or Monday-based week containing date. Lanes are non-additive.
 * Zero means no contributing intervals in this snapshot, never complete observation coverage.
 */
export function summarizeShadow(records: readonly ShadowRecord[], report: ShadowReport): {
	startMs: number
	endMs: number
	global: ShadowTotals
	projects: { projectId: string | null; totals: ShadowTotals }[]
	sites: { executionSiteId: string; totals: ShadowTotals }[]
} {
	return summarizeShadowFrom(records, report, Number.NEGATIVE_INFINITY)
}

/** Prospective ADR 0007 reporting boundary. The approved cutover is supplied by the caller;
 * clipping does not alter evidence, invent an endpoint, or make receipt time authoritative.
 */
export function summarizeShadowAfterCutover(
	records: readonly ShadowRecord[],
	report: ShadowReport & { cutoverMs: number },
): ReturnType<typeof summarizeShadow> {
	if (!Number.isSafeInteger(report.cutoverMs)) {
		throw new Error('Cutover must be Monday 00:00 in Asia/Jakarta')
	}
	const clock = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Asia/Jakarta', hourCycle: 'h23',
		weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
	}).formatToParts(new Date(report.cutoverMs)).map((part) => [part.type, part.value]))
	if (clock.weekday !== 'Mon' || clock.hour !== '00' || clock.minute !== '00'
		|| clock.second !== '00' || clock.fractionalSecond !== '000') {
		throw new Error('Cutover must be Monday 00:00 in Asia/Jakarta')
	}
	return summarizeShadowFrom(records, report, report.cutoverMs)
}

function summarizeShadowFrom(
	records: readonly ShadowRecord[],
	report: ShadowReport,
	notBeforeMs: number,
): ReturnType<typeof summarizeShadow> {
	const { date, timezone } = report
	const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
	const first = report.period === 'week' ? addDays(date, -((weekday + 6) % 7)) : date
	const startMs = startOfZonedDay(first, timezone)
	const endMs = startOfZonedDay(addDays(first, report.period === 'week' ? 7 : 1), timezone)
	const intervals = buildShadowIntervals(records, report.asOfMs)
	const clip = (rows: ShadowInterval[]) => rows.map((row) => ({
		...row, startMs: Math.max(row.startMs, startMs, notBeforeMs), endMs: Math.min(row.endMs, endMs),
	})).filter((row) => row.endMs > row.startMs)
	const working = clip(intervals.workingTimeEstimated)
	const runtime = clip(intervals.agentRuntime)
	const duration = (rows: ShadowInterval[]) => unionIntervals(rows)
		.reduce((total, row) => total + row.endMs - row.startMs, 0)
	const totals = (include: (row: ShadowInterval) => boolean): ShadowTotals => ({
		workingTimeEstimatedMs: duration(working.filter(include)),
		agentRuntimeMs: duration(runtime.filter(include)),
	})
	const projectId = (row: ShadowInterval) => row.projectAttribution.kind === 'cukup_project'
		? row.projectAttribution.project_id : null
	const rows = [...working, ...runtime]
	return {
		startMs, endMs,
		global: totals(() => true),
		projects: [...new Set(rows.map(projectId))].sort().map((id) => ({
			projectId: id, totals: totals((row) => projectId(row) === id),
		})),
		sites: [...new Set(rows.map((row) => row.executionSiteId))].sort().map((id) => ({
			executionSiteId: id, totals: totals((row) => row.executionSiteId === id),
		})),
	}
}
