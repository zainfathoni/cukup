import type { Database } from 'bun:sqlite'
import {
	canonicalizeEvidence,
	isUuidV4,
	parseEvidenceEnvelope,
	type Evidence,
} from './harness-evidence-protocol.ts'

/** Installed only by ServiceStore's versioned, immediate migration transaction. */
export const SHADOW_SCHEMA = `
	CREATE TABLE shadow_collectors (
		collector_id TEXT PRIMARY KEY,
		execution_site_id TEXT NOT NULL
	) STRICT;
	CREATE TABLE shadow_evidence (
		evidence_id TEXT PRIMARY KEY,
		collector_id TEXT NOT NULL REFERENCES shadow_collectors(collector_id),
		source_sequence INTEGER NOT NULL CHECK (source_sequence BETWEEN 1 AND 9007199254740991),
		protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
		capabilities_json TEXT NOT NULL,
		family TEXT NOT NULL CHECK (family IN ('engagement', 'execution_start', 'execution_end')),
		segment_id TEXT,
		occurred_at_ms INTEGER NOT NULL,
		record_json TEXT NOT NULL,
		received_at_ms INTEGER NOT NULL,
		CHECK ((family = 'engagement' AND segment_id IS NULL) OR
		       (family != 'engagement' AND segment_id IS NOT NULL)),
		UNIQUE (collector_id, source_sequence)
	) STRICT;
	CREATE UNIQUE INDEX shadow_segment_endpoint ON shadow_evidence(collector_id, segment_id, family)
		WHERE segment_id IS NOT NULL;
	${['shadow_collectors', 'shadow_evidence'].map((table) => `
		CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
		BEGIN SELECT RAISE(ABORT, 'shadow records are append-only'); END;
		CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
		BEGIN SELECT RAISE(ABORT, 'shadow records are append-only'); END;
	`).join('')}
`

export type ShadowOutcome =
	| { status: 'accepted' | 'duplicate' }
	| { status: 'rejected'; reason: 'invalid_record' | 'unsupported_version' | 'identity_conflict' | 'invalid_order' }

export type ShadowRecord = {
	evidenceId: string
	collectorId: string
	executionSiteId: string
	sourceSequence: number
	protocolVersion: 1
	capabilitiesJson: string
	evidence: Evidence
	receivedAtMs: number
}

type Row = Omit<ShadowRecord, 'evidence'> & { recordJson: string }
const SELECT = `SELECT e.evidence_id AS evidenceId, e.collector_id AS collectorId,
	c.execution_site_id AS executionSiteId, e.source_sequence AS sourceSequence,
	e.protocol_version AS protocolVersion, e.capabilities_json AS capabilitiesJson,
	e.record_json AS recordJson, e.received_at_ms AS receivedAtMs
	FROM shadow_evidence e JOIN shadow_collectors c ON c.collector_id = e.collector_id`

/** Internal persistence only. Site UUID is caller-owned, not authentication or a machine label. */
export class ShadowEvidenceStore {
	constructor(private readonly database: Database) {}

	/** One closed envelope containing one fact, plus its immutable source sequence and site. */
	append(input: unknown, receivedAtMs = Date.now()): ShadowOutcome {
		const reject = (reason: Extract<ShadowOutcome, { status: 'rejected' }>['reason']): ShadowOutcome =>
			({ status: 'rejected', reason })
		if (typeof input !== 'object' || input === null || Array.isArray(input)) return reject('invalid_record')
		const record = input as Record<string, unknown>
		if (Object.keys(record).length !== 3 || Object.keys(record).some((key) =>
			!['executionSiteId', 'sourceSequence', 'envelope'].includes(key)) ||
			typeof record.executionSiteId !== 'string' || !isUuidV4(record.executionSiteId) ||
			!Number.isSafeInteger(record.sourceSequence) || (record.sourceSequence as number) < 1 ||
			!Number.isSafeInteger(receivedAtMs) || !Number.isFinite(new Date(receivedAtMs).getTime())) {
			return reject('invalid_record')
		}
		const envelope = parseEvidenceEnvelope(record.envelope, receivedAtMs)
		if ('unsupported' in envelope) return reject('unsupported_version')
		if ('reason' in envelope || envelope.evidence.length !== 1) return reject('invalid_record')
		const parsed = envelope.evidence[0]!
		if ('reason' in parsed) return reject('invalid_record')
		const evidence = parsed.value
		const collector = envelope.collectorInstanceId
		const site = record.executionSiteId
		const sequence = record.sourceSequence as number
		const canonical = canonicalizeEvidence(evidence)
		const capabilities = JSON.stringify([...envelope.capabilities].sort())
		return this.database.transaction((): ShadowOutcome => {
			const existing = this.database.query<Row, [string]>(`${SELECT} WHERE e.evidence_id = ?`).get(evidence.evidence_id)
			if (existing) {
				return existing.collectorId === collector && existing.executionSiteId === site &&
					existing.sourceSequence === sequence && existing.protocolVersion === envelope.protocolVersion &&
					existing.capabilitiesJson === capabilities && existing.recordJson === canonical
					? { status: 'duplicate' } : reject('identity_conflict')
			}
			const binding = this.database.query<{ site: string }, [string]>(
				'SELECT execution_site_id AS site FROM shadow_collectors WHERE collector_id = ?',
			).get(collector)
			if (binding && binding.site !== site) return reject('identity_conflict')
			const latest = this.database.query<{ sequence: number | null }, [string]>(
				'SELECT MAX(source_sequence) AS sequence FROM shadow_evidence WHERE collector_id = ?',
			).get(collector)!.sequence
			if (latest !== null && sequence <= latest) return reject('invalid_order')
			if (evidence.family !== 'engagement') {
				const endpoints = this.database.query<{ family: string; occurred: number }, [string, string]>(
					'SELECT family, occurred_at_ms AS occurred FROM shadow_evidence WHERE collector_id = ? AND segment_id = ?',
				).all(collector, evidence.segment_id)
				if (endpoints.some((endpoint) => endpoint.family === evidence.family)) return reject('identity_conflict')
				if (evidence.family === 'execution_end') {
					const start = endpoints.find((endpoint) => endpoint.family === 'execution_start')
					if (!start || Date.parse(evidence.timing.wall_time) < start.occurred) return reject('invalid_order')
				}
			}
			if (!binding) this.database.query('INSERT INTO shadow_collectors VALUES (?, ?)').run(collector, site)
			this.database.query(`INSERT INTO shadow_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				evidence.evidence_id, collector, sequence, envelope.protocolVersion, capabilities,
				evidence.family, evidence.family === 'engagement' ? null : evidence.segment_id,
				Date.parse(evidence.timing.wall_time), canonical, receivedAtMs,
			)
			return { status: 'accepted' }
		}).immediate()
	}

	records(): ShadowRecord[] {
		return this.database.query<Row, []>(`${SELECT} ORDER BY e.collector_id, e.source_sequence`).all()
			.map(({ recordJson, ...row }) => ({ ...row, evidence: JSON.parse(recordJson) as Evidence }))
	}

	/** Derived endpoints only: no duration, fabricated closure, or mutable attribution. */
	segments(): { start: ShadowRecord; end: ShadowRecord | null; status: 'pending' | 'closed' }[] {
		const records = this.records()
		return records.filter((row) => row.evidence.family === 'execution_start').map((start) => {
			const end = records.find((row) => row.collectorId === start.collectorId &&
				row.evidence.family === 'execution_end' && start.evidence.family === 'execution_start' &&
				row.evidence.segment_id === start.evidence.segment_id) ?? null
			return { start, end, status: end ? 'closed' : 'pending' }
		})
	}
}
