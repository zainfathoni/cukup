import { Database } from 'bun:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
	EVENT_SCHEMA_VERSION_V1,
	EVENT_SCHEMA_VERSION_V2,
	parseSummary,
	type AuthoritativeSummary,
	type ClockSample,
	type DeliveryResult,
	type OutboxEvent,
} from './protocol.ts'
import { isProjectSlug } from './project.ts'
import { DEFAULT_WEEKDAY_TARGET_MINUTES, type WorkEvent } from './tracker.ts'

const DATABASE_VERSION = 2
const targetSetting = 'weekday-target-minutes'
const sourceSetting = 'source-instance-id'
const migrationNamespaceSetting = 'legacy-migration-namespace'
const nextSequenceSetting = 'next-source-sequence'
const trackingIncompleteSetting = 'tracking-incomplete'

export type OutboxCounts = {
	pending: number
	conflict: number
	rejected: number
}

export type CachedSummary = {
	summary: AuthoritativeSummary
	fetchedAtMs: number
}

export type PersistedSyncState = {
	attemptCount: number
	nextAttemptAtMs: number | null
	lastErrorKind: string | null
	lastErrorAtMs: number | null
	clock: ClockSample | null
}

export type EventAttribution =
	| { schemaVersion: typeof EVENT_SCHEMA_VERSION_V1; projectSlug: null }
	| { schemaVersion: typeof EVENT_SCHEMA_VERSION_V2; projectSlug: string | null }

export const UNASSIGNED_V1_ATTRIBUTION: EventAttribution = {
	schemaVersion: EVENT_SCHEMA_VERSION_V1,
	projectSlug: null,
}

export function defaultDatabasePath(): string {
	const stateHome = process.env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state')
	return join(stateHome, 'amp-work-hours', 'state.sqlite')
}

export class WorkHoursStore {
	readonly #database: Database
	readonly #sourceInstanceID: string

	constructor(path = defaultDatabasePath()) {
		const directory = dirname(path)
		mkdirSync(directory, { recursive: true, mode: 0o700 })
		chmodSync(directory, 0o700)
		this.#database = new Database(path, { create: true, strict: true })
		const databaseVersion = this.#database
			.query<{ user_version: number }, []>('PRAGMA user_version')
			.get()!.user_version
		if (databaseVersion > DATABASE_VERSION) {
			this.#database.close()
			throw new Error(
				`Plugin database schema version ${databaseVersion} is newer than supported version ${DATABASE_VERSION}`,
			)
		}
		chmodSync(path, 0o600)
		this.#database.exec('PRAGMA busy_timeout = 5000')
		this.#database.exec('PRAGMA journal_mode = WAL')
		this.#createSchema()
		this.#sourceInstanceID = this.#initializeIdentityAndMigrate()
	}

	record(
		event: WorkEvent,
		monotonicDurationMs?: number,
		startAttribution: EventAttribution = UNASSIGNED_V1_ATTRIBUTION,
	): OutboxEvent | undefined {
		return this.#record(event, monotonicDurationMs, startAttribution, false)
	}

	recordEndIfStarted(event: WorkEvent, monotonicDurationMs?: number): OutboxEvent | undefined {
		if (event.kind !== 'end') throw new Error('Conditional recording requires an end event.')
		return this.#record(event, monotonicDurationMs, UNASSIGNED_V1_ATTRIBUTION, true)
	}

