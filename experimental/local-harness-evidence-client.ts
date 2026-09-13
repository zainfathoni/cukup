import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
	LOCAL_HARNESS_EVIDENCE_MAX_BODY_BYTES,
	LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH,
	LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH,
	isLocalHarnessEvidenceReceiverToken,
} from './local-harness-evidence-http-server.ts'
import { prepareLocalHarnessEvidenceDatabaseFile } from './local-harness-evidence-receiver.ts'
import {
	LOCAL_PROTOCOL,
	LOCAL_PROTOCOL_VERSION,
	canonicalizeEvidence,
	parseEvidenceEnvelope,
	type Capability,
	type EvidenceReason,
} from './local-harness-evidence.ts'

const DATABASE_VERSION = 1
const BUSY_TIMEOUT_MS = 100
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 5 * 60_000] as const
const RESPONSE_MAX_BYTES = 1024 * 1024

export const LOCAL_HARNESS_EVIDENCE_DEFAULT_MAX_QUEUED_RECORDS = 10_000
export const LOCAL_HARNESS_EVIDENCE_DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024
export const LOCAL_HARNESS_EVIDENCE_DEFAULT_MAX_BATCH_RECORDS = 100
export const LOCAL_HARNESS_EVIDENCE_DEFAULT_MAX_BATCH_BYTES = 512 * 1024
export const LOCAL_HARNESS_EVIDENCE_DEFAULT_REQUEST_TIMEOUT_MS = 5_000

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type LocalHarnessEvidenceClientOptions = Readonly<{
	origin: string
	tokenProvider: () => string | Promise<string>
	spoolPath: string
	fetch?: Fetch
	now?: () => number
	maxQueuedRecords?: number
	maxQueuedBytes?: number
	maxBatchRecords?: number
	maxBatchBytes?: number
	requestTimeoutMs?: number
}>

export type EnqueueResult =
	| Readonly<{ status: 'queued'; records: number }>
	| Readonly<{ status: 'rejected'; reason: 'invalid_evidence' | 'batch_too_large' }>
	| Readonly<{ status: 'conflict' }>
	| Readonly<{ status: 'spool_full' }>
	| Readonly<{ status: 'tracking_failed' }>

export type DrainResult = Readonly<{
	status: 'idle' | 'backoff' | 'retryable' | 'blocked' | 'delivered' | 'tracking_failed'
	attempted: number
	delivered: number
	blocked: number
}>

export type SpoolStatus = Readonly<{
	queued: number
	blocked: number
	payloadBytes: number
	retryingGroups: number
	blockedReasons: Readonly<{
		conflict: number
		rejected: number
		unsupported: number
		bindingConflict: number
		transportRejected: number
	}>
}>

type QueueRow = {
	sequence: number
	snapshotId: number
	evidenceId: string
	recordJson: string
	payloadBytes: number
	recordState: 'queued' | 'blocked'
	recordBlockedReason: 'conflict' | 'rejected' | null
	collectorInstanceId: string
	protocolVersion: number
	capabilitiesJson: string
	snapshotState: 'ready' | 'blocked'
	snapshotBlockedReason: 'unsupported' | 'binding_conflict' | 'transport_rejected' | null
	retryAttempt: number
	retryAtMs: number
}

type ExistingQueueIdentity = {
	recordJson: string
	collectorInstanceId: string
	protocolVersion: number
	capabilitiesJson: string
}

type Outcome =
	| { evidence_id: string; status: 'accepted' | 'duplicate' }
	| { evidence_id: string; status: 'conflict'; reason: 'identity_conflict' }
	| { evidence_id: string; status: 'rejected'; reason: EvidenceReason }

type RequestResult =
	| { kind: 'response'; response: Response; body: unknown }
	| { kind: 'retryable' }

/**
 * Programmatic Stage 4B2 collector client. Enqueue is local-only; callers explicitly invoke one
 * bounded drain cycle. Strict FIFO means blocked older evidence prevents later delivery.
 */
