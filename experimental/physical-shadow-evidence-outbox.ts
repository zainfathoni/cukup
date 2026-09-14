import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { TokenProvider } from '../plugin/auth.ts'
import { validateServiceURL } from '../plugin/protocol.ts'
import {
	LOCAL_PROTOCOL,
	LOCAL_PROTOCOL_VERSION,
	canonicalizeEvidence,
	isUuidV4,
	parseEvidenceEnvelope,
	type Capability,
} from './local-harness-evidence.ts'

const DATABASE_VERSION = 2
const RESPONSE_MAX_BYTES = 16 * 1024
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 5 * 60_000] as const
const SYNCHRONIZATION_INTERVAL_MS = 60_000
const MAX_TIME = 253402300799999

type SynchronizationCandidate = {
	protocol_version: 1
	collector_instance_id: string
	observation_sequence: number
	observed_at_ms: number
	state: 'clear' | 'queued' | 'retrying' | 'blocked'
	records: number
	bytes: number
	oldest_queued_at_ms: number | null
}
export type PhysicalShadowSynchronizationResult =
	| 'waiting' | 'disabled' | 'suspended' | 'unavailable'
	| 'accepted' | 'duplicate' | 'retryable' | 'registration_required' | 'clock_repair_required'
type SynchronizationRow = { sequence: number; pending: string | null; stale: number }

export const PHYSICAL_SHADOW_DEFAULT_MAX_QUEUED_RECORDS = 10_000
export const PHYSICAL_SHADOW_DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024
export const PHYSICAL_SHADOW_DEFAULT_MAX_RECORD_BYTES = 512 * 1024
export const PHYSICAL_SHADOW_DEFAULT_REQUEST_TIMEOUT_MS = 10_000

type Fetch = (input: string, init: RequestInit) => Promise<Response>

export type PhysicalShadowEvidenceOutboxOptions = Readonly<{
	serviceURL: string
	tokenProvider: TokenProvider
	executorHostname: string
	capabilities: readonly Capability[]
	spoolPath: string
	fetch?: Fetch
	now?: () => number
	monotonicNow?: () => number
	randomId?: () => string
	maxQueuedRecords?: number
	maxQueuedBytes?: number
	maxRecordBytes?: number
	requestTimeoutMs?: number
}>

export type PhysicalShadowEnqueueResult =
	| Readonly<{ status: 'queued'; records: 0 | 1 }>
	| Readonly<{ status: 'rejected'; reason: 'invalid_evidence' | 'record_too_large' }>
	| Readonly<{ status: 'conflict' | 'spool_full' | 'tracking_failed' }>

export type PhysicalShadowDrainResult = Readonly<{
	status: 'idle' | 'backoff' | 'retryable' | 'blocked' | 'delivered' | 'tracking_failed'
	attempted: 0 | 1
	delivered: 0 | 1
}>

export type PhysicalShadowSpoolStatus = Readonly<{
	queued: number
	blocked: number
	payloadBytes: number
	retrying: number
	blockedReasons: Readonly<{
		invalidRecord: number
		unsupportedVersion: number
		identityConflict: number
		invalidOrder: number
		profile: number
		transport: number
		invalidResponse: number
	}>
}>

type BlockedReason =
	| 'invalid_record'
	| 'unsupported_version'
	| 'identity_conflict'
	| 'invalid_order'
	| 'profile'
	| 'transport'
	| 'invalid_response'

type QueueRow = {
	sourceSequence: number
	evidenceId: string
	envelopeJson: string
	payloadBytes: number
	state: 'queued' | 'blocked'
	blockedReason: BlockedReason | null
	retryAttempt: number
	retryAtMs: number
}

type RequestResult =
	| { kind: 'response'; response: Response; body: unknown; bodyValid: boolean }
	| { kind: 'retryable' }

/**
 * Stage 5C physical-site cloud shadow outbox. Enqueue is local-only and assigns the durable
 * collector identity and source sequence; callers explicitly invoke one bounded FIFO drain step.
 */
export class PhysicalShadowEvidenceOutbox {
	readonly #ownership: Database
	readonly #database: Database
	readonly #serviceOrigin: string
	readonly #tokenProvider: TokenProvider
	readonly #executorHostname: string
	readonly #capabilities: Capability[]
	readonly #fetch: Fetch
	readonly #now: () => number
	readonly #maxQueuedRecords: number
	readonly #maxQueuedBytes: number
	readonly #maxRecordBytes: number
	readonly #requestTimeoutMs: number
	readonly #collectorId: string
	#draining: Promise<PhysicalShadowDrainResult> | undefined
	readonly #monotonicNow: () => number
	#lastSynchronization: number
	#lastSynchronizationReading: number
	#synchronizing: Promise<PhysicalShadowSynchronizationResult> | undefined
	#synchronizationSuspended = false
	#staleUnpersisted = false
	#synchronizationDisabled = false

