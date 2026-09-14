import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServiceStore } from './store.ts'
import { CAPABILITIES, LOCAL_PROTOCOL, type Capability, type CoverageFact, type Evidence } from './harness-evidence-protocol.ts'
import { projectShadowDisclosures } from './shadow-disclosures.ts'
import { summarizeShadow, summarizeShadowAfterCutover } from './shadow-aggregation.ts'
import { summarizeWork } from './aggregation.ts'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const t = Date.parse('2026-09-13T17:00:00.000Z') // Approved-form Monday Jakarta boundary.
const at = (n: number) => new Date(t + n).toISOString()
const base: Capability[] = ['engagement.composition', 'engagement.submission', 'engagement.follow_up', 'engagement.approval', 'engagement.takeover']
const recovery: Capability[] = ['recovery.engagement.composition', 'recovery.engagement.submission', 'recovery.engagement.follow_up', 'recovery.engagement.approval', 'recovery.engagement.takeover']
const runtimeRecovery: Capability[] = ['recovery.execution_start.native', 'recovery.execution_start.current_observation', 'recovery.execution_end.native']
const stores: ServiceStore[] = []
const directories: string[] = []
afterEach(() => {
	for (const store of stores.splice(0)) store.close()
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), 'cukup-disclosures-'))
	directories.push(directory)
	const store = new ServiceStore(join(directory, 'service.sqlite'))
	stores.push(store)
	let sequence = 0
	const append = (collector: number, site: number, capabilities: readonly Capability[], fact?: CoverageFact, evidence?: Evidence, sourceSequence?: number) => {
		sequence = sourceSequence ?? sequence + 1
		const input = { executionSiteId: id(site), sourceSequence: sequence, envelope: {
			protocol: LOCAL_PROTOCOL, protocol_version: 1, collector_instance_id: id(collector), capabilities,
			...(fact ? { fact } : { evidence: [evidence] }),
		} }
		expect((fact ? store.shadow.appendCoverage(input, t + 172_800_000 + sequence) : store.shadow.append(input, t + sequence + 600_000)).status).toBe('accepted')
	}
	const declare = (n: number, time: number, capabilities: Capability[], collector = 70, site = 60) =>
		append(collector, site, capabilities, { family: 'capability_declaration', fact_id: id(n), effective_at: at(time) })
	const loss = (n: number, start: number, end: number, capabilities: Capability[] = ['execution.segments'], reason: Extract<CoverageFact, { family: 'irreversible_loss' }>['reason'] = 'source_without_replay') =>
		append(70, 60, capabilities, { family: 'irreversible_loss', fact_id: id(n), start: at(start), end: at(end), reason })
	const evidence = (n: number, family: Evidence['family'], time: number, collector = 70, site = 60, segment = 80, sourceSequence?: number) => {
		const common = { evidence_id: id(n), recovered: false, timing: { wall_time: at(time), provenance: 'native_occurrence' as const, precision_ms: 1 } }
		const project_attribution = { kind: 'unassigned' as const, reason: 'absent' as const }
		const row: Evidence = family === 'engagement'
			? { ...common, family, project_attribution, origin: 'human', interaction: 'submission' }
			: family === 'execution_start' ? { ...common, family, project_attribution, segment_id: id(segment) }
				: { ...common, family, segment_id: id(segment) }
		append(collector, site, CAPABILITIES, undefined, row, sourceSequence)
	}
	const project = (start = 0, end = 100, cutoverMs?: number) => projectShadowDisclosures(store.shadow.records(), store.shadow.coverageRecords(), { startMs: t + start, endMs: t + end, cutoverMs })
	return { store, declare, loss, evidence, project }
}