export class LocalHarnessEvidenceClient {
	readonly #database: Database
	readonly #origin: string
	readonly #tokenProvider: () => string | Promise<string>
	readonly #fetch: Fetch
	readonly #now: () => number
	readonly #maxQueuedRecords: number
	readonly #maxQueuedBytes: number
	readonly #maxBatchRecords: number
	readonly #maxBatchBytes: number
	readonly #requestTimeoutMs: number

	constructor(options: LocalHarnessEvidenceClientOptions) {
		this.#origin = parseOrigin(options.origin)
		this.#tokenProvider = options.tokenProvider
		this.#fetch = options.fetch ?? fetch
		this.#now = options.now ?? Date.now
		this.#maxQueuedRecords = positiveInteger(
			options.maxQueuedRecords,
			LOCAL_HARNESS_EVIDENCE_DEFAULT_MAX_QUEUED_RECORDS,
		)
		this.#maxQueuedBytes = positiveInteger(
			options.maxQueuedBytes,
			LOCAL_HARNESS_EVIDENCE_DEFAULT_MAX_QUEUED_BYTES,
		)
		this.#maxBatchRecords = positiveInteger(
			options.maxBatchRecords,
			LOCAL_HARNESS_EVIDENCE_DEFAULT_MAX_BATCH_RECORDS,
		)
		this.#maxBatchBytes = positiveInteger(
			options.maxBatchBytes,
			LOCAL_HARNESS_EVIDENCE_DEFAULT_MAX_BATCH_BYTES,
		)
		this.#requestTimeoutMs = positiveInteger(
			options.requestTimeoutMs,
			LOCAL_HARNESS_EVIDENCE_DEFAULT_REQUEST_TIMEOUT_MS,
		)
		if (this.#maxBatchBytes >= LOCAL_HARNESS_EVIDENCE_MAX_BODY_BYTES) {
			throw new Error('Evidence client batch limit must be below the receiver body limit')
		}

		const directory = dirname(options.spoolPath)
		const createdDirectory = mkdirSync(directory, { recursive: true, mode: 0o700 })
		if (createdDirectory !== undefined) chmodSync(directory, 0o700)
		prepareLocalHarnessEvidenceDatabaseFile(options.spoolPath)
		this.#database = new Database(options.spoolPath, { create: true, strict: true })
		try {
			this.#database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
			this.#database.exec('PRAGMA foreign_keys = ON')
			this.#migrate()
			this.#validateQueuedBatchFit()
			this.#database.exec('PRAGMA journal_mode = WAL')
		} catch (error) {
			this.#database.close()
			throw error
		}
	}

	enqueue(value: unknown): EnqueueResult {
		const parsed = parseEvidenceEnvelope(value, this.#now())
		if ('reason' in parsed || 'unsupported' in parsed || parsed.evidence.some((item) => 'reason' in item)) {
			return { status: 'rejected', reason: 'invalid_evidence' }
		}
		if (parsed.evidence.length === 0) return { status: 'queued', records: 0 }

		const capabilitiesJson = JSON.stringify([...parsed.capabilities].sort())
		const recordsById = new Map<string, { evidenceId: string; recordJson: string; payloadBytes: number }>()
		for (const item of parsed.evidence) {
			if ('reason' in item) throw new Error('unreachable')
			const recordJson = canonicalizeEvidence(item.value)
			const record = {
				evidenceId: item.value.evidence_id,
				recordJson,
				payloadBytes: Buffer.byteLength(recordJson),
			}
			const duplicate = recordsById.get(record.evidenceId)
			if (duplicate !== undefined && duplicate.recordJson !== record.recordJson) {
				return { status: 'conflict' }
			}
			recordsById.set(record.evidenceId, record)
		}
		const records = [...recordsById.values()]
		if (
			records.some(
				(record) =>
					encodedEnvelopeBytes(
						parsed.collectorInstanceId,
						parsed.protocolVersion,
						parsed.capabilities,
						[record.recordJson],
					) > this.#maxBatchBytes,
			)
		) {
			return { status: 'rejected', reason: 'batch_too_large' }
		}

		try {
			const persist = this.#database.transaction((): EnqueueResult => {
				const newRecords = [] as typeof records
				const findExisting = this.#database.query<ExistingQueueIdentity, [string]>(
					`SELECT q.record_json AS recordJson,
						s.collector_instance_id AS collectorInstanceId,
						s.protocol_version AS protocolVersion,
						s.capabilities_json AS capabilitiesJson
					 FROM queued_evidence q JOIN delivery_snapshots s ON s.id = q.snapshot_id
					 WHERE q.evidence_id = ?`,
				)
				for (const record of records) {
					const existing = findExisting.get(record.evidenceId)
					if (existing === null) {
						newRecords.push(record)
						continue
					}
					if (
						existing.recordJson !== record.recordJson ||
						existing.collectorInstanceId !== parsed.collectorInstanceId ||
						existing.protocolVersion !== parsed.protocolVersion ||
						existing.capabilitiesJson !== capabilitiesJson
					) {
						return { status: 'conflict' }
					}
				}
				const additionalBytes = newRecords.reduce((sum, record) => sum + record.payloadBytes, 0)
				const totals = this.#database
					.query<{ count: number; bytes: number }, []>(
						'SELECT count(*) AS count, coalesce(sum(payload_bytes), 0) AS bytes FROM queued_evidence',
					)
					.get()!
				if (
					totals.count + newRecords.length > this.#maxQueuedRecords ||
					totals.bytes + additionalBytes > this.#maxQueuedBytes
				) {
					return { status: 'spool_full' }
				}
				this.#database
					.query(
						`INSERT INTO delivery_snapshots
							(collector_instance_id, protocol_version, capabilities_json)
						 VALUES (?, ?, ?)
						 ON CONFLICT (collector_instance_id, protocol_version, capabilities_json) DO NOTHING`,
					)
					.run(parsed.collectorInstanceId, parsed.protocolVersion, capabilitiesJson)
				const snapshot = this.#database
					.query<{ id: number }, [string, number, string]>(
						`SELECT id FROM delivery_snapshots
						 WHERE collector_instance_id = ? AND protocol_version = ? AND capabilities_json = ?`,
					)
					.get(parsed.collectorInstanceId, parsed.protocolVersion, capabilitiesJson)!
				const insert = this.#database.query(
					`INSERT INTO queued_evidence
						(snapshot_id, evidence_id, record_json, payload_bytes)
					 VALUES (?, ?, ?, ?)`,
				)
				for (const record of newRecords) {
					insert.run(snapshot.id, record.evidenceId, record.recordJson, record.payloadBytes)
				}
				return { status: 'queued', records: newRecords.length }
			})
			return persist.immediate()
		} catch {
			return { status: 'tracking_failed' }
		}
	}

	async drainStep(): Promise<DrainResult> {
		let oldest: QueueRow | null
		try {
			oldest = this.#oldest()
		} catch {
			return result('tracking_failed')
		}
		if (oldest === null) return result('idle')
		if (oldest.recordState === 'blocked' || oldest.snapshotState === 'blocked') {
			return result('blocked', 0, 0, 1)
		}
		if (oldest.retryAtMs > this.#now()) return result('backoff')

		const negotiation = await this.#post(LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH, {
			protocol: LOCAL_PROTOCOL,
			supported_versions: [oldest.protocolVersion],
			collector_instance_id: oldest.collectorInstanceId,
			capabilities: JSON.parse(oldest.capabilitiesJson) as Capability[],
		})
		if (negotiation.kind === 'retryable') return this.#retry(oldest.snapshotId)
		const negotiationDisposition = negotiationResult(negotiation.response, negotiation.body)
		if (negotiationDisposition === 'retryable') return this.#retry(oldest.snapshotId)
		if (negotiationDisposition !== 'accepted') {
			return this.#blockSnapshot(oldest.snapshotId, negotiationDisposition)
		}

		let batch: QueueRow[]
		try {
			batch = this.#batch(oldest)
		} catch {
			return result('tracking_failed')
		}
		const evidence = batch.map((row) => JSON.parse(row.recordJson) as unknown)
		const submission = await this.#post(LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH, {
			protocol: LOCAL_PROTOCOL,
			protocol_version: oldest.protocolVersion,
			collector_instance_id: oldest.collectorInstanceId,
			capabilities: JSON.parse(oldest.capabilitiesJson) as Capability[],
			evidence,
		})
		if (submission.kind === 'retryable') return this.#retry(oldest.snapshotId, batch.length)
		if (isRetryableStatus(submission.response.status)) {
			return this.#retry(oldest.snapshotId, batch.length)
		}
		if (submission.response.status !== 200) {
			return this.#blockSnapshot(oldest.snapshotId, 'transport_rejected', batch.length)
		}
		const outcomes = parseOutcomes(submission.body, batch.map((row) => row.evidenceId))
		if (outcomes === undefined) return this.#retry(oldest.snapshotId, batch.length)

		try {
			let delivered = 0
			let blocked = 0
			const apply = this.#database.transaction(() => {
				for (const outcome of outcomes) {
					if (outcome.status === 'accepted' || outcome.status === 'duplicate') {
						this.#database
							.query('DELETE FROM queued_evidence WHERE evidence_id = ? AND snapshot_id = ?')
							.run(outcome.evidence_id, oldest.snapshotId)
						delivered += 1
					} else {
						this.#database
							.query(
								`UPDATE queued_evidence SET record_state = 'blocked', blocked_reason = ?
								 WHERE evidence_id = ? AND snapshot_id = ?`,
							)
							.run(outcome.status, outcome.evidence_id, oldest.snapshotId)
						blocked += 1
					}
				}
				this.#database
					.query('UPDATE delivery_snapshots SET retry_attempt = 0, retry_at_ms = 0 WHERE id = ?')
					.run(oldest.snapshotId)
			})
			apply.immediate()
			return result(blocked > 0 ? 'blocked' : 'delivered', batch.length, delivered, blocked)
		} catch {
			return result('tracking_failed', batch.length)
		}
	}

	status(): SpoolStatus {
		try {
			const row = this.#database
				.query<
					{
						queued: number
						blocked: number
						bytes: number
						retrying: number
						conflict: number
						rejected: number
						unsupported: number
						bindingConflict: number
						transportRejected: number
					},
					[]
				>(
					`SELECT
						coalesce(sum(CASE WHEN q.record_state = 'queued' AND s.snapshot_state = 'ready' THEN 1 ELSE 0 END), 0) AS queued,
						coalesce(sum(CASE WHEN q.record_state = 'blocked' OR s.snapshot_state = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked,
						coalesce(sum(q.payload_bytes), 0) AS bytes,
						count(DISTINCT CASE WHEN s.retry_at_ms > 0 THEN s.id END) AS retrying,
						coalesce(sum(CASE WHEN q.blocked_reason = 'conflict' THEN 1 ELSE 0 END), 0) AS conflict,
						coalesce(sum(CASE WHEN q.blocked_reason = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
						coalesce(sum(CASE WHEN s.blocked_reason = 'unsupported' THEN 1 ELSE 0 END), 0) AS unsupported,
						coalesce(sum(CASE WHEN s.blocked_reason = 'binding_conflict' THEN 1 ELSE 0 END), 0) AS bindingConflict,
						coalesce(sum(CASE WHEN s.blocked_reason = 'transport_rejected' THEN 1 ELSE 0 END), 0) AS transportRejected
					 FROM queued_evidence q JOIN delivery_snapshots s ON s.id = q.snapshot_id`,
				)
				.get()!
			return {
				queued: row.queued,
				blocked: row.blocked,
				payloadBytes: row.bytes,
				retryingGroups: row.retrying,
				blockedReasons: {
					conflict: row.conflict,
					rejected: row.rejected,
					unsupported: row.unsupported,
					bindingConflict: row.bindingConflict,
					transportRejected: row.transportRejected,
				},
			}
		} catch {
			throw new Error('Evidence spool status unavailable')
		}
	}

	close(): void {
		this.#database.close()
	}

	#oldest(): QueueRow | null {
		return this.#database
			.query<QueueRow, []>(`${QUEUE_SELECT} ORDER BY q.sequence LIMIT 1`)
			.get()
	}

	#batch(oldest: QueueRow): QueueRow[] {
		const candidates = this.#database
			.query<QueueRow, [number]>(`${QUEUE_SELECT} WHERE q.sequence >= ? ORDER BY q.sequence`)
			.all(oldest.sequence)
		const selected: QueueRow[] = []
		for (const row of candidates) {
			if (
				row.snapshotId !== oldest.snapshotId ||
				row.recordState !== 'queued' ||
				row.snapshotState !== 'ready' ||
				selected.length >= this.#maxBatchRecords
			) {
				break
			}
			const proposed = [...selected, row]
			const bodyBytes = encodedEnvelopeBytes(
				oldest.collectorInstanceId,
				oldest.protocolVersion,
				JSON.parse(oldest.capabilitiesJson) as Capability[],
				proposed.map((item) => item.recordJson),
			)
			if (bodyBytes > this.#maxBatchBytes) break
			selected.push(row)
		}
		if (selected.length === 0) throw new Error('Oldest evidence exceeds the configured batch limit')
		return selected
	}

	async #post(path: string, body: object): Promise<RequestResult> {
		let token: string
		try {
			token = await this.#tokenProvider()
		} catch {
			return { kind: 'retryable' }
		}
		if (!isLocalHarnessEvidenceReceiverToken(token)) return { kind: 'retryable' }
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs)
		try {
			const response = await this.#fetch(`${this.#origin}${path}`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			})
			const parsed = await readBoundedJson(response)
			return parsed.ok ? { kind: 'response', response, body: parsed.value } : { kind: 'retryable' }
		} catch {
			return { kind: 'retryable' }
		} finally {
			clearTimeout(timeout)
		}
	}

	#retry(snapshotId: number, attempted = 0): DrainResult {
		try {
			const snapshot = this.#database
				.query<{ retryAttempt: number }, [number]>(
					'SELECT retry_attempt AS retryAttempt FROM delivery_snapshots WHERE id = ?',
				)
				.get(snapshotId)!
			const attempt = Math.min(snapshot.retryAttempt + 1, RETRY_DELAYS_MS.length)
			const retryAt = this.#now() + RETRY_DELAYS_MS[attempt - 1]!
			this.#database
				.query('UPDATE delivery_snapshots SET retry_attempt = ?, retry_at_ms = ? WHERE id = ?')
				.run(attempt, retryAt, snapshotId)
			return result('retryable', attempted)
		} catch {
			return result('tracking_failed', attempted)
		}
	}

	#blockSnapshot(
		snapshotId: number,
		reason: 'unsupported' | 'binding_conflict' | 'transport_rejected',
		attempted = 0,
	): DrainResult {
		try {
			this.#database
				.query(
					`UPDATE delivery_snapshots SET snapshot_state = 'blocked', blocked_reason = ? WHERE id = ?`,
				)
				.run(reason, snapshotId)
			return result('blocked', attempted, 0, 1)
		} catch {
			return result('tracking_failed', attempted)
		}
	}

	#validateQueuedBatchFit(): void {
		const rows = this.#database
			.query<QueueRow, []>(
				`${QUEUE_SELECT}
				 WHERE q.record_state = 'queued' AND s.snapshot_state = 'ready'
				 ORDER BY q.sequence`,
			)
			.all()
		for (const row of rows) {
			if (
				encodedEnvelopeBytes(
					row.collectorInstanceId,
					row.protocolVersion,
					JSON.parse(row.capabilitiesJson) as Capability[],
					[row.recordJson],
				) > this.#maxBatchBytes
			) {
				throw new Error('Evidence client batch limit cannot deliver queued evidence')
			}
		}
	}

	#migrate(): void {
		const migrate = this.#database.transaction(() => {
			const version = this.#database
				.query<{ user_version: number }, []>('PRAGMA user_version')
				.get()!.user_version
			if (version > DATABASE_VERSION) {
				throw new Error(
					`Evidence spool schema version ${version} is newer than supported version ${DATABASE_VERSION}`,
				)
			}
			this.#database.exec(`
				CREATE TABLE IF NOT EXISTS delivery_snapshots (
					id INTEGER PRIMARY KEY,
					collector_instance_id TEXT NOT NULL,
					protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
					capabilities_json TEXT NOT NULL,
					snapshot_state TEXT NOT NULL DEFAULT 'ready' CHECK (snapshot_state IN ('ready', 'blocked')),
					blocked_reason TEXT CHECK (blocked_reason IN ('unsupported', 'binding_conflict', 'transport_rejected')),
					retry_attempt INTEGER NOT NULL DEFAULT 0 CHECK (retry_attempt BETWEEN 0 AND 4),
					retry_at_ms INTEGER NOT NULL DEFAULT 0,
					UNIQUE (collector_instance_id, protocol_version, capabilities_json),
					CHECK ((snapshot_state = 'ready' AND blocked_reason IS NULL) OR
						(snapshot_state = 'blocked' AND blocked_reason IS NOT NULL))
				) STRICT;
				CREATE TABLE IF NOT EXISTS queued_evidence (
					sequence INTEGER PRIMARY KEY AUTOINCREMENT,
					snapshot_id INTEGER NOT NULL REFERENCES delivery_snapshots(id),
					evidence_id TEXT NOT NULL UNIQUE,
					record_json TEXT NOT NULL,
					payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0),
					record_state TEXT NOT NULL DEFAULT 'queued' CHECK (record_state IN ('queued', 'blocked')),
					blocked_reason TEXT CHECK (blocked_reason IN ('conflict', 'rejected')),
					CHECK ((record_state = 'queued' AND blocked_reason IS NULL) OR
						(record_state = 'blocked' AND blocked_reason IS NOT NULL))
				) STRICT;
				PRAGMA user_version = ${DATABASE_VERSION};
			`)
		})
		migrate.immediate()
	}
}

const QUEUE_SELECT = `SELECT q.sequence, q.snapshot_id AS snapshotId,
	q.evidence_id AS evidenceId, q.record_json AS recordJson, q.payload_bytes AS payloadBytes,
	q.record_state AS recordState, q.blocked_reason AS recordBlockedReason,
	s.collector_instance_id AS collectorInstanceId, s.protocol_version AS protocolVersion,
	s.capabilities_json AS capabilitiesJson, s.snapshot_state AS snapshotState,
	s.blocked_reason AS snapshotBlockedReason, s.retry_attempt AS retryAttempt,
	s.retry_at_ms AS retryAtMs
	FROM queued_evidence q JOIN delivery_snapshots s ON s.id = q.snapshot_id`

function parseOrigin(value: string): string {
	const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(value)
	if (match === null || Number(match[1]) > 65_535) {
		throw new Error('Evidence client origin must be an exact IPv4 loopback HTTP origin')
	}
	return value
}

function positiveInteger(value: number | undefined, fallback: number): number {
	const selected = value ?? fallback
	if (!Number.isSafeInteger(selected) || selected < 1) {
		throw new Error('Evidence client limits must be positive integers')
	}
	return selected
}

function encodedEnvelopeBytes(
	collectorInstanceId: string,
	protocolVersion: number,
	capabilities: Capability[],
	recordJson: string[],
): number {
	return Buffer.byteLength(
		JSON.stringify({
			protocol: LOCAL_PROTOCOL,
			protocol_version: protocolVersion,
			collector_instance_id: collectorInstanceId,
			capabilities,
			evidence: recordJson.map((record) => JSON.parse(record) as unknown),
		}),
	)
}

function result(
	status: DrainResult['status'],
	attempted = 0,
	delivered = 0,
	blocked = 0,
): DrainResult {
	return { status, attempted, delivered, blocked }
}

function isRetryableStatus(status: number): boolean {
	return status === 401 || status === 408 || status === 425 || status === 429 || status >= 500
}

function negotiationResult(
	response: Response,
	body: unknown,
): 'accepted' | 'retryable' | 'unsupported' | 'binding_conflict' | 'transport_rejected' {
	if (isRetryableStatus(response.status)) return 'retryable'
	if (response.status === 409 && exactObject(body, ['error']) && body.error === 'collector_binding_conflict') {
		return 'binding_conflict'
	}
	if (response.status !== 200 || !isRecord(body)) return 'transport_rejected'
	if (
		exactObject(body, ['protocol', 'selected_version']) &&
		body.protocol === LOCAL_PROTOCOL &&
		body.selected_version === LOCAL_PROTOCOL_VERSION
	) {
		return 'accepted'
	}
	if (
		exactObject(body, ['protocol', 'supported_versions', 'unsupported_versions']) &&
		body.protocol === LOCAL_PROTOCOL &&
		body.unsupported_versions === true &&
		Array.isArray(body.supported_versions) &&
		body.supported_versions.length === 1 &&
		body.supported_versions[0] === LOCAL_PROTOCOL_VERSION
	) {
		return 'unsupported'
	}
	return 'retryable'
}

function parseOutcomes(body: unknown, expectedIds: string[]): Outcome[] | undefined {
	if (!exactObject(body, ['outcomes']) || !Array.isArray(body.outcomes)) return undefined
	if (body.outcomes.length !== expectedIds.length) return undefined
	const expected = new Set(expectedIds)
	const seen = new Set<string>()
	const outcomes: Outcome[] = []
	for (const value of body.outcomes) {
		if (!isRecord(value) || typeof value.evidence_id !== 'string') return undefined
		if (!expected.has(value.evidence_id) || seen.has(value.evidence_id)) return undefined
		seen.add(value.evidence_id)
		if (
			(value.status === 'accepted' || value.status === 'duplicate') &&
			exactObject(value, ['evidence_id', 'status'])
		) {
			outcomes.push(value as Outcome)
		} else if (
			value.status === 'conflict' &&
			value.reason === 'identity_conflict' &&
			exactObject(value, ['evidence_id', 'reason', 'status'])
		) {
			outcomes.push(value as Outcome)
		} else if (
			value.status === 'rejected' &&
			isEvidenceReason(value.reason) &&
			exactObject(value, ['evidence_id', 'reason', 'status'])
		) {
			outcomes.push(value as Outcome)
		} else {
			return undefined
		}
	}
	return outcomes
}

function isEvidenceReason(value: unknown): value is EvidenceReason {
	return (
		value === 'unknown_field' ||
		value === 'prohibited_field' ||
		value === 'invalid_evidence' ||
		value === 'capability_mismatch' ||
		value === 'invalid_timing' ||
		value === 'invalid_order' ||
		value === 'identity_conflict'
	)
}

async function readBoundedJson(
	response: Response,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
	if (response.body === null) return { ok: false }
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let length = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			length += value.byteLength
			if (length > RESPONSE_MAX_BYTES) {
				void reader.cancel().catch(() => undefined)
				return { ok: false }
			}
			chunks.push(value)
		}
		const bytes = new Uint8Array(length)
		let offset = 0
		for (const chunk of chunks) {
			bytes.set(chunk, offset)
			offset += chunk.byteLength
		}
		return {
			ok: true,
			value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
		}
	} catch {
		return { ok: false }
	}
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
	return isRecord(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