	constructor(options: PhysicalShadowEvidenceOutboxOptions) {
		this.#serviceOrigin = validateServiceURL(options.serviceURL).origin
		this.#tokenProvider = options.tokenProvider
		this.#executorHostname = validateHostname(options.executorHostname)
		this.#fetch = options.fetch ?? fetch
		this.#now = options.now ?? Date.now
		this.#monotonicNow = options.monotonicNow ?? (() => performance.now())
		try { this.#lastSynchronization = this.#monotonicNow() }
		catch { this.#lastSynchronization = NaN }
		this.#lastSynchronizationReading = this.#lastSynchronization
		this.#maxQueuedRecords = positiveInteger(
			options.maxQueuedRecords,
			PHYSICAL_SHADOW_DEFAULT_MAX_QUEUED_RECORDS,
		)
		this.#maxQueuedBytes = positiveInteger(
			options.maxQueuedBytes,
			PHYSICAL_SHADOW_DEFAULT_MAX_QUEUED_BYTES,
		)
		this.#maxRecordBytes = positiveInteger(
			options.maxRecordBytes,
			PHYSICAL_SHADOW_DEFAULT_MAX_RECORD_BYTES,
		)
		this.#requestTimeoutMs = positiveInteger(
			options.requestTimeoutMs,
			PHYSICAL_SHADOW_DEFAULT_REQUEST_TIMEOUT_MS,
		)
		this.#capabilities = validateCapabilities(options.capabilities)

		prepareSpoolDirectory(options.spoolPath)
		this.#ownership = acquireOwnership(`${options.spoolPath}.owner`)
		let database: Database
		try {
			prepareDatabaseFile(options.spoolPath)
			prepareExistingFile(`${options.spoolPath}-wal`)
			prepareExistingFile(`${options.spoolPath}-shm`)
			database = new Database(options.spoolPath, { create: true, strict: true })
		} catch (error) {
			this.#ownership.close()
			throw error
		}
		this.#database = database
		try {
			this.#database.exec('PRAGMA busy_timeout = 100')
			this.#migrate()
			this.#collectorId = this.#initializeCollector(options.randomId ?? randomUUID)
			this.#database.exec('PRAGMA journal_mode = WAL')
			prepareExistingFile(`${options.spoolPath}-wal`)
			prepareExistingFile(`${options.spoolPath}-shm`)
		} catch (error) {
			this.#database.close()
			this.#ownership.close()
			throw error
		}
	}

	enqueue(value: unknown): PhysicalShadowEnqueueResult {
		const candidate = {
			protocol: LOCAL_PROTOCOL,
			protocol_version: LOCAL_PROTOCOL_VERSION,
			collector_instance_id: this.#collectorId,
			capabilities: this.#capabilities,
			evidence: [value],
		}
		const parsed = parseEvidenceEnvelope(candidate, this.#now())
		if (
			'reason' in parsed ||
			'unsupported' in parsed ||
			parsed.evidence.length !== 1 ||
			'reason' in parsed.evidence[0]!
		) {
			return { status: 'rejected', reason: 'invalid_evidence' }
		}
		const evidence = parsed.evidence[0].value
		const envelopeJson = JSON.stringify({
			protocol: LOCAL_PROTOCOL,
			protocol_version: LOCAL_PROTOCOL_VERSION,
			collector_instance_id: this.#collectorId,
			capabilities: this.#capabilities,
			evidence: [JSON.parse(canonicalizeEvidence(evidence)) as unknown],
		})
		const payloadBytes = encodedRequestBytes(Number.MAX_SAFE_INTEGER, envelopeJson)
		if (payloadBytes > this.#maxRecordBytes) {
			return { status: 'rejected', reason: 'record_too_large' }
		}

		try {
			return this.#database.transaction((): PhysicalShadowEnqueueResult => {
				const existing = this.#database
					.query<{ envelopeJson: string }, [string]>(
						'SELECT envelope_json AS envelopeJson FROM physical_shadow_outbox WHERE evidence_id = ?',
					)
					.get(evidence.evidence_id)
				if (existing !== null) {
					return existing.envelopeJson === envelopeJson
						? { status: 'queued', records: 0 }
						: { status: 'conflict' }
				}
				const totals = this.#database
					.query<{ count: number; bytes: number }, []>(
						`SELECT count(*) AS count, coalesce(sum(payload_bytes), 0) AS bytes
						 FROM physical_shadow_outbox`,
					)
					.get()!
				const latest = this.#database
					.query<{ sequence: number }, []>(
						`SELECT coalesce(max(source_sequence), 0) AS sequence FROM physical_shadow_outbox`,
					)
					.get()!.sequence
				if (
					totals.count >= this.#maxQueuedRecords ||
					totals.bytes + payloadBytes > this.#maxQueuedBytes ||
					latest >= Number.MAX_SAFE_INTEGER
				) {
					return { status: 'spool_full' }
				}
				this.#database
					.query(
						`INSERT INTO physical_shadow_outbox
							(evidence_id, envelope_json, payload_bytes) VALUES (?, ?, ?)`,
					)
					.run(evidence.evidence_id, envelopeJson, payloadBytes)
				return { status: 'queued', records: 1 }
			}).immediate()
		} catch {
			return { status: 'tracking_failed' }
		}
	}

	drainStep(): Promise<PhysicalShadowDrainResult> {
		if (this.#draining !== undefined) return this.#draining
		this.#draining = this.#drain().finally(() => {
			this.#draining = undefined
		})
		return this.#draining
	}

	/** Explicit, inactive status lane. Default replaces pending with a fresh higher revision.
	 * Exact retry is useful after acknowledgement loss; it cannot renew freshness.
	 */
	synchronizationStep(mode: 'fresh' | 'retry' = 'fresh'): Promise<PhysicalShadowSynchronizationResult> {
		if (this.#synchronizing !== undefined) return this.#synchronizing
		this.#synchronizing = this.#synchronize(mode).finally(() => {
			this.#synchronizing = undefined
		})
		return this.#synchronizing
	}

	async #synchronize(mode: 'fresh' | 'retry'): Promise<PhysicalShadowSynchronizationResult> {
		if (this.#synchronizationDisabled) return 'disabled'
		if (this.#synchronizationSuspended) {
			try { this.#persistStaleSuspension() } catch { return 'unavailable' }
			return 'suspended'
		}
		let candidate: string
		try {
			const elapsed = this.#monotonicNow()
			if (!Number.isFinite(elapsed) || !Number.isFinite(this.#lastSynchronizationReading) || elapsed < this.#lastSynchronizationReading) {
				this.#synchronizationDisabled = true
				return 'disabled'
			}
			this.#lastSynchronizationReading = elapsed
			if (elapsed - this.#lastSynchronization < SYNCHRONIZATION_INTERVAL_MS) return 'waiting'
			this.#lastSynchronization = elapsed
			const sampled = this.#database.transaction(() => {
				const row = this.#database.query<SynchronizationRow, []>(
					'SELECT sequence, pending, stale FROM physical_shadow_synchronization WHERE singleton = 1',
				).get()
				if (!row || !integer(row.sequence, 0, Number.MAX_SAFE_INTEGER) ||
					(row.stale !== 0 && row.stale !== 1) ||
					(row.pending !== null && !validPending(row.pending, row.sequence, this.#collectorId))) {
					this.#synchronizationDisabled = true
					return undefined
				}
				if (row.stale === 1) {
					this.#synchronizationSuspended = true
					return undefined
				}
				if (row.sequence === Number.MAX_SAFE_INTEGER) {
					this.#synchronizationDisabled = true
					return undefined
				}
				if (mode === 'retry' && row.pending !== null) return row.pending
				const body = this.#sampleSynchronization(row.sequence + 1)
				const pending = JSON.stringify(body)
				this.#database.query(`UPDATE physical_shadow_synchronization
					SET sequence = ?, pending = ? WHERE singleton = 1`).run(body.observation_sequence, pending)
				return pending
			}).immediate()
			if (sampled === undefined) return this.#synchronizationDisabled ? 'disabled' : 'suspended'
			candidate = sampled
		} catch {
			// Missing tables and unreadable/corrupt spools never imply an empty snapshot.
			return 'unavailable'
		}
		const outcome = await this.#requestSynchronization(candidate)
		try {
			if (outcome === 'accepted' || outcome === 'duplicate') {
				this.#database.query(`UPDATE physical_shadow_synchronization SET pending = NULL
					WHERE singleton = 1 AND pending = ?`).run(candidate)
			} else if (outcome === 'stale') {
				this.#synchronizationSuspended = true
				this.#staleUnpersisted = true
				this.#persistStaleSuspension()
			} else if (outcome === 'suspended') this.#synchronizationSuspended = true
		} catch { return 'unavailable' }
		return outcome === 'stale' ? 'suspended' : outcome
	}

	#persistStaleSuspension(): void {
		if (!this.#staleUnpersisted) return
		const change = this.#database.query('UPDATE physical_shadow_synchronization SET stale = 1 WHERE singleton = 1').run()
		if (change.changes !== 1) throw new Error('Synchronization unavailable')
		this.#staleUnpersisted = false
	}

	#sampleSynchronization(sequence: number): SynchronizationCandidate {
		const observed = this.#now()
		if (!integer(observed, 0, MAX_TIME)) throw new Error('Synchronization unavailable')
		let records = 0, bytes = 0, blocked = false, retrying = false
		let oldest: number | null = null
		const rows = this.#database.query<QueueRow, []>(`SELECT source_sequence AS sourceSequence,
			evidence_id AS evidenceId, envelope_json AS envelopeJson, payload_bytes AS payloadBytes,
			state, blocked_reason AS blockedReason, retry_attempt AS retryAttempt, retry_at_ms AS retryAtMs
			FROM physical_shadow_outbox`).iterate()
		for (const row of rows) {
			const parsed = parseEvidenceEnvelope(JSON.parse(row.envelopeJson), observed)
			if ('reason' in parsed || 'unsupported' in parsed || parsed.collectorInstanceId !== this.#collectorId ||
				parsed.evidence.length !== 1 || 'reason' in parsed.evidence[0]!) throw new Error('Synchronization unavailable')
			const evidence = parsed.evidence[0].value
			// Only these current evidence families define participation; no future fact/time fallback.
			if (!['engagement', 'execution_start', 'execution_end'].includes(evidence.family) ||
				evidence.evidence_id !== row.evidenceId || !integer(row.sourceSequence, 1, Number.MAX_SAFE_INTEGER) ||
				!integer(row.payloadBytes, 1, Number.MAX_SAFE_INTEGER) ||
				!integer(row.retryAttempt, 0, 4) || !integer(row.retryAtMs, 0, Number.MAX_SAFE_INTEGER) ||
				!['queued', 'blocked'].includes(row.state) ||
				(row.state === 'queued' ? row.blockedReason !== null : ![
					'invalid_record', 'unsupported_version', 'identity_conflict', 'invalid_order',
					'profile', 'transport', 'invalid_response',
				].includes(row.blockedReason!))) throw new Error('Synchronization unavailable')
			const occurrence = Date.parse(evidence.timing.wall_time)
			if (!integer(occurrence, 0, MAX_TIME) || occurrence > observed + 600000) throw new Error('Synchronization unavailable')
			records = Math.min(10000, records + 1)
			bytes = Math.min(8388608, bytes + row.payloadBytes)
			oldest = oldest === null ? occurrence : Math.min(oldest, occurrence)
			blocked ||= row.state === 'blocked'
			retrying ||= row.state === 'queued' && (row.retryAtMs > 0 || row.retryAttempt > 0)
		}
		return {
			protocol_version: 1, collector_instance_id: this.#collectorId, observation_sequence: sequence,
			observed_at_ms: observed, state: records === 0 ? 'clear' : blocked ? 'blocked' : retrying ? 'retrying' : 'queued',
			records, bytes, oldest_queued_at_ms: oldest,
		}
	}

	async #requestSynchronization(candidate: string): Promise<SynchronizationTransportOutcome> {
		const controller = new AbortController()
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
		let timer: ReturnType<typeof setTimeout> | undefined
		const request = async (): Promise<SynchronizationTransportOutcome> => {
			try {
				const token = await this.#tokenProvider.getToken()
				if (controller.signal.aborted || token.length < 32 || token.length > 16 * 1024 || /\s/.test(token)) return 'retryable'
				const response = await this.#fetch(`${this.#serviceOrigin}/v1/shadow-synchronization`, {
					method: 'POST', redirect: 'manual', signal: controller.signal,
					headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` },
					body: candidate,
				})
				if (controller.signal.aborted || !response.body ||
					!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '') ||
					response.headers.has('content-encoding')) {
					void response.body?.cancel().catch(() => {})
					return 'retryable'
				}
				reader = response.body.getReader()
				const bytes = new Uint8Array(1024)
				let length = 0
				for (;;) {
					const chunk = await reader.read()
					if (chunk.done) break
					if (length + chunk.value.byteLength > bytes.length) return 'retryable'
					bytes.set(chunk.value, length)
					length += chunk.value.byteLength
				}
				const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length))
				return classifySynchronization(response.status, text)
			} catch { return 'retryable' }
		}
		try {
			return await Promise.race([request(), new Promise<SynchronizationTransportOutcome>((resolve) => {
				timer = setTimeout(() => resolve('retryable'), 5000)
			})])
		} finally {
			clearTimeout(timer)
			controller.abort()
			void reader?.cancel().catch(() => {})
		}
	}

	async #drain(): Promise<PhysicalShadowDrainResult> {
		let row: QueueRow | null
		try {
			row = this.#oldest()
		} catch {
			return drainResult('tracking_failed')
		}
		if (row === null) return drainResult('idle')
		if (row.state === 'blocked') return drainResult('blocked')
		if (row.retryAtMs > this.#now()) return drainResult('backoff')

		let token: string
		try {
			token = await this.#tokenProvider.getToken()
		} catch {
			return this.#retry(row.sourceSequence)
		}
		if (token.length < 32 || token.length > 16 * 1024 || /\s/.test(token)) {
			return this.#retry(row.sourceSequence)
		}

		const profile = await this.#request('/v1/executor-profile', token, 'PUT', {
			hostname: this.#executorHostname,
		})
		if (profile.kind === 'retryable') return this.#retry(row.sourceSequence)
		if (isRetryableStatus(profile.response.status)) return this.#retry(row.sourceSequence)
		if (
			profile.response.status !== 200 ||
			!profile.bodyValid ||
			!exactObject(profile.body, ['executor_label']) ||
			profile.body.executor_label !== this.#executorHostname
		) {
			return this.#block(
				row.sourceSequence,
				profile.response.status === 200 ? 'invalid_response' : 'profile',
			)
		}

		const envelope = JSON.parse(row.envelopeJson) as unknown
		const delivery = await this.#request('/v1/shadow-evidence', token, 'POST', {
			source_sequence: row.sourceSequence,
			envelope,
		})
		token = ''
		if (delivery.kind === 'retryable') return this.#retry(row.sourceSequence, 1)
		if (isRetryableStatus(delivery.response.status)) return this.#retry(row.sourceSequence, 1)
		if (delivery.response.status !== 200) {
			return this.#block(row.sourceSequence, 'transport', 1)
		}
		if (!delivery.bodyValid) return this.#block(row.sourceSequence, 'invalid_response', 1)
		const outcome = parseShadowOutcome(delivery.body)
		if (outcome === undefined) return this.#block(row.sourceSequence, 'invalid_response', 1)
		if (outcome.status !== 'rejected') {
			try {
				const change = this.#database
					.query(`DELETE FROM physical_shadow_outbox WHERE source_sequence = ? AND state = 'queued'`)
					.run(row.sourceSequence)
				if (change.changes !== 1) return drainResult('tracking_failed', 1)
				return drainResult('delivered', 1, 1)
			} catch {
				return drainResult('tracking_failed', 1)
			}
		}
		return this.#block(row.sourceSequence, outcome.reason, 1)
	}

	status(): PhysicalShadowSpoolStatus {
		try {
			const row = this.#database
				.query<{
					queued: number
					blocked: number
					bytes: number
					retrying: number
					invalidRecord: number
					unsupportedVersion: number
					identityConflict: number
					invalidOrder: number
					profile: number
					transport: number
					invalidResponse: number
				}, []>(
					`SELECT
						coalesce(sum(state = 'queued'), 0) AS queued,
						coalesce(sum(state = 'blocked'), 0) AS blocked,
						coalesce(sum(payload_bytes), 0) AS bytes,
						coalesce(sum(state = 'queued' AND retry_at_ms > 0), 0) AS retrying,
						coalesce(sum(blocked_reason = 'invalid_record'), 0) AS invalidRecord,
						coalesce(sum(blocked_reason = 'unsupported_version'), 0) AS unsupportedVersion,
						coalesce(sum(blocked_reason = 'identity_conflict'), 0) AS identityConflict,
						coalesce(sum(blocked_reason = 'invalid_order'), 0) AS invalidOrder,
						coalesce(sum(blocked_reason = 'profile'), 0) AS profile,
						coalesce(sum(blocked_reason = 'transport'), 0) AS transport,
						coalesce(sum(blocked_reason = 'invalid_response'), 0) AS invalidResponse
					 FROM physical_shadow_outbox`,
				)
				.get()!
			return {
				queued: row.queued,
				blocked: row.blocked,
				payloadBytes: row.bytes,
				retrying: row.retrying,
				blockedReasons: {
					invalidRecord: row.invalidRecord,
					unsupportedVersion: row.unsupportedVersion,
					identityConflict: row.identityConflict,
					invalidOrder: row.invalidOrder,
					profile: row.profile,
					transport: row.transport,
					invalidResponse: row.invalidResponse,
				},
			}
		} catch {
			throw new Error('Physical shadow spool status unavailable')
		}
	}

	close(): void {
		if (this.#draining !== undefined) {
			throw new Error('Physical shadow drain must finish before close')
		}
		if (this.#synchronizing !== undefined) {
			throw new Error('Physical shadow synchronization must finish before close')
		}
		try { this.#persistStaleSuspension() }
		catch { throw new Error('Physical shadow synchronization suspension must persist before close') }
		this.#database.close()
		this.#ownership.close()
	}

	#oldest(): QueueRow | null {
		return this.#database
			.query<QueueRow, []>(
				`SELECT source_sequence AS sourceSequence, evidence_id AS evidenceId,
					envelope_json AS envelopeJson, payload_bytes AS payloadBytes, state,
					blocked_reason AS blockedReason, retry_attempt AS retryAttempt,
					retry_at_ms AS retryAtMs
				 FROM physical_shadow_outbox ORDER BY source_sequence LIMIT 1`,
			)
			.get()
	}

	async #request(path: string, token: string, method: 'PUT' | 'POST', body: object): Promise<RequestResult> {
		if (token.length < 32 || token.length > 16 * 1024 || /\s/.test(token)) return { kind: 'retryable' }
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs)
		try {
			const response = await this.#fetch(`${this.#serviceOrigin}${path}`, {
				method,
				headers: {
					accept: 'application/json',
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(body),
				signal: controller.signal,
				redirect: 'manual',
			})
			if (response.status !== 200) {
				void response.body?.cancel().catch(() => undefined)
				return { kind: 'response', response, body: undefined, bodyValid: false }
			}
			const parsed = await readBoundedJson(response)
			if (parsed.kind === 'interrupted') return { kind: 'retryable' }
			return parsed.kind === 'parsed'
				? { kind: 'response', response, body: parsed.value, bodyValid: true }
				: { kind: 'response', response, body: undefined, bodyValid: false }
		} catch {
			return { kind: 'retryable' }
		} finally {
			clearTimeout(timeout)
		}
	}

	#retry(sourceSequence: number, attempted: 0 | 1 = 0): PhysicalShadowDrainResult {
		try {
			const current = this.#database
				.query<{ attempt: number }, [number]>(
					'SELECT retry_attempt AS attempt FROM physical_shadow_outbox WHERE source_sequence = ?',
				)
				.get(sourceSequence)!
			const attempt = Math.min(current.attempt + 1, RETRY_DELAYS_MS.length)
			const change = this.#database
				.query('UPDATE physical_shadow_outbox SET retry_attempt = ?, retry_at_ms = ? WHERE source_sequence = ?')
				.run(attempt, this.#now() + RETRY_DELAYS_MS[attempt - 1]!, sourceSequence)
			if (change.changes !== 1) return drainResult('tracking_failed', attempted)
			return drainResult('retryable', attempted)
		} catch {
			return drainResult('tracking_failed', attempted)
		}
	}

	#block(
		sourceSequence: number,
		reason: BlockedReason,
		attempted: 0 | 1 = 0,
	): PhysicalShadowDrainResult {
		try {
			const change = this.#database
				.query(
					`UPDATE physical_shadow_outbox SET state = 'blocked', blocked_reason = ?
					 WHERE source_sequence = ? AND state = 'queued'`,
				)
				.run(reason, sourceSequence)
			if (change.changes !== 1) return drainResult('tracking_failed', attempted)
			return drainResult('blocked', attempted)
		} catch {
			return drainResult('tracking_failed', attempted)
		}
	}

	#migrate(): void {
		const version = this.#database.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version
		if (version > DATABASE_VERSION) {
			throw new Error(`Physical shadow spool schema version ${version} is newer than supported version ${DATABASE_VERSION}`)
		}
		if (version === DATABASE_VERSION) return // Never recreate initialized synchronization state.
		this.#database.transaction(() => {
			if (version === 1) {
				const identity = this.#database.query<{ value: string }, []>(
					"SELECT value FROM physical_shadow_settings WHERE key = 'collector_id'",
				).get()
				const columns = this.#database.query<{ name: string }, []>('PRAGMA table_info(physical_shadow_outbox)').all()
				if (!identity || !isUuidV4(identity.value) || columns.map((column) => column.name).join(',') !==
					'source_sequence,evidence_id,envelope_json,payload_bytes,state,blocked_reason,retry_attempt,retry_at_ms') {
					throw new Error('Physical shadow spool migration unavailable')
				}
			} else if (version !== 0 || this.#database.query('SELECT name FROM sqlite_master WHERE type = \'table\'').get()) {
				throw new Error('Physical shadow spool migration unavailable')
			}
			this.#database.exec(`
				CREATE TABLE IF NOT EXISTS physical_shadow_settings (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				) STRICT;
				CREATE TABLE IF NOT EXISTS physical_shadow_outbox (
					source_sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (source_sequence BETWEEN 1 AND 9007199254740991),
					evidence_id TEXT NOT NULL UNIQUE,
					envelope_json TEXT NOT NULL,
					payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0),
					state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'blocked')),
					blocked_reason TEXT CHECK (blocked_reason IN (
						'invalid_record', 'unsupported_version', 'identity_conflict', 'invalid_order',
						'profile', 'transport', 'invalid_response'
					)),
					retry_attempt INTEGER NOT NULL DEFAULT 0 CHECK (retry_attempt BETWEEN 0 AND 4),
					retry_at_ms INTEGER NOT NULL DEFAULT 0,
					CHECK ((state = 'queued' AND blocked_reason IS NULL) OR
						(state = 'blocked' AND blocked_reason IS NOT NULL))
				) STRICT;
				CREATE TABLE physical_shadow_synchronization (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					sequence INTEGER NOT NULL CHECK (sequence BETWEEN 0 AND 9007199254740991),
					pending TEXT,
					stale INTEGER NOT NULL CHECK (stale IN (0, 1))
				) STRICT;
				INSERT INTO physical_shadow_synchronization VALUES (1, 0, NULL, 0);
				PRAGMA user_version = ${DATABASE_VERSION};
			`)
		}).immediate()
	}

	#initializeCollector(randomId: () => string): string {
		return this.#database.transaction(() => {
			const existing = this.#database
				.query<{ value: string }, []>(
					`SELECT value FROM physical_shadow_settings WHERE key = 'collector_id'`,
				)
				.get()?.value
			if (existing !== undefined) {
				if (!isUuidV4(existing)) throw new Error('Physical shadow collector identity is invalid')
				return existing
			}
			const created = randomId()
			if (!isUuidV4(created)) throw new Error('Physical shadow collector identity generation failed')
			this.#database
				.query(`INSERT INTO physical_shadow_settings (key, value) VALUES ('collector_id', ?)`)
				.run(created)
			return created
		}).immediate()
	}
}

function integer(value: unknown, min: number, max: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

function validPending(text: string, sequence: number, collector: string): boolean {
	try {
		if (Buffer.byteLength(text) > 1024) return false
		const value: unknown = JSON.parse(text)
		if (!exactObject(value, ['protocol_version', 'collector_instance_id', 'observation_sequence',
			'observed_at_ms', 'state', 'records', 'bytes', 'oldest_queued_at_ms']) ||
			JSON.stringify(value) !== text || value.protocol_version !== 1 || value.collector_instance_id !== collector ||
			value.observation_sequence !== sequence || !integer(sequence, 1, Number.MAX_SAFE_INTEGER) ||
			!integer(value.observed_at_ms, 0, MAX_TIME) || !integer(value.records, 0, 10000) ||
			!integer(value.bytes, 0, 8388608)) return false
		return value.records === 0
			? value.state === 'clear' && value.bytes === 0 && value.oldest_queued_at_ms === null
			: ['queued', 'retrying', 'blocked'].includes(value.state as string) && value.bytes > 0 &&
				integer(value.oldest_queued_at_ms, 0, MAX_TIME) && value.oldest_queued_at_ms <= value.observed_at_ms + 600000
	} catch { return false }
}

type SynchronizationTransportOutcome = Exclude<PhysicalShadowSynchronizationResult,
	'waiting' | 'disabled' | 'unavailable'> | 'stale'

function classifySynchronization(http: number, text: string): SynchronizationTransportOutcome {
	const value: unknown = JSON.parse(text)
	if (!isRecord(value) || !Object.values(value).every((item) => typeof item === 'string')) return 'retryable'
	// Closed responses are flat string-only objects. Count lexical strings to reject duplicate keys,
	// including escaped equivalents, without accepting JSON.parse's last-key-wins behavior.
	if ((text.match(/"(?:[^"\\]|\\.)*"/g) ?? []).length !== Object.keys(value).length * 2) return 'retryable'
	if (http === 200) {
		if (exactObject(value, ['status']) && (value.status === 'accepted' || value.status === 'duplicate')) return value.status
		if (!exactObject(value, ['status', 'reason']) || value.status !== 'rejected') return 'retryable'
		switch (value.reason) {
			case 'collector_not_registered': return 'registration_required'
			case 'invalid_observation_time': return 'clock_repair_required'
			case 'stale_observation': return 'stale'
			case 'invalid_record': case 'unsupported_version': case 'identity_conflict': return 'suspended'
			default: return 'retryable'
		}
	}
	const errors: Record<number, readonly string[]> = {
		400: ['secure_transport_required', 'invalid_request', 'invalid_json'],
		403: ['physical_bearer_required', 'executor_profile_required'],
		404: ['not_found'], 405: ['method_not_allowed'], 413: ['payload_too_large'],
		415: ['unsupported_media_type'],
	}
	return exactObject(value, ['error']) && errors[http]?.includes(value.error as string) ? 'suspended' : 'retryable'
}

type ShadowOutcome =
	| { status: 'accepted' | 'duplicate' }
	| { status: 'rejected'; reason: Extract<BlockedReason, 'invalid_record' | 'unsupported_version' | 'identity_conflict' | 'invalid_order'> }

function parseShadowOutcome(value: unknown): ShadowOutcome | undefined {
	if (!isRecord(value)) return undefined
	if (
		(value.status === 'accepted' || value.status === 'duplicate') &&
		exactObject(value, ['status'])
	) {
		return value as ShadowOutcome
	}
	if (
		value.status === 'rejected' &&
		(value.reason === 'invalid_record' ||
			value.reason === 'unsupported_version' ||
			value.reason === 'identity_conflict' ||
			value.reason === 'invalid_order') &&
		exactObject(value, ['reason', 'status'])
	) {
		return value as ShadowOutcome
	}
	return undefined
}

function validateCapabilities(value: readonly Capability[]): Capability[] {
	const parsed = parseEvidenceEnvelope({
		protocol: LOCAL_PROTOCOL,
		protocol_version: LOCAL_PROTOCOL_VERSION,
		collector_instance_id: '00000000-0000-4000-8000-000000000000',
		capabilities: value,
		evidence: [],
	}, Date.now())
	if ('reason' in parsed || 'unsupported' in parsed) throw new Error('Invalid physical shadow capabilities')
	return [...parsed.capabilities].sort()
}

function validateHostname(value: string): string {
	if (!value || value.length > 255 || /\s/.test(value)) {
		throw new Error('Physical shadow executor hostname is invalid')
	}
	return value
}

function positiveInteger(value: number | undefined, fallback: number): number {
	const selected = value ?? fallback
	if (!Number.isSafeInteger(selected) || selected < 1) throw new Error('Physical shadow limits must be positive integers')
	return selected
}

function encodedRequestBytes(sourceSequence: number, envelopeJson: string): number {
	return Buffer.byteLength(`{"source_sequence":${sourceSequence},"envelope":${envelopeJson}}`)
}

function isRetryableStatus(status: number): boolean {
	return status === 401 || status === 408 || status === 425 || status === 429 || status >= 500
}

function drainResult(
	status: PhysicalShadowDrainResult['status'],
	attempted: 0 | 1 = 0,
	delivered: 0 | 1 = 0,
): PhysicalShadowDrainResult {
	return { status, attempted, delivered }
}

async function readBoundedJson(
	response: Response,
): Promise<{ kind: 'parsed'; value: unknown } | { kind: 'invalid' | 'interrupted' }> {
	if (response.body === null || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
		void response.body?.cancel().catch(() => undefined)
		return { kind: 'invalid' }
	}
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
				return { kind: 'invalid' }
			}
			chunks.push(value)
		}
		const bytes = new Uint8Array(length)
		let offset = 0
		for (const chunk of chunks) {
			bytes.set(chunk, offset)
			offset += chunk.byteLength
		}
		try {
			return {
				kind: 'parsed',
				value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
			}
		} catch {
			return { kind: 'invalid' }
		}
	} catch {
		return { kind: 'interrupted' }
	}
}

function prepareSpoolDirectory(spoolPath: string): void {
	if (
		!isAbsolute(spoolPath) ||
		spoolPath.length === 0 ||
		spoolPath !== spoolPath.trim() ||
		resolve(spoolPath) !== spoolPath
	) {
		throw new Error('Physical shadow spool requires an exact absolute file path')
	}
	const directory = dirname(spoolPath)
	const createdDirectory = mkdirSync(directory, { recursive: true, mode: 0o700 })
	if (realpathSync(directory) !== directory) throw new Error('Physical shadow spool directory is unsafe')
	const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
	try {
		const stat = fstatSync(descriptor)
		const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
		if (
			!stat.isDirectory() ||
			(uid !== undefined && stat.uid !== uid) ||
			(createdDirectory === undefined && (stat.mode & 0o777) !== 0o700)
		) {
			throw new Error('Physical shadow spool directory is unsafe')
		}
		if (createdDirectory !== undefined) fchmodSync(descriptor, 0o700)
	} finally {
		closeSync(descriptor)
	}
}

function acquireOwnership(path: string): Database {
	prepareOwnershipFile(path)
	const database = new Database(path, { create: true, strict: true })
	try {
		database.exec('PRAGMA busy_timeout = 0')
		database.exec('PRAGMA journal_mode = DELETE')
		database.exec('BEGIN EXCLUSIVE')
		return database
	} catch (error) {
		database.close()
		throw error
	}
}

function prepareOwnershipFile(path: string): void {
	try {
		const stat = lstatSync(path)
		const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			(stat.mode & 0o777) !== 0o600 ||
			(uid !== undefined && stat.uid !== uid)
		) {
			throw new Error('Physical shadow ownership file is unsafe')
		}
		return
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
	}
	const descriptor = openSync(
		path,
		constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	)
	try {
		secureDescriptor(descriptor)
	} finally {
		closeSync(descriptor)
	}
}

function prepareExistingFile(path: string): void {
	try {
		const descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW)
		try {
			secureDescriptor(descriptor)
		} finally {
			closeSync(descriptor)
		}
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
	}
}

function prepareDatabaseFile(path: string): void {
	if (path.length === 0 || path !== path.trim() || path === ':memory:') {
		throw new Error('Physical shadow spool requires an exact durable file path')
	}
	try {
		if (!lstatSync(path).isFile()) throw new Error('Physical shadow spool must be a regular file')
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
	}
	let descriptor: number
	try {
		descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
		descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW)
	}
	try {
		secureDescriptor(descriptor)
	} finally {
		closeSync(descriptor)
	}
}

function secureDescriptor(descriptor: number): void {
	const stat = fstatSync(descriptor)
	const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
	if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) {
		throw new Error('Physical shadow spool must be an owner-owned regular file')
	}
	fchmodSync(descriptor, 0o600)
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
	return isRecord(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
