import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	LocalHarnessEvidenceReceiver,
	prepareLocalHarnessEvidenceDatabaseFile,
	type CollectorBinding,
} from './local-harness-evidence-receiver.ts'
import { LOCAL_PROTOCOL, LOCAL_PROTOCOL_VERSION, type Capability } from './local-harness-evidence.ts'

const RECEIVED_AT_MS = Date.parse('2026-09-10T03:00:00.000Z')
const SITE_A = '10000000-0000-4000-8000-000000000001'
const SITE_B = '10000000-0000-4000-8000-000000000002'
const COLLECTOR = '20000000-0000-4000-8000-000000000001'
const PROJECT = '30000000-0000-4000-8000-000000000001'

const temporaryDirectories: string[] = []

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function databasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), 'cukup-receiver-'))
	temporaryDirectories.push(directory)
	return join(directory, 'receiver.sqlite')
}

function offer(capabilities: Capability[], collector = COLLECTOR) {
	return {
		protocol: LOCAL_PROTOCOL,
		supported_versions: [LOCAL_PROTOCOL_VERSION],
		collector_instance_id: collector,
		capabilities,
	}
}

function envelope(capabilities: Capability[], evidence: unknown[], collector = COLLECTOR) {
	return {
		protocol: LOCAL_PROTOCOL,
		protocol_version: LOCAL_PROTOCOL_VERSION,
		collector_instance_id: collector,
		capabilities,
		evidence,
	}
}

function negotiate(receiver: LocalHarnessEvidenceReceiver, capabilities: Capability[]): CollectorBinding {
	const result = receiver.negotiate(offer(capabilities), RECEIVED_AT_MS)
	if (result.status !== 'accepted') throw new Error(`Negotiation failed: ${result.status}`)
	return result.binding
}

function engagement(evidenceId: string, wallTime = '2026-09-10T02:00:00.000Z') {
	return {
		family: 'engagement',
		evidence_id: evidenceId,
		interaction: 'submission',
		origin: 'human',
		recovered: false,
		timing: { wall_time: wallTime, provenance: 'collector_observation', precision_ms: 1 },
		project_attribution: { kind: 'cukup_project', project_id: PROJECT, basis: 'approved_mapping' },
	}
}

function start(evidenceId: string, segmentId: string, wallTime = '2026-09-10T02:00:00.000Z') {
	return {
		family: 'execution_start',
		evidence_id: evidenceId,
		segment_id: segmentId,
		recovered: false,
		timing: { wall_time: wallTime, provenance: 'native_occurrence', precision_ms: 1 },
		project_attribution: { kind: 'cukup_project', project_id: PROJECT, basis: 'explicit_binding' },
	}
}

function end(evidenceId: string, segmentId: string, wallTime = '2026-09-10T02:10:00.000Z') {
	return {
		family: 'execution_end',
		evidence_id: evidenceId,
		segment_id: segmentId,
		recovered: false,
		timing: { wall_time: wallTime, provenance: 'native_occurrence', precision_ms: 1 },
	}
}

function count(path: string, table: string): number {
	const database = new Database(path, { readonly: true, strict: true })
	try {
		return database.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()!.count
	} finally {
		database.close()
	}
}