test('converse metric scopes at one site; exact recovery limitations stay separate from base requirements', () => {
	const f = fixture()
	f.declare(1, 0, ['execution.segments'])
	f.declare(2, 0, base, 71)
	f.declare(3, 0, ['engagement.submission', 'recovery.engagement.submission', 'process.lifecycle'], 72)
	const lanes = f.project()
	expect(lanes.map((lane) => [lane.collectorId, lane.executionSiteId])).toEqual([[id(70), id(60)], [id(71), id(60)], [id(72), id(60)]])
	expect(lanes[0]!.capabilityIntervals).toEqual([{
		startMs: t, endMs: t + 100,
		workingTimeV1: { status: 'declared_limited', missingCapabilities: base, missingRecoveryCapabilities: recovery },
		agentRuntimeV1: { status: 'declared_for_scope', missingRecoveryCapabilities: runtimeRecovery },
	}])
	expect(lanes[1]!.capabilityIntervals[0]).toEqual({
		startMs: t, endMs: t + 100,
		workingTimeV1: { status: 'declared_for_scope', missingRecoveryCapabilities: recovery },
		agentRuntimeV1: { status: 'declared_limited', missingCapabilities: ['execution.segments'], missingRecoveryCapabilities: runtimeRecovery },
	})
	expect(lanes[2]!.capabilityIntervals[0]!.workingTimeV1).toEqual({
		status: 'declared_limited',
		missingCapabilities: ['engagement.composition', 'engagement.follow_up', 'engagement.approval', 'engagement.takeover'],
		missingRecoveryCapabilities: ['recovery.engagement.composition', 'recovery.engagement.follow_up', 'recovery.engagement.approval', 'recovery.engagement.takeover'],
	})
	expect(lanes[2]!.capabilityIntervals[0]!.agentRuntimeV1.status).toBe('declared_limited')
})

test('effective order beats source/receipt order; equal-effective duplicates produce one interval; no backward declaration', () => {
	const f = fixture()
	f.declare(1, 60, base)
	f.declare(2, 20, ['execution.segments'])
	f.declare(3, 60, [...base].reverse())
	const intervals = f.project()[0]!.capabilityIntervals
	expect(intervals.map((row) => [row.startMs - t, row.endMs - t, row.workingTimeV1.status, row.agentRuntimeV1.status])).toEqual([
		[0, 20, 'unknown', 'unknown'], [20, 60, 'declared_limited', 'declared_for_scope'], [60, 100, 'declared_for_scope', 'declared_limited'],
	])
	expect(f.project(0, 20)[0]!.capabilityIntervals).toEqual([{ startMs: t, endMs: t + 20, workingTimeV1: { status: 'unknown' }, agentRuntimeV1: { status: 'unknown' } }])
	expect(f.project(30, 50)[0]!.capabilityIntervals.map((row) => [row.startMs, row.endMs, row.agentRuntimeV1.status])).toEqual([[t + 30, t + 50, 'declared_for_scope']])
	expect(f.project(60, 90)[0]!.capabilityIntervals.map((row) => [row.startMs, row.endMs, row.workingTimeV1.status])).toEqual([[t + 60, t + 90, 'declared_for_scope']])
})

test('losses keep immutable identities, reasons and exact affected capabilities while clipping independently', () => {
	const f = fixture()
	f.declare(1, -20, ['execution.segments'])
	f.loss(2, -10, 30)
	f.loss(3, 20, 70, ['recovery.execution_end.native'], 'operator_discard')
	f.loss(4, 70, 110, ['engagement.approval'], 'storage_exhaustion')
	f.loss(5, -20, 0)
	f.loss(6, 100, 120)
	const lane = f.project(-20, 100, t)[0]!
	expect([lane.startMs, lane.endMs]).toEqual([t, t + 100])
	expect(lane.capabilityIntervals.map((row) => [row.startMs, row.endMs, row.agentRuntimeV1.status])).toEqual([[t, t + 100, 'declared_for_scope']])
	expect(lane.collectionIntegrity).toEqual({ otherwise: 'unknown', losses: [
		{ status: 'known_loss', factId: id(2), startMs: t, endMs: t + 30, capabilities: ['execution.segments'], reason: 'source_without_replay' },
		{ status: 'known_loss', factId: id(3), startMs: t + 20, endMs: t + 70, capabilities: ['recovery.execution_end.native'], reason: 'operator_discard' },
		{ status: 'known_loss', factId: id(4), startMs: t + 70, endMs: t + 100, capabilities: ['engagement.approval'], reason: 'storage_exhaustion' },
	] })
	expect(f.project(120, 140)[0]!.collectionIntegrity).toEqual({ otherwise: 'unknown', losses: [] })
	expect(f.project(-20, 0, t)).toEqual([])
	expect(f.project(0, 100, t + 100)).toEqual([])
})

