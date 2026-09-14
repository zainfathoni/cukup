import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_PROTOCOL, parseCoverageEnvelope, type Capability, type CoverageFact } from './harness-evidence-protocol.ts'
import { ServiceStore } from './store.ts'

const now = Date.parse('2026-09-14T12:00:00.000Z')
const at = (offset: number) => new Date(now + offset).toISOString()
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const directories: string[] = []
const stores: ServiceStore[] = []
function open(path?: string) {
	if (!path) {
		const directory = mkdtempSync(join(tmpdir(), 'cukup-coverage-'))
		directories.push(directory)
		path = join(directory, 'service.sqlite')
	}
	const store = new ServiceStore(path)
	stores.push(store)
	return { store, path }
}
function close(store: ServiceStore) {
	store.close()
	stores.splice(stores.indexOf(store), 1)
}
afterEach(() => {
	for (const store of stores.splice(0)) store.close()
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const rejected = <T extends string>(reason: T) => ({ status: 'rejected' as const, reason })
const declaration = (n = 1, time = -60_000): CoverageFact => ({
	family: 'capability_declaration', fact_id: id(n), effective_at: at(time),
})
const loss = (n = 2, start = -3_600_000, end = -2_400_000): CoverageFact => ({
	family: 'irreversible_loss', fact_id: id(n), start: at(start), end: at(end), reason: 'source_without_replay',
})
function coverage(fact: unknown = declaration(), sequence = 1, capabilities: Capability[] = ['execution.segments']) {
	return { executionSiteId: id(60), sourceSequence: sequence, envelope: {
		protocol: LOCAL_PROTOCOL, protocol_version: 1, collector_instance_id: id(70), capabilities, fact,
	} }
}
function evidence(n = 3, sequence = 3, family: 'engagement' | 'execution_start' | 'execution_end' = 'engagement') {
	return { executionSiteId: id(60), sourceSequence: sequence, envelope: {
		protocol: LOCAL_PROTOCOL, protocol_version: 1, collector_instance_id: id(70),
		capabilities: ['engagement.submission', 'execution.segments'], evidence: [{
			family, evidence_id: id(n), recovered: false,
			timing: { wall_time: at(-30_000), provenance: 'native_occurrence', precision_ms: 1 },
			...(family === 'engagement' ? { origin: 'human', interaction: 'submission' } : { segment_id: id(80) }),
			...(family === 'execution_end' ? {} : { project_attribution: { kind: 'unassigned', reason: 'absent' } }),
		}],
	} }
}

test('one source order spans every family; gaps allowed, old exact retries preserve original receipt', () => {
	const { store } = open()
	const first = evidence(1, 8, 'execution_start')
	expect(store.shadow.append(first, now)).toEqual({ status: 'accepted' })
	for (const seq of [7, 8]) expect(store.shadow.appendCoverage(coverage(declaration(2), seq), now)).toEqual(rejected('invalid_order'))
	const declared = coverage(declaration(2), 10)
	expect(store.shadow.appendCoverage(declared, now + 172_800_000)).toEqual({ status: 'accepted' })
	for (const seq of [9, 10]) expect(store.shadow.append(evidence(3, seq), now)).toEqual(rejected('invalid_order'))
	const lost = coverage(loss(3), 12)
	expect(store.shadow.appendCoverage(lost, now + 172_800_001)).toEqual({ status: 'accepted' })
	expect(store.shadow.appendCoverage(coverage(declaration(4), 11), now)).toEqual(rejected('invalid_order'))
	expect(store.shadow.append(evidence(4, 12), now)).toEqual(rejected('invalid_order'))
	expect(store.shadow.append(evidence(4, 14, 'execution_end'), now + 172_800_002)).toEqual({ status: 'accepted' })
	const before = { evidence: store.shadow.records(), coverage: store.shadow.coverageRecords() }
	expect(store.shadow.append(first, now + 200_000_000)).toEqual({ status: 'duplicate' })
	expect(store.shadow.appendCoverage(declared, now + 200_000_000)).toEqual({ status: 'duplicate' })
	expect(store.shadow.appendCoverage(lost, now + 200_000_000)).toEqual({ status: 'duplicate' })
	expect({ evidence: store.shadow.records(), coverage: store.shadow.coverageRecords() }).toEqual(before)
	expect(before.coverage.map((row) => [row.sourceSequence, row.receivedAtMs, row.fact])).toEqual([
		[10, now + 172_800_000, declaration(2)], [12, now + 172_800_001, loss(3)],
	])
	expect(store.shadow.segments()[0]?.status).toBe('closed')
})

test('immutable identities span families; changes to collector, site, sequence, capabilities, and loss content conflict', () => {
	const { store } = open()
	const original = coverage(loss(), 4, ['execution.segments', 'engagement.submission'])
	expect(store.shadow.appendCoverage(original, now).status).toBe('accepted')
	const reordered = structuredClone(original)
	reordered.envelope.capabilities.reverse()
	expect(store.shadow.appendCoverage(reordered, now + 1).status).toBe('duplicate')
	for (const changed of [
		{ ...original, sourceSequence: 5 }, { ...original, executionSiteId: id(61) },
		{ ...original, envelope: { ...original.envelope, collector_instance_id: id(71) } },
		{ ...original, envelope: { ...original.envelope, capabilities: ['execution.segments'] } },
		coverage({ ...loss(), start: at(-3_599_999) }, 4, original.envelope.capabilities),
		coverage({ ...loss(), end: at(-2_399_999) }, 4, original.envelope.capabilities),
		coverage({ ...loss(), reason: 'operator_discard' }, 4, original.envelope.capabilities),
		coverage(declaration(2), 4, original.envelope.capabilities),
	]) expect(store.shadow.appendCoverage(changed, now)).toEqual(rejected('identity_conflict'))
	expect(store.shadow.append(evidence(2, 5), now)).toEqual(rejected('identity_conflict'))
	expect(store.shadow.append(evidence(3, 5), now).status).toBe('accepted')
	expect(store.shadow.appendCoverage(coverage(declaration(3), 6), now)).toEqual(rejected('identity_conflict'))
	const boundElsewhere = coverage(declaration(4), 6)
	boundElsewhere.executionSiteId = id(61)
	expect(store.shadow.appendCoverage(boundElsewhere, now)).toEqual(rejected('identity_conflict'))
	const evidenceElsewhere = evidence(4, 6)
	evidenceElsewhere.executionSiteId = id(61)
	expect(store.shadow.append(evidenceElsewhere, now)).toEqual(rejected('identity_conflict'))
	expect(store.shadow.coverageRecords()).toHaveLength(1)
})

test('late prospective declarations never rewrite earlier facts or evidence; equal-effective differences conflict', () => {
	const { store, path } = open()
	expect(store.shadow.appendCoverage(coverage(declaration(1, -60_000)), now).status).toBe('accepted')
	expect(store.shadow.append(evidence(2, 2), now).status).toBe('accepted')
	const early = store.shadow.coverageRecords()[0]
	const snapshot = store.shadow.records()
	expect(store.shadow.appendCoverage(coverage(declaration(3, 0), 3, ['engagement.submission']), now + 86_400_000).status).toBe('accepted')
	expect(store.shadow.appendCoverage(coverage(declaration(4, 0), 4), now + 86_400_000)).toEqual(rejected('identity_conflict'))
	expect(store.shadow.appendCoverage(coverage(declaration(1, -59_999)), now)).toEqual(rejected('identity_conflict'))
	// Receipt/source order is not occurrence order. No retroactive mutation of the 11:59 or 12:00 facts.
	expect(store.shadow.appendCoverage(coverage(declaration(4, -120_000), 4, ['process.lifecycle']), now + 86_400_001).status).toBe('accepted')
	expect(store.shadow.coverageRecords()[0]).toEqual(early)
	expect(store.shadow.records()).toEqual(snapshot)
	expect(store.shadow.coverageRecords().map((row) => row.fact)).toEqual([
		{ family: 'capability_declaration', fact_id: id(1), effective_at: '2026-09-14T11:59:00.000Z' },
		{ family: 'capability_declaration', fact_id: id(3), effective_at: '2026-09-14T12:00:00.000Z' },
		{ family: 'capability_declaration', fact_id: id(4), effective_at: '2026-09-14T11:58:00.000Z' },
	])
	const before = store.shadow.coverageRecords()
	close(store)
	const restarted = open(path).store
	expect(restarted.shadow.coverageRecords()).toEqual(before)
	expect(restarted.shadow.appendCoverage(coverage(declaration()), now + 172_800_000).status).toBe('duplicate')
	const fresh = coverage(declaration(5), 1, ['engagement.submission'])
	fresh.envelope.collector_instance_id = id(71)
	expect(restarted.shadow.appendCoverage(fresh, now).status).toBe('accepted')
	expect(restarted.shadow.coverageRecords().map((row) => row.collectorId)).toEqual([id(70), id(70), id(70), id(71)])
})

test('strict UTC half-open endpoints retain adjacent intervals and enforce millisecond and clock boundaries', () => {
	const { store, path } = open()
	for (const [start, end] of [[-1, -1], [0, -1], [600_000, 600_001]]) {
		expect(store.shadow.appendCoverage(coverage(loss(1, start, end)), now)).toEqual(rejected('invalid_record'))
	}
	for (const value of ['2026-09-14T12:00:00Z', '2026-09-14T12:00:00.000+00:00', '2026-02-30T12:00:00.000Z', 'secret']) {
		expect(store.shadow.appendCoverage(coverage({ ...loss(), end: value }), now)).toEqual(rejected('invalid_record'))
	}
	expect(store.shadow.appendCoverage(coverage(loss(1, -1, 0)), now).status).toBe('accepted')
	expect(store.shadow.appendCoverage(coverage(loss(2, 0, 600_000), 2), now).status).toBe('accepted')
	expect(store.shadow.appendCoverage(coverage(declaration(3, 600_000), 3), now).status).toBe('accepted')
	expect(store.shadow.appendCoverage(coverage(declaration(4, 600_001), 4), now)).toEqual(rejected('invalid_record'))
	const raw = new Database(path)
	expect(raw.query('SELECT occurred_at_ms, end_at_ms FROM shadow_coverage ORDER BY source_sequence').all()).toEqual([
		{ occurred_at_ms: now - 1, end_at_ms: now },
		{ occurred_at_ms: now, end_at_ms: now + 600_000 },
		{ occurred_at_ms: now + 600_000, end_at_ms: null },
	])
	raw.close()
	expect(store.shadow.coverageRecords().map((row) => row.fact)).toEqual([loss(1, -1, 0), loss(2, 0, 600_000), declaration(3, 600_000)])
})

test('closed protocol rejects private/unknown fields and invalid bounded values without diagnostics or persistence', () => {
	const { store, path } = open()
	for (const fact of [declaration(), loss()]) {
		const input = coverage(fact)
		for (const field of ['prompt', 'output', 'path', 'hostname', 'token', 'response_body', 'metadata', 'native_id', 'diagnostic', 'project_attribution', 'execution_site_id', 'surprise']) {
			for (const candidate of [
				{ ...input, [field]: 'private-sentinel' },
				{ ...input, envelope: { ...input.envelope, [field]: 'private-sentinel' } },
				coverage({ ...fact, [field]: 'private-sentinel' }),
			]) {
				expect(store.shadow.appendCoverage(candidate, now)).toEqual(rejected('invalid_record'))
				expect(JSON.stringify(parseCoverageEnvelope(candidate.envelope, now))).not.toContain('private-sentinel')
			}
		}
		for (const caps of [[], ['unknown'], ['execution.segments', 'execution.segments'], [{ prompt: 'private-sentinel' }]]) {
			expect(store.shadow.appendCoverage({ ...input, envelope: { ...input.envelope, capabilities: caps } }, now)).toEqual(rejected('invalid_record'))
		}
		for (const sourceSequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
			expect(store.shadow.appendCoverage({ ...input, sourceSequence }, now)).toEqual(rejected('invalid_record'))
		}
		for (const receipt of [NaN, Infinity, 1.5, 8_640_000_000_000_001]) {
			expect(store.shadow.appendCoverage(input, receipt)).toEqual(rejected('invalid_record'))
		}
		expect(store.shadow.appendCoverage({ ...input, envelope: { ...input.envelope, protocol_version: 2 } }, now)).toEqual(rejected('unsupported_version'))
		for (const key of Object.keys(input.envelope)) {
			const envelope: Record<string, unknown> = { ...input.envelope }
			delete envelope[key]
			expect(store.shadow.appendCoverage({ ...input, envelope }, now)).toEqual(rejected('invalid_record'))
		}
		for (const key of Object.keys(fact)) {
			const missing: Record<string, unknown> = { ...fact }
			delete missing[key]
			expect(store.shadow.appendCoverage(coverage(missing), now)).toEqual(rejected('invalid_record'))
		}
	}
	expect(store.shadow.appendCoverage(coverage({ ...loss(), reason: 'private-sentinel' }), now)).toEqual(rejected('invalid_record'))
	expect(store.shadow.appendCoverage(coverage(declaration(), 1, ['recovery.execution_end.native']), now)).toEqual(rejected('invalid_record'))
	expect(store.shadow.coverageRecords()).toEqual([])
	const raw = new Database(path)
	expect(raw.query('SELECT * FROM shadow_collectors').all()).toEqual([])
	raw.close()
	// Loss can affect recovery alone; it does not claim that the base observation was also lost.
	for (const [index, reason] of ['storage_exhaustion', 'source_without_replay', 'abrupt_termination', 'operator_discard', 'unspecified'].entries()) {
		expect(store.shadow.appendCoverage(coverage({ ...loss(index + 1), reason }, index + 1, ['recovery.execution_end.native']), now).status).toBe('accepted')
	}
})

test('gaps, delayed receipt, pending starts, retries and failures never create coverage facts', () => {
	const { store } = open()
	expect(store.shadow.append(evidence(1, 8, 'execution_start'), now).status).toBe('accepted')
	expect(store.shadow.append(evidence(2, 10), now + 172_800_000).status).toBe('accepted')
	expect(store.shadow.append(evidence(2, 10), now + 172_800_001).status).toBe('duplicate')
	expect(store.shadow.append(evidence(3, 9), now + 172_800_002)).toEqual(rejected('invalid_order'))
	expect(store.shadow.segments()[0]?.status).toBe('pending')
	expect(store.shadow.coverageRecords()).toEqual([])
})

test('failed insert rolls back binding and source order; SQL updates/deletes refuse both fact families', () => {
	const { store, path } = open()
	const raw = new Database(path)
	raw.exec(`CREATE TRIGGER fail_coverage BEFORE INSERT ON shadow_coverage BEGIN SELECT RAISE(ABORT, 'injected'); END`)
	expect(() => store.shadow.appendCoverage(coverage(), now)).toThrow('injected')
	expect(raw.query('SELECT * FROM shadow_collectors').all()).toEqual([])
	expect(store.shadow.coverageRecords()).toEqual([])
	raw.exec('DROP TRIGGER fail_coverage')
	expect(store.shadow.appendCoverage(coverage(), now).status).toBe('accepted')
	expect(store.shadow.appendCoverage(coverage(loss(), 2), now).status).toBe('accepted')
	for (const n of [1, 2]) {
		expect(() => raw.query('UPDATE shadow_coverage SET received_at_ms = 0 WHERE fact_id = ?').run(id(n))).toThrow('append-only')
		expect(() => raw.query('DELETE FROM shadow_coverage WHERE fact_id = ?').run(id(n))).toThrow('append-only')
	}
	expect(() => raw.exec('UPDATE shadow_collectors SET execution_site_id = collector_id')).toThrow('append-only')
	expect(() => raw.exec('DELETE FROM shadow_collectors')).toThrow('append-only')
	expect(store.shadow.coverageRecords().map((row) => row.receivedAtMs)).toEqual([now, now])
	raw.close()
})

test('v6 migration preserves every existing schema object and row exactly; rollback, restart and future refusal retain facts', () => {
	const { store, path } = open()
	const credential = store.issueBearer(now)
	store.bindExecutorLabel(credential.tokenId, 'test-machine')
	const principal = store.authenticateBearer(credential.token)!
	for (const schemaVersion of [1, 2] as const) {
		expect(store.ingest(principal, {
			schemaVersion, eventId: id(90 + schemaVersion), sourceInstance: id(95), sourceSequence: schemaVersion,
			sessionId: id(96 + schemaVersion), kind: 'agent.start', occurredAt: at(-90_000), occurredAtMs: now - 90_000,
			...(schemaVersion === 2 ? { projectSlug: 'coverage-test' } : {}),
		}, now).outcome).toBe('accepted')
	}
	store.putTargetOverride('2026-09-14', 240, now)
	expect(store.shadow.append(evidence(1, 8, 'execution_start'), now).status).toBe('accepted')
	expect(store.shadow.append(evidence(2, 10), now).status).toBe('accepted')
	const records = store.shadow.records()
	close(store)
	const raw = new Database(path)
	// Remove v7/v8 additions to reproduce the unchanged v6 schema and its accepted rows.
	raw.exec('DROP TABLE shadow_synchronization; DROP TABLE shadow_coverage; PRAGMA user_version = 6')
	const snapshot = () => ({
		schema: raw.query("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE tbl_name NOT IN ('shadow_coverage', 'shadow_synchronization') ORDER BY name").all(),
		rows: ['auth_tokens', 'source_owners', 'events', 'target_overrides', 'shadow_collectors', 'shadow_evidence'].map((table) => raw.query(`SELECT * FROM ${table} ORDER BY rowid`).all()),
	})
	const before = snapshot()
	// Fail after CREATE TABLE, proving rollback removes partial DDL, not just the version write.
	raw.exec('CREATE INDEX shadow_declaration_effective ON events(received_at_ms)')
	expect(() => new ServiceStore(path)).toThrow()
	expect(raw.query('PRAGMA user_version').get()).toEqual({ user_version: 6 })
	expect(raw.query("SELECT name FROM sqlite_schema WHERE tbl_name = 'shadow_coverage'").all()).toEqual([])
	raw.exec('DROP INDEX shadow_declaration_effective')
	expect(snapshot()).toEqual(before)
	const migrated = open(path).store
	expect(snapshot()).toEqual(before)
	expect(migrated.shadow.records()).toEqual(records)
	expect(migrated.shadow.coverageRecords()).toEqual([])
	expect(migrated.shadow.appendCoverage(coverage(declaration(3), 11), now + 86_400_000).status).toBe('accepted')
	expect(migrated.shadow.appendCoverage(coverage(loss(4), 12), now + 86_400_001).status).toBe('accepted')
	expect(snapshot()).toEqual(before)
	const coverageBefore = migrated.shadow.coverageRecords()
	close(migrated)
	const restarted = open(path).store
	expect(restarted.shadow.coverageRecords()).toEqual(coverageBefore)
	expect(restarted.shadow.append(evidence(1, 8, 'execution_start'), now + 172_800_000).status).toBe('duplicate')
	expect(restarted.shadow.appendCoverage(coverage(loss(4), 12), now + 172_800_000).status).toBe('duplicate')
	expect(snapshot()).toEqual(before)
	expect(restarted.integrityCheck()).toBe('ok')
	expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
	close(restarted)
	raw.exec('PRAGMA user_version = 9')
	expect(() => new ServiceStore(path)).toThrow('newer than supported')
	expect(raw.query('PRAGMA user_version').get()).toEqual({ user_version: 9 })
	expect(snapshot()).toEqual(before)
	expect(raw.query('SELECT COUNT(*) AS count FROM shadow_coverage').get()).toEqual({ count: 2 })
	raw.close()
})
