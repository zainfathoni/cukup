import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAPABILITIES, LOCAL_PROTOCOL, type Evidence, type ProjectAttribution } from './harness-evidence-protocol.ts'
import { SHADOW_SCHEMA, ShadowEvidenceStore } from './shadow-evidence.ts'
import { buildShadowIntervals, summarizeShadow, summarizeShadowAfterCutover } from './shadow-aggregation.ts'
import { summarizeWork } from './aggregation.ts'
import { ServiceStore } from './store.ts'

const databases: Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`
const project = (n: number): ProjectAttribution => ({ kind: 'cukup_project', project_id: id(n), basis: 'explicit_binding' })
const unassigned: ProjectAttribution = { kind: 'unassigned', reason: 'ambiguous' }
const ms = Date.parse
const minute = 60_000
const cutoverMs = ms('2026-09-13T17:00:00Z') // Monday 00:00 Asia/Jakarta.
function fixture(store?: ShadowEvidenceStore) {
	if (!store) {
		const db = new Database(':memory:')
		databases.push(db)
		db.exec(SHADOW_SCHEMA)
		store = new ShadowEvidenceStore(db)
	}
	const shadow = store
	let sequence = 0
	function add(family: Evidence['family'], time: string, collector = 70, attribution = project(90), segment = 80,
		received = '2026-12-01T00:00:00Z', interaction = 'submission') {
		const evidence = {
			family, evidence_id: id(++sequence), recovered: true,
			timing: { wall_time: new Date(ms(time)).toISOString(), provenance: 'native_occurrence', precision_ms: 1 },
			...(family === 'engagement' ? { origin: 'human', interaction } : { segment_id: id(segment) }),
			...(family === 'execution_end' ? {} : { project_attribution: attribution }),
		}
		expect(shadow.append({ sourceSequence: sequence, executionSiteId: id(collector + 100), envelope: {
			protocol: LOCAL_PROTOCOL, protocol_version: 1, collector_instance_id: id(collector),
			capabilities: [...CAPABILITIES], evidence: [evidence],
		} }, ms(received))).toEqual({ status: 'accepted' })
	}
	return { shadow, add }
}
const report = (day = 14, period: 'day' | 'week' = 'day', timezone = 'Asia/Jakarta') => ({
	date: { year: 2026, month: 9, day }, period, timezone, asOfMs: ms('2026-12-01T00:00:00Z'),
})

test('renewed human windows union globally across collectors, sites and projects; lanes are non-additive', () => {
	const { shadow, add } = fixture()
	add('engagement', '2026-09-14T01:00:00Z')
	add('engagement', '2026-09-14T01:11:00Z', 70, project(90), 80, undefined, 'composition')
	add('engagement', '2026-09-14T01:23:00Z', 71, project(91), 80, undefined, 'approval')
	add('engagement', '2026-09-14T01:38:00Z', 71, project(91), 80, undefined, 'follow_up')
	add('engagement', '2026-09-14T02:01:00Z', 72, unassigned, 80, undefined, 'takeover')
	add('engagement', '2026-09-14T01:04:00Z', 72, project(90))
	const result = summarizeShadow(shadow.records(), report())
	// [01:00,01:53) plus [02:01,02:16), not six times fifteen minutes.
	expect(result.global).toEqual({ workingTimeEstimatedMs: 68 * minute, agentRuntimeMs: 0 })
	expect(result.projects).toEqual([
		{ projectId: id(90), totals: { workingTimeEstimatedMs: 26 * minute, agentRuntimeMs: 0 } },
		{ projectId: id(91), totals: { workingTimeEstimatedMs: 30 * minute, agentRuntimeMs: 0 } },
		{ projectId: null, totals: { workingTimeEstimatedMs: 15 * minute, agentRuntimeMs: 0 } },
	])
	expect(result.sites.map((lane) => [lane.executionSiteId, lane.totals.workingTimeEstimatedMs])).toEqual([
		[id(170), 26 * minute], [id(171), 30 * minute], [id(172), 30 * minute],
	])
})

test('only closed segments count: overlaps, touching endpoints, disjoint segments and long approval gap', () => {
	const { shadow, add } = fixture()
	add('execution_start', '2026-09-14T01:00:00Z')
	add('execution_end', '2026-09-14T01:05:00Z')
	add('execution_start', '2026-09-14T02:00:00Z', 70, project(90), 81)
	add('execution_end', '2026-09-14T02:10:00Z', 70, project(90), 81)
	// Same segment ID on another collector must not pair with the first collector.
	add('execution_start', '2026-09-14T02:07:00Z', 71, project(91))
	add('execution_end', '2026-09-14T02:18:00Z', 71)
	add('execution_start', '2026-09-14T02:18:00Z', 71, project(91), 82)
	add('execution_end', '2026-09-14T02:21:00Z', 71, project(91), 82)
	add('execution_start', '2026-09-14T00:00:00Z', 72, unassigned)
	add('execution_start', '2026-09-14T03:00:00Z', 70, unassigned, 83)
	add('execution_end', '2026-09-14T03:00:00Z', 70, unassigned, 83)
	const result = summarizeShadow(shadow.records(), report())
	expect(result.global).toEqual({ workingTimeEstimatedMs: 0, agentRuntimeMs: 26 * minute })
	expect(result.projects.map((lane) => [lane.projectId, lane.totals.agentRuntimeMs])).toEqual([
		[id(90), 15 * minute], [id(91), 14 * minute],
	])
	expect(result.sites.map((lane) => lane.totals.agentRuntimeMs)).toEqual([15 * minute, 14 * minute])
})

test('late uploads and closure revise occurrence days and Monday weeks, independently of receipt time', () => {
	const { shadow, add } = fixture()
	// Jakarta Monday begins at Sunday 17:00Z.
	add('engagement', '2026-09-13T16:53:00Z')
	add('execution_start', '2026-09-13T16:49:00Z', 70, unassigned)
	expect(summarizeShadow(shadow.records(), report(13, 'week')).global.agentRuntimeMs).toBe(0)
	add('execution_end', '2026-09-13T17:19:00Z')
	for (const period of ['day', 'week'] as const) {
		expect(summarizeShadow(shadow.records(), report(13, period)).global).toEqual({ workingTimeEstimatedMs: 7 * minute, agentRuntimeMs: 11 * minute })
		expect(summarizeShadow(shadow.records(), report(14, period)).global).toEqual({ workingTimeEstimatedMs: 8 * minute, agentRuntimeMs: 19 * minute })
	}
	const records = shadow.records()
	const original = summarizeShadow(records, report(14, 'week'))
	expect(summarizeShadow(records.map((row) => ({ ...row, receivedAtMs: ms('2027-01-01T00:00:00Z') })), report(14, 'week'))).toEqual(original)
	expect(original.projects).toContainEqual({ projectId: null, totals: { workingTimeEstimatedMs: 0, agentRuntimeMs: 19 * minute } })
	const intervals = buildShadowIntervals(records, report().asOfMs)
	expect(intervals.agentRuntime[0]?.projectAttribution).toEqual(unassigned)
	expect(intervals.agentRuntime[0]?.executionSiteId).toBe(id(170))
})

test('accepted within-skew future evidence clips at as-of, including exact boundaries', () => {
	const { shadow, add } = fixture()
	const received = '2026-09-14T01:00:00Z'
	add('engagement', '2026-09-14T00:56:00Z', 70, project(90), 80, received)
	add('engagement', '2026-09-14T01:00:00Z', 70, project(91), 80, received)
	add('engagement', '2026-09-14T01:07:00Z', 70, unassigned, 80, received)
	add('execution_start', '2026-09-14T00:51:00Z', 70, project(90), 80, received)
	add('execution_end', '2026-09-14T01:08:00Z', 70, project(90), 80, received)
	add('execution_start', '2026-09-14T01:02:00Z', 71, unassigned, 80, received)
	add('execution_end', '2026-09-14T01:09:00Z', 71, unassigned, 80, received)
	const query = { ...report(), asOfMs: ms(received) }
	expect(summarizeShadow(shadow.records(), query).global).toEqual({ workingTimeEstimatedMs: 4 * minute, agentRuntimeMs: 9 * minute })
	expect(summarizeShadow(shadow.records(), { ...query, asOfMs: ms(received) + 1 }).global).toEqual({ workingTimeEstimatedMs: 4 * minute + 1, agentRuntimeMs: 9 * minute + 1 })
})

test('cutover clips asymmetric engagement and execution boundaries across report periods and as-of', () => {
	const { shadow, add } = fixture()
	add('engagement', '2026-09-13T16:40:00Z', 70, project(90)) // Wholly before.
	add('engagement', '2026-09-13T16:53:00Z', 70, project(91)) // Eight minutes after.
	add('engagement', '2026-09-13T17:00:00Z', 71, unassigned) // Exact boundary.
	add('execution_start', '2026-09-13T16:30:00Z', 72, project(90), 80)
	add('execution_end', '2026-09-13T16:59:00Z', 72, project(90), 80)
	add('execution_start', '2026-09-13T16:50:00Z', 72, project(90), 81)
	add('execution_end', '2026-09-13T17:10:00Z', 72, project(90), 81)
	add('execution_start', '2026-09-13T17:20:00Z', 71, project(91), 82)
	add('execution_end', '2026-09-13T17:27:00Z', 71, project(91), 82)
	add('execution_start', '2026-09-13T18:00:00Z', 70, unassigned, 83) // Pending stays zero.
	add('engagement', '2026-09-14T17:10:00Z', 70, project(90))
	const rows = shadow.records()
	const before = structuredClone(rows)
	const query = (date: { year: number; month: number; day: number }, timezone: string, asOfMs = ms('2026-12-01T00:00:00Z')) => ({
		date, timezone, period: 'day' as const, asOfMs, cutoverMs,
	})

	const beforePeriod = summarizeShadowAfterCutover(rows, query({ year: 2026, month: 9, day: 13 }, 'Asia/Jakarta'))
	expect(beforePeriod.endMs).toBe(cutoverMs)
	expect(beforePeriod.global).toEqual({ workingTimeEstimatedMs: 0, agentRuntimeMs: 0 })
	expect(beforePeriod.projects).toEqual([])
	expect(beforePeriod.sites).toEqual([])

	const straddling = summarizeShadowAfterCutover(rows, query({ year: 2026, month: 9, day: 13 }, 'UTC'))
	expect(straddling.global).toEqual({ workingTimeEstimatedMs: 15 * minute, agentRuntimeMs: 17 * minute })
	expect(straddling.projects).toEqual([
		{ projectId: id(90), totals: { workingTimeEstimatedMs: 0, agentRuntimeMs: 10 * minute } },
		{ projectId: id(91), totals: { workingTimeEstimatedMs: 8 * minute, agentRuntimeMs: 7 * minute } },
		{ projectId: null, totals: { workingTimeEstimatedMs: 15 * minute, agentRuntimeMs: 0 } },
	])
	expect(straddling.sites.map((lane) => [lane.executionSiteId, lane.totals])).toEqual([
		[id(170), { workingTimeEstimatedMs: 8 * minute, agentRuntimeMs: 0 }],
		[id(171), { workingTimeEstimatedMs: 15 * minute, agentRuntimeMs: 7 * minute }],
		[id(172), { workingTimeEstimatedMs: 0, agentRuntimeMs: 10 * minute }],
	])

	const afterPeriod = summarizeShadowAfterCutover(rows, query({ year: 2026, month: 9, day: 14 }, 'UTC'))
	expect(afterPeriod.global).toEqual({ workingTimeEstimatedMs: 15 * minute, agentRuntimeMs: 0 })
	expect(afterPeriod.projects).toEqual([{ projectId: id(90), totals: { workingTimeEstimatedMs: 15 * minute, agentRuntimeMs: 0 } }])

	for (const [asOfMs, expectedMs] of [
		[cutoverMs - 1, 0], [cutoverMs, 0], [cutoverMs + 1, 1],
	] as const) {
		expect(summarizeShadowAfterCutover(rows, query({ year: 2026, month: 9, day: 13 }, 'UTC', asOfMs)).global)
			.toEqual({ workingTimeEstimatedMs: expectedMs, agentRuntimeMs: expectedMs })
	}
	expect(rows).toEqual(before)
	expect(shadow.records()).toEqual(before)
})

test('late closure revises occurrence-time runtime without using receipt time or fabricating pending duration', () => {
	const { shadow, add } = fixture()
	add('execution_start', '2026-09-13T16:50:00Z', 70, project(90), 80, '2026-09-13T16:51:00Z')
	const query = { ...report(14), cutoverMs, asOfMs: ms('2026-09-20T00:00:00Z') }
	expect(summarizeShadowAfterCutover(shadow.records(), query).global.agentRuntimeMs).toBe(0)
	add('execution_end', '2026-09-13T17:12:00Z', 70, project(90), 80, '2026-12-01T00:00:00Z')
	const rows = shadow.records()
	expect(summarizeShadowAfterCutover(rows, query).global.agentRuntimeMs).toBe(12 * minute)
	expect(summarizeShadowAfterCutover(rows.map((row) => ({ ...row, receivedAtMs: ms('2027-02-01T00:00:00Z') })), query))
		.toEqual(summarizeShadowAfterCutover(rows, query))
})

test('cutover must be exactly Monday midnight in Asia/Jakarta', () => {
	const query = { ...report(), cutoverMs }
	expect(() => summarizeShadowAfterCutover([], query)).not.toThrow()
	expect(() => summarizeShadowAfterCutover([], { ...query, cutoverMs: ms('2026-09-14T17:00:00Z') }))
		.toThrow('Cutover must be Monday 00:00 in Asia/Jakarta') // Tuesday midnight.
	expect(() => summarizeShadowAfterCutover([], { ...query, cutoverMs: ms('2026-09-14T00:00:00Z') }))
		.toThrow('Cutover must be Monday 00:00 in Asia/Jakarta') // Monday 07:00.
	expect(() => summarizeShadowAfterCutover([], { ...query, cutoverMs: ms('1942-03-22T16:30:00Z') }))
		.toThrow('Cutover must be Monday 00:00 in Asia/Jakarta') // Monday began at 01:30 after a clock jump.
	expect(() => summarizeShadowAfterCutover([], { ...query, cutoverMs: ms('0001-01-06T16:52:48Z') }))
		.toThrow('Cutover must be Monday 00:00 in Asia/Jakarta') // Sunday midnight in historical Jakarta.
	expect(() => summarizeShadowAfterCutover([], { ...query, cutoverMs: ms('0001-01-07T16:52:48Z') })).not.toThrow()
})

test('civil reports split elapsed intervals across spring and autumn DST and Monday boundaries', () => {
	for (const [month, day, start, end, hours, previousMinutes, nextMinutes, engagement] of [
		[3, 8, '2026-03-08T04:43:00Z', '2026-03-09T04:29:00Z', 23, 17, 29, '2026-03-08T06:56:00Z'],
		[11, 1, '2026-11-01T03:37:00Z', '2026-11-02T05:41:00Z', 25, 23, 41, '2026-11-01T05:56:00Z'],
	] as const) {
		const { shadow, add } = fixture()
		add('execution_start', start)
		add('execution_end', end)
		add('engagement', engagement)
		const query = { ...report(), date: { year: 2026, month, day }, timezone: 'America/New_York' }
		const sunday = summarizeShadow(shadow.records(), query)
		expect(sunday.endMs - sunday.startMs).toBe(hours * 60 * minute)
		expect(sunday.global.agentRuntimeMs).toBe(hours * 60 * minute)
		expect(sunday.global.workingTimeEstimatedMs).toBe(15 * minute)
		expect(summarizeShadow(shadow.records(), { ...query, period: 'week' }).global.agentRuntimeMs).toBe((hours * 60 + previousMinutes) * minute)
		expect(summarizeShadow(shadow.records(), { ...query, date: { year: 2026, month, day: day + 1 }, period: 'week' }).global.agentRuntimeMs).toBe(nextMinutes * minute)
	}
})

test('empty and orphan-only snapshots have no intervals; derived snapshots do not mutate records or legacy summaries', () => {
	const directory = mkdtempSync(join(tmpdir(), 'cukup-shadow-aggregation-'))
	const store = new ServiceStore(join(directory, 'service.sqlite'))
	try {
		const credential = store.issueBearer()
		store.bindExecutorLabel(credential.tokenId, 'test-machine')
		const principal = store.authenticateBearer(credential.token)!
		const occurredAt = '2026-09-14T01:00:00Z'
		for (const version of [1, 2] as const) {
			expect(store.ingest(principal, {
				schemaVersion: version, eventId: id(version), sourceInstance: id(50), sourceSequence: version,
				sessionId: id(40 + version), kind: 'agent.start', occurredAt, occurredAtMs: ms(occurredAt),
				...(version === 2 ? { projectSlug: 'cukup' } : {}),
			}, ms(occurredAt)).outcome).toBe('accepted')
		}
		const legacy = store.attributedEvents()
		const legacyAsOf = ms('2026-09-14T01:09:00Z')
		const summary = summarizeWork(legacy, legacyAsOf)
		expect(summary.daily.worked_minutes).toBe(9)
		const { shadow, add } = fixture(store.shadow)
		expect(summarizeShadow(shadow.records(), report()).global).toEqual({ workingTimeEstimatedMs: 0, agentRuntimeMs: 0 })
		add('engagement', occurredAt)
		add('execution_start', occurredAt, 70, unassigned)
		add('execution_end', '2026-09-14T01:09:00Z')
		const rows = shadow.records()
		const before = structuredClone(rows)
		expect(buildShadowIntervals(rows.filter((row) => row.evidence.family === 'execution_end'), report().asOfMs)).toEqual({ workingTimeEstimated: [], agentRuntime: [] })
		const derived = buildShadowIntervals(rows, report().asOfMs)
		const attribution = derived.agentRuntime[0]!.projectAttribution
		if (attribution.kind !== 'unassigned') throw new Error('Expected original Unassigned start')
		attribution.reason = 'absent'
		summarizeShadow(rows, report())
		summarizeShadowAfterCutover(rows, { ...report(), cutoverMs })
		expect(rows).toEqual(before)
		expect(shadow.records()).toEqual(before)
		expect(store.attributedEvents()).toEqual(legacy)
		expect(summarizeWork(store.attributedEvents(), legacyAsOf)).toEqual(summary)
	} finally {
		store.close()
		rmSync(directory, { recursive: true, force: true })
	}
})