test('pending starts are occurrence scoped, not loss; late ends clear only their collector even beyond report bounds', () => {
	const f = fixture()
	f.evidence(1, 'execution_start', 0, 70, 60, 80, 8)
	f.evidence(2, 'engagement', 40, 70, 60, 80, 10)
	f.evidence(3, 'execution_start', 10, 71, 61)
	f.evidence(4, 'execution_start', 20, 72, 60) // Fresh collector at A's site.
	f.evidence(5, 'execution_start', -1, 73, 63)
	f.evidence(6, 'execution_start', 100, 74, 64)
	const before = f.project(-10, 100, t)
	expect(before.map((lane) => lane.executionClosure)).toEqual([
		{ status: 'pending', starts: [{ evidenceId: id(1), segmentId: id(80), startMs: t }] },
		{ status: 'pending', starts: [{ evidenceId: id(3), segmentId: id(80), startMs: t + 10 }] },
		{ status: 'pending', starts: [{ evidenceId: id(4), segmentId: id(80), startMs: t + 20 }] },
		{ status: 'none_pending', starts: [] }, { status: 'none_pending', starts: [] },
	])
	for (const lane of before) {
		expect(lane.collectionIntegrity).toEqual({ otherwise: 'unknown', losses: [] })
		expect(lane.synchronization).toBe('unknown')
		expect(lane.capabilityIntervals[0]!.agentRuntimeV1).toEqual({ status: 'unknown' })
	}
	f.loss(7, 0, 80)
	f.evidence(8, 'execution_end', 110, 71, 61)
	expect(f.project().map((lane) => lane.executionClosure.status)).toEqual(['pending', 'none_pending', 'pending', 'none_pending', 'none_pending'])
	f.evidence(9, 'execution_end', 90)
	expect(f.project()[0]!.executionClosure).toEqual({ status: 'none_pending', starts: [] })
	expect(f.project()[0]!.collectionIntegrity.losses.map((row) => row.factId)).toEqual([id(7)])
	expect(f.project()[2]!.executionClosure.status).toBe('pending')
})

test('receipt changes and input order do not change projection; frozen snapshots and persisted legacy/totals stay unchanged', () => {
	const f = fixture()
	const credential = f.store.issueBearer()
	f.store.bindExecutorLabel(credential.tokenId, 'test-machine')
	const principal = f.store.authenticateBearer(credential.token)!
	for (const version of [1, 2] as const) expect(f.store.ingest(principal, {
		schemaVersion: version, eventId: id(100 + version), sourceInstance: id(50), sourceSequence: version,
		sessionId: id(40 + version), kind: 'agent.start', occurredAt: at(0), occurredAtMs: t,
		...(version === 2 ? { projectSlug: 'cukup' } : {}),
	}, t).outcome).toBe('accepted')
	f.declare(1, -10, base)
	f.loss(2, -5, 90)
	f.evidence(3, 'execution_start', 0)
	f.evidence(4, 'engagement', 30)
	const report = { date: { year: 2026, month: 9, day: 14 }, period: 'day' as const, timezone: 'Asia/Jakarta', asOfMs: t + 600_000 }
	expect(summarizeShadow(f.store.shadow.records(), report).global).toEqual({ workingTimeEstimatedMs: 599_970, agentRuntimeMs: 0 })
	f.evidence(5, 'execution_end', 90)
	const rows = f.store.shadow.records(), facts = f.store.shadow.coverageRecords()
	const originals = structuredClone({ rows, facts })
	const legacy = f.store.attributedEvents(), summary = summarizeWork(legacy, t + 540_000)
	expect(summary.daily.worked_minutes).toBe(9)
	const totals = summarizeShadow(rows, report), cutoverTotals = summarizeShadowAfterCutover(rows, { ...report, cutoverMs: t })
	expect(totals.global).toEqual({ workingTimeEstimatedMs: 599_970, agentRuntimeMs: 90 })
	function freeze(value: unknown) {
		if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child) }
	}
	freeze(rows); freeze(facts)
	const bounds = { startMs: t, endMs: t + 100 }
	const result = projectShadowDisclosures(rows, facts, bounds)
	expect(projectShadowDisclosures([...rows].reverse().map((row) => ({ ...row, receivedAtMs: t + 9_000_000 })), [...facts].reverse().map((row) => ({ ...row, receivedAtMs: t })), bounds)).toEqual(result)
	result[0]!.collectionIntegrity.losses[0]!.capabilities.push('process.lifecycle')
	expect({ rows, facts }).toEqual(originals)
	expect({ rows: f.store.shadow.records(), facts: f.store.shadow.coverageRecords() }).toEqual(originals)
	expect(summarizeShadow(rows, report)).toEqual(totals)
	expect(summarizeShadowAfterCutover(rows, { ...report, cutoverMs: t })).toEqual(cutoverTotals)
	expect(f.store.attributedEvents()).toEqual(legacy)
	expect(summarizeWork(f.store.attributedEvents(), t + 540_000)).toEqual(summary)
	expect(projectShadowDisclosures([], [], bounds)).toEqual([])
})