	#record(
		event: WorkEvent,
		monotonicDurationMs: number | undefined,
		startAttribution: EventAttribution,
		requireStart: boolean,
	): OutboxEvent | undefined {
		const eventKey = legacyEventKey(event)
		const turn = turnKey(event)
		const eventID = uuidv7(event.atMs)
		const proposedSessionID = randomUUID()
		validateAttribution(startAttribution)

		const write = this.#database.transaction((): OutboxEvent | undefined => {
			const existing = this.#database
				.query<{ found: number }, [string]>('SELECT 1 AS found FROM events WHERE event_key = ?')
				.get(eventKey)
			if (existing) return undefined
			if (requireStart) {
				const startKey = legacyEventKey({ ...event, kind: 'start', status: undefined })
				const start = this.#database
					.query<{ found: number }, [string]>('SELECT 1 AS found FROM events WHERE event_key = ?')
					.get(startKey)
				if (!start) return undefined
			}

			const sequence = this.#nextSequence()
			const session = this.#turnSession(
				turn,
				proposedSessionID,
				event.kind === 'start' ? startAttribution : UNASSIGNED_V1_ATTRIBUTION,
			)
			const sequenced: OutboxEvent = {
				schema_version: session.schemaVersion,
				event_id: eventID,
				source_instance_id: this.#sourceInstanceID,
				source_sequence: sequence,
				session_id: session.sessionID,
				kind: `agent.${event.kind}`,
				occurred_at: new Date(event.atMs).toISOString(),
				...(monotonicDurationMs === undefined
					? {}
					: { monotonic_duration_ms: normalizeDuration(monotonicDurationMs) }),
				...(session.schemaVersion === EVENT_SCHEMA_VERSION_V2 && session.projectSlug !== null
					? { project_slug: session.projectSlug }
					: {}),
			}
			this.#database
				.query(
					`INSERT INTO events
						(event_key, thread_id, message_id, kind, at_ms, status)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(
					eventKey,
					event.threadId,
					event.messageId,
					event.kind,
					event.atMs,
					event.status ?? null,
				)
			this.#insertOutboxEvent(sequenced)
			this.#database
				.query(
					'INSERT INTO legacy_migrations (event_key, event_id, source_sequence) VALUES (?, ?, ?)',
				)
				.run(eventKey, sequenced.event_id, sequence)
			this.#setSetting(nextSequenceSetting, String(sequence + 1))
			return sequenced
		})
		try {
			return write.immediate()
		} catch (error) {
			try {
				this.markTrackingIncomplete()
			} catch {
				// Keep the original local write failure when the warning marker also cannot be written.
			}
			throw error
		}
	}

	events(): WorkEvent[] {
		return this.#database
			.query<
				{
					threadId: string
					messageId: string
					kind: 'start' | 'end'
					atMs: number
					status: 'done' | 'error' | 'cancelled' | null
				},
				[]
			>(
				`SELECT thread_id AS threadId, message_id AS messageId, kind, at_ms AS atMs, status
				 FROM events ORDER BY at_ms, event_key`,
			)
			.all()
			.map((row) => ({
				threadId: row.threadId,
				messageId: row.messageId,
				kind: row.kind,
				atMs: row.atMs,
				...(row.status ? { status: row.status } : {}),
			}))
	}

	pendingEvents(limit: number): OutboxEvent[] {
		if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Outbox limit must be positive.')
		return this.#database
			.query<OutboxRow, [number]>(
				`SELECT schema_version, project_slug, event_id, source_instance_id,
				        source_sequence, session_id, kind, occurred_at, monotonic_duration_ms
				 FROM outbox
				 WHERE delivery_state = 'pending'
				 ORDER BY source_instance_id, source_sequence
				 LIMIT ?`,
			)
			.all(limit)
			.map(outboxEventFromRow)
	}

	hasPendingEventSchema(schemaVersion: number): boolean {
		return Boolean(
			this.#database
				.query<{ found: number }, [number]>(
					`SELECT 1 AS found FROM outbox
					 WHERE delivery_state = 'pending' AND schema_version = ? LIMIT 1`,
				)
				.get(schemaVersion),
		)
	}

	applyDeliveryResults(results: readonly DeliveryResult[]): void {
		const apply = this.#database.transaction(() => {
			for (const result of results) {
				if (result.status === 'accepted' || result.status === 'duplicate') {
					this.#database.query('DELETE FROM outbox WHERE event_id = ?').run(result.event_id)
					continue
				}
				this.#database
					.query(
						`UPDATE outbox
						 SET delivery_state = ?
						 WHERE event_id = ? AND delivery_state = 'pending'`,
					)
					.run(result.status, result.event_id)
			}
		})
		apply.immediate()
	}

	outboxCounts(): OutboxCounts {
		const rows = this.#database
			.query<{ state: 'pending' | 'conflict' | 'rejected'; count: number }, []>(
				'SELECT delivery_state AS state, count(*) AS count FROM outbox GROUP BY delivery_state',
			)
			.all()
		const counts: OutboxCounts = { pending: 0, conflict: 0, rejected: 0 }
		for (const row of rows) counts[row.state] = row.count
		return counts
	}

	cacheSummary(summary: AuthoritativeSummary, fetchedAtMs: number): void {
		this.#database
			.query(
				`INSERT INTO summary_cache (singleton, body_json, as_of, fetched_at_ms)
				 VALUES (1, ?, ?, ?)
				 ON CONFLICT(singleton) DO UPDATE SET
				   body_json = excluded.body_json,
				   as_of = excluded.as_of,
				   fetched_at_ms = excluded.fetched_at_ms`,
			)
			.run(JSON.stringify(summary), summary.as_of, fetchedAtMs)
	}

	cachedSummary(): CachedSummary | undefined {
		const row = this.#database
			.query<{ body: string; fetchedAtMs: number }, []>(
				'SELECT body_json AS body, fetched_at_ms AS fetchedAtMs FROM summary_cache WHERE singleton = 1',
			)
			.get()
		if (!row) return undefined
		try {
			return { summary: parseSummary(JSON.parse(row.body)), fetchedAtMs: row.fetchedAtMs }
		} catch {
			return undefined
		}
	}

	syncState(): PersistedSyncState {
		const row = this.#database
			.query<
				{
					attemptCount: number
					nextAttemptAtMs: number | null
					lastErrorKind: string | null
					lastErrorAtMs: number | null
					clockOffsetMs: number | null
					clockRoundTripMs: number | null
					clockSampledAtMs: number | null
				},
				[]
			>(
				`SELECT attempt_count AS attemptCount, next_attempt_at_ms AS nextAttemptAtMs,
				        last_error_kind AS lastErrorKind, last_error_at_ms AS lastErrorAtMs,
				        clock_offset_ms AS clockOffsetMs,
				        clock_round_trip_ms AS clockRoundTripMs,
				        clock_sampled_at_ms AS clockSampledAtMs
				 FROM sync_state WHERE singleton = 1`,
			)
			.get()
		if (!row) throw new Error('Missing sync state.')
		return {
			attemptCount: row.attemptCount,
			nextAttemptAtMs: row.nextAttemptAtMs,
			lastErrorKind: row.lastErrorKind,
			lastErrorAtMs: row.lastErrorAtMs,
			clock:
				row.clockOffsetMs === null ||
				row.clockRoundTripMs === null ||
				row.clockSampledAtMs === null
					? null
					: {
						offsetMs: row.clockOffsetMs,
						roundTripMs: row.clockRoundTripMs,
						sampledAtMs: row.clockSampledAtMs,
					},
		}
	}

	recordClockSample(clock: ClockSample): void {
		this.#database
			.query(
				`UPDATE sync_state SET clock_offset_ms = ?, clock_round_trip_ms = ?, clock_sampled_at_ms = ?
				 WHERE singleton = 1`,
			)
			.run(clock.offsetMs, clock.roundTripMs, clock.sampledAtMs)
	}

	recordSyncSuccess(): void {
		this.#database
			.query(
				`UPDATE sync_state SET attempt_count = 0, next_attempt_at_ms = NULL,
				 last_error_kind = NULL, last_error_at_ms = NULL WHERE singleton = 1`,
			)
			.run()
	}

	recordSyncFailure(kind: string, attemptCount: number, nextAttemptAtMs: number | null, atMs: number): void {
		this.#database
			.query(
				`UPDATE sync_state SET attempt_count = ?, next_attempt_at_ms = ?,
				 last_error_kind = ?, last_error_at_ms = ? WHERE singleton = 1`,
			)
			.run(attemptCount, nextAttemptAtMs, kind, atMs)
	}

	trackingIncomplete(): boolean {
		return this.#setting(trackingIncompleteSetting) === 'true'
	}

	markTrackingIncomplete(): void {
		this.#setSetting(trackingIncompleteSetting, 'true')
	}

	weekdayTargetMinutes(): number {
		const row = this.#database
			.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
			.get(targetSetting)
		const value = row ? Number(row.value) : DEFAULT_WEEKDAY_TARGET_MINUTES
		return Number.isSafeInteger(value) && value >= 0 && value <= 24 * 60
			? value
			: DEFAULT_WEEKDAY_TARGET_MINUTES
	}

	setWeekdayTargetMinutes(minutes: number): void {
		if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 24 * 60) {
			throw new Error('Daily target must be a whole number of minutes from 0:00 to 24:00.')
		}
		this.#setSetting(targetSetting, String(minutes))
	}

	close(): void {
		this.#database.close()
	}

	#createSchema(): void {
		this.#database.exec(`
			CREATE TABLE IF NOT EXISTS events (
				event_key TEXT PRIMARY KEY,
				thread_id TEXT NOT NULL,
				message_id TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('start', 'end')),
				at_ms INTEGER NOT NULL,
				status TEXT CHECK (status IS NULL OR status IN ('done', 'error', 'cancelled'))
			);
			CREATE TABLE IF NOT EXISTS settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS outbox (
				event_id TEXT PRIMARY KEY,
				schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version IN (1, 2)),
				project_slug TEXT,
				source_instance_id TEXT NOT NULL,
				source_sequence INTEGER NOT NULL CHECK (source_sequence > 0),
				session_id TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('agent.start', 'agent.end')),
				occurred_at TEXT NOT NULL,
				monotonic_duration_ms INTEGER CHECK (monotonic_duration_ms IS NULL OR monotonic_duration_ms >= 0),
				delivery_state TEXT NOT NULL DEFAULT 'pending'
					CHECK (delivery_state IN ('pending', 'conflict', 'rejected')),
				UNIQUE (source_instance_id, source_sequence)
			);
			CREATE TABLE IF NOT EXISTS legacy_migrations (
				event_key TEXT PRIMARY KEY,
				event_id TEXT NOT NULL UNIQUE,
				source_sequence INTEGER NOT NULL UNIQUE
			);
			CREATE TABLE IF NOT EXISTS turn_sessions (
				turn_key TEXT PRIMARY KEY,
				session_id TEXT NOT NULL UNIQUE,
				schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version IN (1, 2)),
				project_slug TEXT
			);
			CREATE TABLE IF NOT EXISTS summary_cache (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				body_json TEXT NOT NULL,
				as_of TEXT NOT NULL,
				fetched_at_ms INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS sync_state (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				attempt_count INTEGER NOT NULL DEFAULT 0,
				next_attempt_at_ms INTEGER,
				last_error_kind TEXT,
				last_error_at_ms INTEGER,
				clock_offset_ms INTEGER,
				clock_round_trip_ms INTEGER,
				clock_sampled_at_ms INTEGER
			);
			INSERT OR IGNORE INTO sync_state (singleton) VALUES (1);
		`)
		this.#migrateAttributionSchema()
	}

	#migrateAttributionSchema(): void {
		const migrate = this.#database.transaction(() => {
			const outboxColumns = this.#tableColumns('outbox')
			if (!outboxColumns.has('schema_version')) {
				this.#database.exec(
					'ALTER TABLE outbox ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version IN (1, 2))',
				)
			}
			if (!outboxColumns.has('project_slug')) {
				this.#database.exec('ALTER TABLE outbox ADD COLUMN project_slug TEXT')
			}

			const sessionColumns = this.#tableColumns('turn_sessions')
			if (!sessionColumns.has('schema_version')) {
				this.#database.exec(
					'ALTER TABLE turn_sessions ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version IN (1, 2))',
				)
			}
			if (!sessionColumns.has('project_slug')) {
				this.#database.exec('ALTER TABLE turn_sessions ADD COLUMN project_slug TEXT')
			}
			this.#database.exec(`PRAGMA user_version = ${DATABASE_VERSION}`)
		})
		migrate.immediate()
	}

	#tableColumns(table: 'outbox' | 'turn_sessions'): Set<string> {
		return new Set(
			this.#database
				.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
				.all()
				.map((column) => column.name),
		)
	}

	#initializeIdentityAndMigrate(): string {
		const initialize = this.#database.transaction(() => {
			const sourceInstanceID = this.#setting(sourceSetting) ?? randomUUID()
			const namespace = this.#setting(migrationNamespaceSetting) ?? randomUUID()
			this.#setSetting(sourceSetting, sourceInstanceID)
			this.#setSetting(migrationNamespaceSetting, namespace)

			const configuredNextSequence = Number(this.#setting(nextSequenceSetting))
			let sequence = Math.max(
				this.#maximumSequence(),
				Number.isSafeInteger(configuredNextSequence) && configuredNextSequence > 0
					? configuredNextSequence - 1
					: 0,
			)
			const legacyRows = this.#database
				.query<LegacyRow, []>(
					`SELECT event_key, thread_id, message_id, kind, at_ms FROM events
					 ORDER BY at_ms, event_key`,
				)
				.all()
			for (const row of legacyRows) {
				const turn = `${row.thread_id}\u0000${row.message_id}`
				const session = this.#turnSession(
					turn,
					uuidv5(namespace, `cukup-legacy-session\u0000${turn}`),
					UNASSIGNED_V1_ATTRIBUTION,
				)
				const migrated = this.#database
					.query<{ found: number }, [string]>(
						'SELECT 1 AS found FROM legacy_migrations WHERE event_key = ?',
					)
					.get(row.event_key)
				if (migrated) continue
				sequence += 1
				const eventID = uuidv5(namespace, `cukup-legacy-event\u0000${row.event_key}`)
				this.#insertOutboxEvent({
					schema_version: EVENT_SCHEMA_VERSION_V1,
					event_id: eventID,
					source_instance_id: sourceInstanceID,
					source_sequence: sequence,
					session_id: session.sessionID,
					kind: `agent.${row.kind}`,
					occurred_at: new Date(row.at_ms).toISOString(),
				})
				this.#database
					.query(
						'INSERT INTO legacy_migrations (event_key, event_id, source_sequence) VALUES (?, ?, ?)',
					)
					.run(row.event_key, eventID, sequence)
			}
			this.#setSetting(nextSequenceSetting, String(sequence + 1))
			return sourceInstanceID
		})
		return initialize.immediate()
	}

	#nextSequence(): number {
		const configured = Number(this.#setting(nextSequenceSetting))
		return Number.isSafeInteger(configured) && configured > 0
			? configured
			: this.#maximumSequence() + 1
	}

	#maximumSequence(): number {
		return (
			this.#database
				.query<{ sequence: number }, []>(
					`SELECT max(sequence) AS sequence FROM (
					   SELECT coalesce(max(source_sequence), 0) AS sequence FROM outbox
					   UNION ALL
					   SELECT coalesce(max(source_sequence), 0) AS sequence FROM legacy_migrations
					 )`,
				)
				.get()?.sequence ?? 0
		)
	}

	#insertOutboxEvent(event: OutboxEvent): void {
		this.#database
			.query(
				`INSERT INTO outbox
					(event_id, schema_version, project_slug, source_instance_id, source_sequence,
					 session_id, kind, occurred_at, monotonic_duration_ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				event.event_id,
				event.schema_version,
				event.schema_version === EVENT_SCHEMA_VERSION_V2 ? (event.project_slug ?? null) : null,
				event.source_instance_id,
				event.source_sequence,
				event.session_id,
				event.kind,
				event.occurred_at,
				event.monotonic_duration_ms ?? null,
			)
	}

	#turnSession(
		turn: string,
		proposedSessionID: string,
		proposedAttribution: EventAttribution,
	): TurnSession {
		const existing = this.#database
			.query<TurnSessionRow, [string]>(
				`SELECT session_id, schema_version, project_slug
				 FROM turn_sessions WHERE turn_key = ?`,
			)
			.get(turn)
		if (existing) return turnSessionFromRow(existing)
		this.#database
			.query(
				`INSERT INTO turn_sessions
					(turn_key, session_id, schema_version, project_slug) VALUES (?, ?, ?, ?)`,
			)
			.run(turn, proposedSessionID, proposedAttribution.schemaVersion, proposedAttribution.projectSlug)
		return { sessionID: proposedSessionID, ...proposedAttribution }
	}

	#setting(key: string): string | undefined {
		return this.#database
			.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
			.get(key)?.value
	}

	#setSetting(key: string, value: string): void {
		this.#database
			.query(
				`INSERT INTO settings (key, value) VALUES (?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			)
			.run(key, value)
	}
}

type LegacyRow = {
	event_key: string
	thread_id: string
	message_id: string
	kind: 'start' | 'end'
	at_ms: number
}

type OutboxRow = {
	schema_version: number
	project_slug: string | null
	event_id: string
	source_instance_id: string
	source_sequence: number
	session_id: string
	kind: 'agent.start' | 'agent.end'
	occurred_at: string
	monotonic_duration_ms: number | null
}

type TurnSessionRow = {
	session_id: string
	schema_version: number
	project_slug: string | null
}

type TurnSession = EventAttribution & { sessionID: string }

function outboxEventFromRow(row: OutboxRow): OutboxEvent {
	const event = {
		event_id: row.event_id,
		source_instance_id: row.source_instance_id,
		source_sequence: row.source_sequence,
		session_id: row.session_id,
		kind: row.kind,
		occurred_at: row.occurred_at,
		...(row.monotonic_duration_ms === null
			? {}
			: { monotonic_duration_ms: row.monotonic_duration_ms }),
	}
	if (row.schema_version === EVENT_SCHEMA_VERSION_V1 && row.project_slug === null) {
		return { schema_version: EVENT_SCHEMA_VERSION_V1, ...event }
	}
	if (
		row.schema_version === EVENT_SCHEMA_VERSION_V2 &&
		(row.project_slug === null || isProjectSlug(row.project_slug))
	) {
		return {
			schema_version: EVENT_SCHEMA_VERSION_V2,
			...event,
			...(row.project_slug === null ? {} : { project_slug: row.project_slug }),
		}
	}
	throw new Error('Outbox attribution is invalid.')
}

function turnSessionFromRow(row: TurnSessionRow): TurnSession {
	if (row.schema_version === EVENT_SCHEMA_VERSION_V1 && row.project_slug === null) {
		return {
			sessionID: row.session_id,
			schemaVersion: EVENT_SCHEMA_VERSION_V1,
			projectSlug: null,
		}
	}
	if (
		row.schema_version === EVENT_SCHEMA_VERSION_V2 &&
		(row.project_slug === null || isProjectSlug(row.project_slug))
	) {
		return {
			sessionID: row.session_id,
			schemaVersion: EVENT_SCHEMA_VERSION_V2,
			projectSlug: row.project_slug,
		}
	}
	throw new Error('Turn-session attribution is invalid.')
}

function validateAttribution(attribution: EventAttribution): void {
	if (
		attribution.schemaVersion === EVENT_SCHEMA_VERSION_V2 &&
		attribution.projectSlug !== null &&
		!isProjectSlug(attribution.projectSlug)
	) {
		throw new Error('Project Slug must be lowercase kebab-case and at most 64 characters.')
	}
}

function legacyEventKey(event: WorkEvent): string {
	return `${event.threadId}\u0000${event.messageId}\u0000${event.kind}`
}

function turnKey(event: WorkEvent): string {
	return `${event.threadId}\u0000${event.messageId}`
}

function normalizeDuration(value: number): number {
	if (!Number.isFinite(value) || value < 0) throw new Error('Monotonic duration must be non-negative.')
	return Math.round(value)
}

function uuidv7(atMs: number): string {
	if (!Number.isSafeInteger(atMs) || atMs < 0 || atMs > 0xffffffffffff) {
		throw new Error('Event timestamp is outside the UUIDv7 range.')
	}
	const bytes = randomBytes(16)
	let timestamp = atMs
	for (let index = 5; index >= 0; index -= 1) {
		bytes[index] = timestamp % 256
		timestamp = Math.floor(timestamp / 256)
	}
	bytes[6] = (bytes[6]! & 0x0f) | 0x70
	bytes[8] = (bytes[8]! & 0x3f) | 0x80
	return formatUUID(bytes)
}

function uuidv5(namespace: string, name: string): string {
	const namespaceBytes = Buffer.from(namespace.replaceAll('-', ''), 'hex')
	if (namespaceBytes.length !== 16) throw new Error('Invalid migration namespace.')
	const bytes = createHash('sha1').update(namespaceBytes).update(name).digest().subarray(0, 16)
	bytes[6] = (bytes[6]! & 0x0f) | 0x50
	bytes[8] = (bytes[8]! & 0x3f) | 0x80
	return formatUUID(bytes)
}

function formatUUID(bytes: Uint8Array): string {
	const hex = Buffer.from(bytes).toString('hex')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
