import { Database } from 'bun:sqlite'
import { chmodSync, closeSync, mkdirSync, openSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import {
	LOCAL_PROTOCOL,
	LOCAL_PROTOCOL_VERSION,
	canonicalizeEvidence,
	negotiateVersion,
	parseEvidenceEnvelope,
	parseNegotiationEnvelope,
	parseVersion1NegotiationOffer,
	type Capability,
	type ConformanceResult,
	type Evidence,
} from './local-harness-evidence.ts'

const DATABASE_VERSION = 1
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type CollectorBinding = Readonly<{
	collectorInstanceId: string
	executionSiteId: string
	protocolVersion: typeof LOCAL_PROTOCOL_VERSION
	capabilities: readonly Capability[]
}>

export type NegotiationOutcome =
	| { status: 'accepted'; protocol: typeof LOCAL_PROTOCOL; selectedVersion: 1; binding: CollectorBinding }
	| { status: 'rejected'; reason: 'invalid_offer' | 'collector_binding_conflict' }
	| {
			status: 'unsupported_version'
			protocol: typeof LOCAL_PROTOCOL
			supportedVersions: readonly [1]
	  }

type CollectorRow = {
	executionSiteId: string
}

type EvidenceRow = {
	collectorInstanceId: string
	executionSiteId: string
	protocolVersion: number
	capabilitiesJson: string
	recordJson: string
}

type SegmentRow = {
	collectorInstanceId: string
	executionSiteId: string
	startAtMs: number
	endEvidenceId: string | null
}

/** @internal Exported only so the atomic pre-SQLite permission boundary can be tested directly. */
export function prepareLocalHarnessEvidenceDatabaseFile(path: string): void {
	validateDatabasePath(path)
	let created = false
	try {
		closeSync(openSync(path, 'wx', 0o600))
		created = true
	} catch (error) {
		if (!isFileExistsError(error)) throw error
	}
	if (!created && !statSync(path).isFile()) {
		throw new Error('Receiver database path must identify a regular file')
	}
	chmodSync(path, 0o600)
}

function validateDatabasePath(path: string): void {
	if (path.length === 0 || path !== path.trim() || path === ':memory:') {
		throw new Error('Receiver database requires an exact durable file path')
	}
}

function isFileExistsError(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

/**
 * Transport-independent durable local receiver. The caller supplies the random receiver-owned
 * identity for the authenticated execution site; transport authentication remains outside this core.
 */
export class LocalHarnessEvidenceReceiver {
	readonly #database: Database
	readonly #executionSiteId: string

	constructor(path: string, executionSiteId: string) {
		validateDatabasePath(path)
		if (!UUID_V4.test(executionSiteId)) throw new Error('Execution-site identity must be a UUIDv4')
		this.#executionSiteId = executionSiteId
		const directory = dirname(path)
		const createdDirectory = mkdirSync(directory, { recursive: true, mode: 0o700 })
		if (createdDirectory !== undefined) chmodSync(directory, 0o700)
		prepareLocalHarnessEvidenceDatabaseFile(path)
		this.#database = new Database(path, { create: true, strict: true })
		try {
			this.#database.exec('PRAGMA busy_timeout = 5000')
			this.#database.exec('PRAGMA foreign_keys = ON')
			this.#migrate()
			this.#database.exec('PRAGMA journal_mode = WAL')
		} catch (error) {
			this.#database.close()
			throw error
		}
	}

	negotiate(value: unknown, negotiatedAtMs = Date.now()): NegotiationOutcome {
		const envelope = parseNegotiationEnvelope(value)
		if (envelope === undefined) return { status: 'rejected', reason: 'invalid_offer' }
		const selectedVersion = negotiateVersion(envelope.supportedVersions)
		if (selectedVersion === undefined) {
			return {
				status: 'unsupported_version',
				protocol: LOCAL_PROTOCOL,
				supportedVersions: [LOCAL_PROTOCOL_VERSION],
			}
		}
		const offer = parseVersion1NegotiationOffer(envelope)
		if (offer === undefined) return { status: 'rejected', reason: 'invalid_offer' }

		const capabilities = [...offer.capabilities].sort()
		const capabilitiesJson = JSON.stringify(capabilities)
		const persist = this.#database.transaction((): NegotiationOutcome => {
			const existing = this.#collector(offer.collector_instance_id)
			if (existing && existing.executionSiteId !== this.#executionSiteId) {
				return { status: 'rejected', reason: 'collector_binding_conflict' }
			}
			this.#database
				.query(
					`INSERT INTO collectors
						(collector_instance_id, execution_site_id)
					 VALUES (?, ?)
					 ON CONFLICT (collector_instance_id) DO NOTHING`,
				)
				.run(offer.collector_instance_id, this.#executionSiteId)
			this.#database
				.query(
					`INSERT INTO negotiations
						(collector_instance_id, protocol_version, capabilities_json, negotiated_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT (collector_instance_id, protocol_version, capabilities_json) DO NOTHING`,
				)
				.run(
					offer.collector_instance_id,
					selectedVersion,
					capabilitiesJson,
					new Date(negotiatedAtMs).toISOString(),
				)
			return {
				status: 'accepted',
				protocol: LOCAL_PROTOCOL,
				selectedVersion: LOCAL_PROTOCOL_VERSION,
				binding: Object.freeze({
					collectorInstanceId: offer.collector_instance_id,
					executionSiteId: this.#executionSiteId,
					protocolVersion: LOCAL_PROTOCOL_VERSION,
					capabilities: Object.freeze(capabilities),
				}),
			}
		})
		return persist.immediate()
	}

	submit(binding: CollectorBinding, envelope: unknown, receivedAtMs = Date.now()): ConformanceResult[] {
		const parsed = parseEvidenceEnvelope(envelope, receivedAtMs)
		if ('unsupported' in parsed) {
			return [{ scope: 'envelope', status: 'unsupported_version', reason: 'unsupported_version' }]
		}
		if ('reason' in parsed) {
			return [{ scope: 'envelope', status: 'rejected', reason: parsed.reason }]
		}

		const collector = this.#collector(binding.collectorInstanceId)
		const expectedCapabilities = JSON.stringify([...binding.capabilities].sort())
		const envelopeCapabilities = JSON.stringify([...parsed.capabilities].sort())
		if (
			collector === null ||
			binding.executionSiteId !== this.#executionSiteId ||
			collector.executionSiteId !== this.#executionSiteId ||
			binding.collectorInstanceId !== parsed.collectorInstanceId ||
			binding.protocolVersion !== parsed.protocolVersion ||
			!this.#hasNegotiation(
				binding.collectorInstanceId,
				binding.protocolVersion,
				expectedCapabilities,
			) ||
			envelopeCapabilities !== expectedCapabilities
		) {
			return [{ scope: 'envelope', status: 'rejected', reason: 'invalid_envelope' }]
		}

		const acceptedAt = new Date(receivedAtMs).toISOString()
		const apply = this.#database.transaction((): ConformanceResult[] => {
			const current = this.#collector(binding.collectorInstanceId)
			if (
				current === null ||
				current.executionSiteId !== this.#executionSiteId ||
				!this.#hasNegotiation(
					binding.collectorInstanceId,
					binding.protocolVersion,
					expectedCapabilities,
				)
			) {
				return [{ scope: 'envelope', status: 'rejected', reason: 'invalid_envelope' }]
			}

			const outcomes: ConformanceResult[] = []
			for (const item of parsed.evidence) {
				if ('reason' in item) {
					outcomes.push({ evidence_id: item.evidenceId, status: 'rejected', reason: item.reason })
					continue
				}
				outcomes.push(
					this.#acceptEvidence(
						item.value,
						binding.collectorInstanceId,
						expectedCapabilities,
						acceptedAt,
					),
				)
			}
			return outcomes
		})
		return apply.immediate()
	}

	close(): void {
		this.#database.close()
	}

	#acceptEvidence(
		evidence: Evidence,
		collectorInstanceId: string,
		capabilitiesJson: string,
		acceptedAt: string,
	): ConformanceResult {
		const recordJson = canonicalizeEvidence(evidence)
		const existing = this.#database
			.query<EvidenceRow, [string]>(
				`SELECT collector_instance_id AS collectorInstanceId,
					execution_site_id AS executionSiteId, protocol_version AS protocolVersion,
					capabilities_json AS capabilitiesJson, record_json AS recordJson
				 FROM accepted_evidence WHERE evidence_id = ?`,
			)
			.get(evidence.evidence_id)
		if (existing) {
			const duplicate =
				existing.collectorInstanceId === collectorInstanceId &&
				existing.executionSiteId === this.#executionSiteId &&
				existing.protocolVersion === LOCAL_PROTOCOL_VERSION &&
				existing.capabilitiesJson === capabilitiesJson &&
				existing.recordJson === recordJson
			return duplicate
				? { evidence_id: evidence.evidence_id, status: 'duplicate' }
				: { evidence_id: evidence.evidence_id, status: 'conflict', reason: 'identity_conflict' }
		}

		if (evidence.family === 'execution_start') {
			const segment = this.#segment(evidence.segment_id)
			if (segment) return this.#conflict(evidence.evidence_id)
		} else if (evidence.family === 'execution_end') {
			const segment = this.#segment(evidence.segment_id)
			if (segment?.endEvidenceId) return this.#conflict(evidence.evidence_id)
			if (
				segment &&
				(segment.collectorInstanceId !== collectorInstanceId ||
					segment.executionSiteId !== this.#executionSiteId)
			) {
				return this.#conflict(evidence.evidence_id)
			}
			const endAtMs = Date.parse(evidence.timing.wall_time)
			if (!segment || endAtMs < segment.startAtMs) {
				return { evidence_id: evidence.evidence_id, status: 'rejected', reason: 'invalid_order' }
			}
		}

		this.#database
			.query(
				`INSERT INTO accepted_evidence
					(evidence_id, collector_instance_id, execution_site_id, protocol_version,
					 capabilities_json, family, record_json, accepted_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				evidence.evidence_id,
				collectorInstanceId,
				this.#executionSiteId,
				LOCAL_PROTOCOL_VERSION,
				capabilitiesJson,
				evidence.family,
				recordJson,
				acceptedAt,
			)

		if (evidence.family === 'execution_start') {
			const attribution = evidence.project_attribution
			this.#database
				.query(
					`INSERT INTO execution_segments
						(segment_id, start_evidence_id, collector_instance_id, execution_site_id,
					 start_at, start_at_ms, attribution_kind, project_id, attribution_basis,
					 unassigned_reason)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					evidence.segment_id,
					evidence.evidence_id,
					collectorInstanceId,
					this.#executionSiteId,
					evidence.timing.wall_time,
					Date.parse(evidence.timing.wall_time),
					attribution.kind,
					attribution.kind === 'cukup_project' ? attribution.project_id : null,
					attribution.kind === 'cukup_project' ? attribution.basis : null,
					attribution.kind === 'unassigned' ? attribution.reason : null,
				)
		} else if (evidence.family === 'execution_end') {
			this.#database
				.query(
					`UPDATE execution_segments
					 SET end_evidence_id = ?, end_at = ?, end_at_ms = ?
					 WHERE segment_id = ? AND end_evidence_id IS NULL`,
				)
				.run(
					evidence.evidence_id,
					evidence.timing.wall_time,
					Date.parse(evidence.timing.wall_time),
					evidence.segment_id,
				)
		}
		return { evidence_id: evidence.evidence_id, status: 'accepted' }
	}

	#collector(collectorInstanceId: string): CollectorRow | null {
		return this.#database
			.query<CollectorRow, [string]>(
				`SELECT execution_site_id AS executionSiteId
				 FROM collectors WHERE collector_instance_id = ?`,
			)
			.get(collectorInstanceId)
	}

	#hasNegotiation(
		collectorInstanceId: string,
		protocolVersion: number,
		capabilitiesJson: string,
	): boolean {
		return Boolean(
			this.#database
				.query<{ found: number }, [string, number, string]>(
					`SELECT 1 AS found FROM negotiations
					 WHERE collector_instance_id = ? AND protocol_version = ? AND capabilities_json = ?`,
				)
				.get(collectorInstanceId, protocolVersion, capabilitiesJson),
		)
	}

	#segment(segmentId: string): SegmentRow | null {
		return this.#database
			.query<SegmentRow, [string]>(
				`SELECT collector_instance_id AS collectorInstanceId,
					execution_site_id AS executionSiteId, start_at_ms AS startAtMs,
					end_evidence_id AS endEvidenceId
				 FROM execution_segments WHERE segment_id = ?`,
			)
			.get(segmentId)
	}

	#conflict(evidenceId: string): ConformanceResult {
		return { evidence_id: evidenceId, status: 'conflict', reason: 'identity_conflict' }
	}

	#migrate(): void {
		const migrate = this.#database.transaction(() => {
			const version = this.#database
				.query<{ user_version: number }, []>('PRAGMA user_version')
				.get()!.user_version
			if (version > DATABASE_VERSION) {
				throw new Error(
					`Receiver database schema version ${version} is newer than supported version ${DATABASE_VERSION}`,
				)
			}
			this.#database.exec(`
				CREATE TABLE IF NOT EXISTS collectors (
					collector_instance_id TEXT PRIMARY KEY,
					execution_site_id TEXT NOT NULL
				) STRICT;
				CREATE TABLE IF NOT EXISTS negotiations (
					collector_instance_id TEXT NOT NULL REFERENCES collectors(collector_instance_id),
					protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
					capabilities_json TEXT NOT NULL,
					negotiated_at TEXT NOT NULL,
					PRIMARY KEY (collector_instance_id, protocol_version, capabilities_json)
				) STRICT;
				CREATE TABLE IF NOT EXISTS accepted_evidence (
					evidence_id TEXT PRIMARY KEY,
					collector_instance_id TEXT NOT NULL REFERENCES collectors(collector_instance_id),
					execution_site_id TEXT NOT NULL,
					protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
					capabilities_json TEXT NOT NULL,
					family TEXT NOT NULL CHECK (family IN ('engagement', 'execution_start', 'execution_end')),
					record_json TEXT NOT NULL,
					accepted_at TEXT NOT NULL,
					FOREIGN KEY (collector_instance_id, protocol_version, capabilities_json)
						REFERENCES negotiations(collector_instance_id, protocol_version, capabilities_json)
				) STRICT;
				CREATE TABLE IF NOT EXISTS execution_segments (
					segment_id TEXT PRIMARY KEY,
					start_evidence_id TEXT NOT NULL UNIQUE REFERENCES accepted_evidence(evidence_id),
					end_evidence_id TEXT UNIQUE REFERENCES accepted_evidence(evidence_id),
					collector_instance_id TEXT NOT NULL REFERENCES collectors(collector_instance_id),
					execution_site_id TEXT NOT NULL,
					start_at TEXT NOT NULL,
					start_at_ms INTEGER NOT NULL,
					end_at TEXT,
					end_at_ms INTEGER,
					attribution_kind TEXT NOT NULL CHECK (attribution_kind IN ('cukup_project', 'unassigned')),
					project_id TEXT,
					attribution_basis TEXT,
					unassigned_reason TEXT,
					CHECK ((end_evidence_id IS NULL AND end_at IS NULL AND end_at_ms IS NULL) OR
						(end_evidence_id IS NOT NULL AND end_at IS NOT NULL AND end_at_ms IS NOT NULL)),
					CHECK ((attribution_kind = 'cukup_project' AND project_id IS NOT NULL AND
						attribution_basis IN ('approved_mapping', 'explicit_binding') AND unassigned_reason IS NULL) OR
						(attribution_kind = 'unassigned' AND project_id IS NULL AND attribution_basis IS NULL AND
						unassigned_reason IN ('absent', 'ambiguous')))
				) STRICT;
				PRAGMA user_version = ${DATABASE_VERSION};
			`)
		})
		migrate.immediate()
	}
}