describe('durable local Harness evidence receiver', () => {
	test('preserves existing parent permissions and restricts new directories and database files', () => {
		const existingParent = mkdtempSync(join(tmpdir(), 'cukup-receiver-existing-'))
		temporaryDirectories.push(existingParent)
		chmodSync(existingParent, 0o750)
		const existingParentDatabase = join(existingParent, 'receiver.sqlite')
		prepareLocalHarnessEvidenceDatabaseFile(existingParentDatabase)
		expect(statSync(existingParentDatabase).mode & 0o777).toBe(0o600)
		let receiver = new LocalHarnessEvidenceReceiver(existingParentDatabase, SITE_A)
		receiver.close()
		expect(statSync(existingParent).mode & 0o777).toBe(0o750)
		expect(statSync(existingParentDatabase).mode & 0o777).toBe(0o600)

		const root = mkdtempSync(join(tmpdir(), 'cukup-receiver-nested-'))
		temporaryDirectories.push(root)
		chmodSync(root, 0o755)
		const first = join(root, 'state')
		const nested = join(first, 'cukup')
		const nestedDatabase = join(nested, 'receiver.sqlite')
		receiver = new LocalHarnessEvidenceReceiver(nestedDatabase, SITE_A)
		receiver.close()
		expect(statSync(root).mode & 0o777).toBe(0o755)
		expect(statSync(first).mode & 0o777).toBe(0o700)
		expect(statSync(nested).mode & 0o777).toBe(0o700)
		expect(statSync(nestedDatabase).mode & 0o777).toBe(0o600)
	})

	test('rejects SQLite anonymous and whitespace-normalized paths before creating a file', () => {
		const root = mkdtempSync(join(tmpdir(), 'cukup-receiver-path-'))
		temporaryDirectories.push(root)
		const exactPath = join(root, 'receiver.sqlite')
		for (const invalidPath of ['', '   ', ':memory:', `${exactPath} `]) {
			expect(() => new LocalHarnessEvidenceReceiver(invalidPath, SITE_A)).toThrow(
				'Receiver database requires an exact durable file path',
			)
		}
		expect(() => statSync(exactPath)).toThrow()
	})

	test('rejects an existing non-file database target without changing its permissions', () => {
		const directory = mkdtempSync(join(tmpdir(), 'cukup-receiver-target-'))
		temporaryDirectories.push(directory)
		chmodSync(directory, 0o750)
		expect(() => new LocalHarnessEvidenceReceiver(directory, SITE_A)).toThrow(
			'Receiver database path must identify a regular file',
		)
		expect(statSync(directory).mode & 0o777).toBe(0o750)
	})

	test('returns duplicate for exact evidence replay after close and reopen', () => {
		const path = databasePath()
		const capabilities: Capability[] = ['engagement.submission']
		const evidence = engagement('40000000-0000-4000-8000-000000000001')
		let receiver = new LocalHarnessEvidenceReceiver(path, SITE_A)
		let binding = negotiate(receiver, capabilities)
		expect(receiver.submit(binding, envelope(capabilities, [evidence]), RECEIVED_AT_MS)).toEqual([
			{ evidence_id: evidence.evidence_id, status: 'accepted' },
		])
		receiver.close()

		receiver = new LocalHarnessEvidenceReceiver(path, SITE_A)
		binding = negotiate(receiver, capabilities)
		expect(receiver.submit(binding, envelope(capabilities, [evidence]), RECEIVED_AT_MS + 1_000)).toEqual([
			{ evidence_id: evidence.evidence_id, status: 'duplicate' },
		])
		receiver.close()
		expect(count(path, 'accepted_evidence')).toBe(1)
	})

	test('closes a pending start after reopen and inherits its attribution without duration state', () => {
		const path = databasePath()
		const capabilities: Capability[] = ['execution.segments']
		const segmentId = '50000000-0000-4000-8000-000000000001'
		let receiver = new LocalHarnessEvidenceReceiver(path, SITE_A)
		let binding = negotiate(receiver, capabilities)
		receiver.submit(
			binding,
			envelope(capabilities, [start('41000000-0000-4000-8000-000000000001', segmentId)]),
			RECEIVED_AT_MS,
		)
		receiver.close()

		let database = new Database(path, { readonly: true, strict: true })
		const pending = database
			.query<
				{ endAt: string | null; projectId: string; basis: string },
				[]
			>(
				`SELECT end_at AS endAt, project_id AS projectId, attribution_basis AS basis
				 FROM execution_segments`,
			)
			.get()!
		expect(pending).toEqual({ endAt: null, projectId: PROJECT, basis: 'explicit_binding' })
		const columns = database
			.query<{ name: string }, []>('SELECT name FROM pragma_table_info(\'execution_segments\')')
			.all()
			.map((row) => row.name)
		expect(columns.some((name) => name.includes('duration'))).toBeFalse()
		database.close()

		receiver = new LocalHarnessEvidenceReceiver(path, SITE_A)
		binding = negotiate(receiver, capabilities)
		const closing = end('41000000-0000-4000-8000-000000000002', segmentId)
		expect(receiver.submit(binding, envelope(capabilities, [closing]), RECEIVED_AT_MS)).toEqual([
			{ evidence_id: closing.evidence_id, status: 'accepted' },
		])
		receiver.close()
		database = new Database(path, { readonly: true, strict: true })
		expect(database.query<{ projectId: string }, []>('SELECT project_id AS projectId FROM execution_segments').get()!.projectId).toBe(PROJECT)
		database.close()
	})

	test('conflicts changed evidence content, changed segment starts, and a second different end', () => {
		const path = databasePath()
		const capabilities: Capability[] = ['engagement.submission', 'execution.segments']
		const receiver = new LocalHarnessEvidenceReceiver(path, SITE_A)
		const binding = negotiate(receiver, capabilities)
		const evidenceId = '42000000-0000-4000-8000-000000000001'
		const segmentId = '52000000-0000-4000-8000-000000000001'
		const firstStart = start('42000000-0000-4000-8000-000000000002', segmentId)
		receiver.submit(binding, envelope(capabilities, [engagement(evidenceId), firstStart]), RECEIVED_AT_MS)

		expect(
			receiver.submit(
				binding,
				envelope(capabilities, [engagement(evidenceId, '2026-09-10T02:00:01.000Z')]),
				RECEIVED_AT_MS,
			),
		).toEqual([{ evidence_id: evidenceId, status: 'conflict', reason: 'identity_conflict' }])
		const changedStart = start(
			'42000000-0000-4000-8000-000000000003',
			segmentId,
			'2026-09-10T02:00:01.000Z',
		)
		expect(receiver.submit(binding, envelope(capabilities, [changedStart]), RECEIVED_AT_MS)).toEqual([
			{ evidence_id: changedStart.evidence_id, status: 'conflict', reason: 'identity_conflict' },
		])
		const firstEnd = end('42000000-0000-4000-8000-000000000004', segmentId)
		expect(receiver.submit(binding, envelope(capabilities, [firstEnd]), RECEIVED_AT_MS)[0]?.status).toBe(
			'accepted',
		)
		const secondEnd = end(
			'42000000-0000-4000-8000-000000000005',
			segmentId,
			'2026-09-10T02:11:00.000Z',
		)
		expect(receiver.submit(binding, envelope(capabilities, [secondEnd]), RECEIVED_AT_MS)).toEqual([
			{ evidence_id: secondEnd.evidence_id, status: 'conflict', reason: 'identity_conflict' },
		])
		const otherCollector = '20000000-0000-4000-8000-000000000002'
		const otherNegotiation = receiver.negotiate(offer(capabilities, otherCollector), RECEIVED_AT_MS)
		if (otherNegotiation.status !== 'accepted') throw new Error('Second collector negotiation failed')
		expect(
			receiver.submit(
				otherNegotiation.binding,
				envelope(capabilities, [engagement(evidenceId)], otherCollector),
				RECEIVED_AT_MS,
			),
		).toEqual([{ evidence_id: evidenceId, status: 'conflict', reason: 'identity_conflict' }])
		const otherSegment = '52000000-0000-4000-8000-000000000002'
		const otherStart = start('42000000-0000-4000-8000-000000000006', otherSegment)
		receiver.submit(binding, envelope(capabilities, [otherStart]), RECEIVED_AT_MS)
		const crossCollectorEnd = end('42000000-0000-4000-8000-000000000007', otherSegment)
		expect(
			receiver.submit(
				otherNegotiation.binding,
				envelope(capabilities, [crossCollectorEnd], otherCollector),
				RECEIVED_AT_MS,
			),
		).toEqual([
			{ evidence_id: crossCollectorEnd.evidence_id, status: 'conflict', reason: 'identity_conflict' },
		])
		receiver.close()
		expect(count(path, 'accepted_evidence')).toBe(4)
	})

	test('rejects collector use at another execution site and capability changes without negotiation', () => {
		const path = databasePath()
		const capabilities: Capability[] = ['engagement.submission']
		let receiver = new LocalHarnessEvidenceReceiver(path, SITE_A)
		const binding = negotiate(receiver, capabilities)
		receiver.close()

		receiver = new LocalHarnessEvidenceReceiver(path, SITE_B)
		expect(receiver.negotiate(offer(capabilities), RECEIVED_AT_MS)).toEqual({
			status: 'rejected',
			reason: 'collector_binding_conflict',
		})
		expect(
			receiver.submit(
				binding,
				envelope(capabilities, [engagement('43000000-0000-4000-8000-000000000001')]),
				RECEIVED_AT_MS,
			),
		).toEqual([{ scope: 'envelope', status: 'rejected', reason: 'invalid_envelope' }])
		receiver.close()

		receiver = new LocalHarnessEvidenceReceiver(path, SITE_A)
		const changed: Capability[] = ['engagement.submission', 'engagement.approval']
		expect(
			receiver.submit(
				binding,
				envelope(changed, [engagement('43000000-0000-4000-8000-000000000002')]),
				RECEIVED_AT_MS,
			),
		).toEqual([{ scope: 'envelope', status: 'rejected', reason: 'invalid_envelope' }])
		receiver.close()
		expect(count(path, 'accepted_evidence')).toBe(0)
	})

	test('keeps old and changed negotiation snapshots valid together across restart', () => {
		const path = databasePath()
		const capabilitiesA: Capability[] = ['engagement.submission']
		const capabilitiesB: Capability[] = ['engagement.submission', 'engagement.approval']
		let receiver = new LocalHarnessEvidenceReceiver(path, SITE_A)
		const bindingA = negotiate(receiver, capabilitiesA)
		const replayed = engagement('48000000-0000-4000-8000-000000000001')
		expect(receiver.submit(bindingA, envelope(capabilitiesA, [replayed]), RECEIVED_AT_MS)[0]?.status).toBe(
			'accepted',
		)
		const changedNegotiation = receiver.negotiate(offer(capabilitiesB), RECEIVED_AT_MS + 1_000)
		if (changedNegotiation.status !== 'accepted') throw new Error('Changed negotiation failed')
		const bindingB = changedNegotiation.binding
		expect(receiver.negotiate(offer(capabilitiesA), RECEIVED_AT_MS + 2_000).status).toBe('accepted')
		receiver.close()

		receiver = new LocalHarnessEvidenceReceiver(path, SITE_A)
		expect(receiver.submit(bindingA, envelope(capabilitiesA, [replayed]), RECEIVED_AT_MS)).toEqual([
			{ evidence_id: replayed.evidence_id, status: 'duplicate' },
		])
		const newA = engagement('48000000-0000-4000-8000-000000000002')
		expect(receiver.submit(bindingA, envelope(capabilitiesA, [newA]), RECEIVED_AT_MS)[0]?.status).toBe(
			'accepted',
		)
		const newB = {
			...engagement('48000000-0000-4000-8000-000000000003'),
			interaction: 'approval',
		}
		expect(receiver.submit(bindingB, envelope(capabilitiesB, [newB]), RECEIVED_AT_MS)[0]?.status).toBe(
			'accepted',
		)
		expect(receiver.submit(bindingA, envelope(capabilitiesB, [newB]), RECEIVED_AT_MS)).toEqual([
			{ scope: 'envelope', status: 'rejected', reason: 'invalid_envelope' },
		])
		expect(receiver.submit(bindingB, envelope(capabilitiesA, [newA]), RECEIVED_AT_MS)).toEqual([
			{ scope: 'envelope', status: 'rejected', reason: 'invalid_envelope' },
		])
		expect(receiver.submit(bindingB, envelope(capabilitiesB, [replayed]), RECEIVED_AT_MS)).toEqual([
			{ evidence_id: replayed.evidence_id, status: 'conflict', reason: 'identity_conflict' },
		])
		receiver.close()
		expect(count(path, 'negotiations')).toBe(2)
		expect(count(path, 'accepted_evidence')).toBe(3)
	})

	test('returns unsupported before reading future-version capabilities but validates selected v1', () => {
		const path = databasePath()
		const receiver = new LocalHarnessEvidenceReceiver(path, SITE_A)
		const unsupported = {
			protocol: LOCAL_PROTOCOL,
			supported_versions: [2],
			collector_instance_id: COLLECTOR,
			get capabilities(): never {
				throw new Error('future-version capabilities were inspected')
			},
		}
		expect(receiver.negotiate(unsupported, RECEIVED_AT_MS)).toEqual({
			status: 'unsupported_version',
			protocol: LOCAL_PROTOCOL,
			supportedVersions: [LOCAL_PROTOCOL_VERSION],
		})
		expect(
			receiver.negotiate(
				{ ...offer(['engagement.submission']), supported_versions: [2, 1], capabilities: ['future'] },
				RECEIVED_AT_MS,
			),
		).toEqual({ status: 'rejected', reason: 'invalid_offer' })
		for (const malformed of [
			null,
			{ ...offer(['engagement.submission']), collector_instance_id: 'not-a-uuid' },
			{ ...offer(['engagement.submission']), supported_versions: [] },
			{ ...offer(['engagement.submission']), supported_versions: [1, 1] },
		]) {
			expect(receiver.negotiate(malformed, RECEIVED_AT_MS)).toEqual({
				status: 'rejected',
				reason: 'invalid_offer',
			})
		}
		receiver.close()
		expect(count(path, 'collectors')).toBe(0)
		expect(count(path, 'negotiations')).toBe(0)
	})

	test('malformed, prohibited, unsupported, and future envelopes write no evidence rows', () => {
		const path = databasePath()
		const capabilities: Capability[] = ['engagement.submission']
		const receiver = new LocalHarnessEvidenceReceiver(path, SITE_A)
		const binding = negotiate(receiver, capabilities)
		const base = engagement('44000000-0000-4000-8000-000000000001')
		expect(receiver.submit(binding, { ...envelope(capabilities, [base]), surprise: true }, RECEIVED_AT_MS)[0]).toMatchObject({ status: 'rejected' })
		expect(receiver.submit(binding, envelope(capabilities, [{ ...base, prompt: 'synthetic' }]), RECEIVED_AT_MS)[0]).toMatchObject({ status: 'rejected', reason: 'prohibited_field' })
		expect(receiver.submit(binding, { ...envelope(capabilities, [base]), protocol_version: 2 }, RECEIVED_AT_MS)[0]).toMatchObject({ status: 'unsupported_version' })
		expect(receiver.submit(binding, envelope(capabilities, [engagement(base.evidence_id, '2026-09-10T03:10:00.001Z')]), RECEIVED_AT_MS)[0]).toMatchObject({ status: 'rejected', reason: 'invalid_timing' })
		receiver.close()
		expect(count(path, 'accepted_evidence')).toBe(0)
	})

	test('persists accepted records from a mixed submission while rejected records reserve nothing', () => {
		const path = databasePath()
		const capabilities: Capability[] = ['engagement.submission']
		const receiver = new LocalHarnessEvidenceReceiver(path, SITE_A)
		const binding = negotiate(receiver, capabilities)
		const accepted = engagement('45000000-0000-4000-8000-000000000001')
		const rejected = { ...engagement('45000000-0000-4000-8000-000000000002'), origin: 'automatic' }
		expect(receiver.submit(binding, envelope(capabilities, [accepted, rejected]), RECEIVED_AT_MS)).toEqual([
			{ evidence_id: accepted.evidence_id, status: 'accepted' },
			{ evidence_id: rejected.evidence_id, status: 'rejected', reason: 'invalid_evidence' },
		])
		receiver.close()
		expect(count(path, 'accepted_evidence')).toBe(1)
	})

	test('SQLite failure rolls back every accepted fact and returns no acknowledgement', () => {
		const path = databasePath()
		const capabilities: Capability[] = ['execution.segments']
		const receiver = new LocalHarnessEvidenceReceiver(path, SITE_A)
		const binding = negotiate(receiver, capabilities)
		const failingId = '46000000-0000-4000-8000-000000000002'
		const injector = new Database(path, { strict: true })
		injector.exec(`
			CREATE TRIGGER inject_storage_failure BEFORE INSERT ON accepted_evidence
			WHEN NEW.evidence_id = '${failingId}'
			BEGIN SELECT RAISE(FAIL, 'injected storage failure'); END
		`)
		injector.close()

		expect(() =>
			receiver.submit(
				binding,
				envelope(capabilities, [
					start(
						'46000000-0000-4000-8000-000000000001',
						'56000000-0000-4000-8000-000000000001',
					),
					start(failingId, '56000000-0000-4000-8000-000000000002'),
				]),
				RECEIVED_AT_MS,
			),
		).toThrow('injected storage failure')
		receiver.close()
		expect(count(path, 'accepted_evidence')).toBe(0)
		expect(count(path, 'execution_segments')).toBe(0)
	})

	test('rejects missing and earlier ends without repair, then accepts a valid boundary', () => {
		const path = databasePath()
		const capabilities: Capability[] = ['execution.segments']
		const receiver = new LocalHarnessEvidenceReceiver(path, SITE_A)
		const binding = negotiate(receiver, capabilities)
		const missingSegment = '57000000-0000-4000-8000-000000000001'
		const segmentId = '57000000-0000-4000-8000-000000000002'
		const missingEnd = end('47000000-0000-4000-8000-000000000001', missingSegment)
		expect(receiver.submit(binding, envelope(capabilities, [missingEnd]), RECEIVED_AT_MS)[0]).toMatchObject({ status: 'rejected', reason: 'invalid_order' })
		const acceptedStart = start('47000000-0000-4000-8000-000000000002', segmentId, '2026-09-10T02:05:00.000Z')
		const earlyEnd = end('47000000-0000-4000-8000-000000000003', segmentId, '2026-09-10T02:04:59.999Z')
		const boundaryEnd = end('47000000-0000-4000-8000-000000000004', segmentId, '2026-09-10T02:05:00.000Z')
		expect(receiver.submit(binding, envelope(capabilities, [acceptedStart, earlyEnd, boundaryEnd]), RECEIVED_AT_MS)).toEqual([
			{ evidence_id: acceptedStart.evidence_id, status: 'accepted' },
			{ evidence_id: earlyEnd.evidence_id, status: 'rejected', reason: 'invalid_order' },
			{ evidence_id: boundaryEnd.evidence_id, status: 'accepted' },
		])
		receiver.close()
		expect(count(path, 'accepted_evidence')).toBe(2)
	})

	test('refuses a future receiver schema without lowering or modifying it', () => {
		const path = databasePath()
		const database = new Database(path, { create: true, strict: true })
		database.exec('PRAGMA journal_mode = DELETE')
		database.exec('PRAGMA user_version = 2')
		database.close()
		expect(() => new LocalHarnessEvidenceReceiver(path, SITE_A)).toThrow(
			'Receiver database schema version 2 is newer than supported version 1',
		)
		const unchanged = new Database(path, { readonly: true, strict: true })
		expect(unchanged.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(2)
		expect(
			unchanged.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()!.journal_mode,
		).toBe('delete')
		expect(
			unchanged
				.query<{ count: number }, []>(
					`SELECT count(*) AS count FROM sqlite_schema
					 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
				)
				.get()!.count,
		).toBe(0)
		unchanged.close()
	})
})
