import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { generateBearerToken, hashBearerToken, type IssuedToken } from './auth.ts'
import { MAX_CLOCK_SKEW_MS, defaultServiceDatabasePath } from './config.ts'
import type {
	AttributedStoredWorkEvent,
	ExecutorBindingOutcome,
	IngestOutcome,
	Principal,
	StoredWorkEvent,
	TargetOverride,
	WorkEvent,
} from './types.ts'

const DATABASE_VERSION = 4

const EXECUTOR_LABEL_CHECK = `
	CHECK (
		executor_label IS NULL OR (
			length(executor_label) BETWEEN 1 AND 253 AND
			executor_label = lower(executor_label) AND
			executor_label NOT GLOB '*[^a-z0-9.-]*' AND
			executor_label NOT GLOB '.*' AND executor_label NOT GLOB '*.' AND
			executor_label NOT GLOB '-*' AND executor_label NOT GLOB '*-' AND
			executor_label NOT GLOB '*..*' AND
			executor_label NOT GLOB '*.-*' AND executor_label NOT GLOB '*-.*' AND
			executor_label NOT IN ('amp-orb', 'unassigned-executor')
		)
	)`

const EVENTS_V2_TABLE = `
	CREATE TABLE events (
		event_id TEXT PRIMARY KEY,
		schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2)),
		project_slug TEXT,
		source_instance TEXT NOT NULL REFERENCES source_owners(source_instance),
		source_sequence INTEGER NOT NULL CHECK (source_sequence >= 1),
		session_id TEXT NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('agent.start', 'agent.end')),
		occurred_at TEXT NOT NULL,
		occurred_at_ms INTEGER NOT NULL,
		monotonic_duration_ms INTEGER CHECK (monotonic_duration_ms IS NULL OR monotonic_duration_ms >= 0),
		received_at TEXT NOT NULL,
		received_at_ms INTEGER NOT NULL,
		CHECK (
			(schema_version = 1 AND project_slug IS NULL) OR
			(schema_version = 2 AND (
				project_slug IS NULL OR (
					length(project_slug) BETWEEN 1 AND 64 AND
					project_slug = lower(project_slug) AND
					project_slug NOT GLOB '*[^a-z0-9-]*' AND
					project_slug NOT GLOB '-*' AND project_slug NOT GLOB '*-' AND
					project_slug NOT GLOB '*--*'
				)
			))
		),
		UNIQUE (source_instance, source_sequence)
	) STRICT`

const TARGET_OVERRIDES_V4_TABLE = `
	CREATE TABLE target_overrides (
		date TEXT PRIMARY KEY CHECK (
			length(date) = 10 AND
			date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
		),
		target_minutes INTEGER NOT NULL CHECK (target_minutes IN (0, 240)),
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	) STRICT`

type EventRow = {
	schemaVersion: 1 | 2
	projectSlug: string | null
	eventId: string
	sourceInstance: string
	sourceSequence: number
	sessionId: string
	kind: 'agent.start' | 'agent.end'
	occurredAt: string
	occurredAtMs: number
	monotonicDurationMs: number | null
	receivedAt: string
	receivedAtMs: number
}

type AttributedEventRow = EventRow & { executorLabel: string }
type SourceOwnerRow = { ownerKind: 'bearer' | 'oidc'; ownerId: string | null }

export class ServiceStore {
	readonly #database: Database

	constructor(path = defaultServiceDatabasePath()) {
		const directory = dirname(path)
		mkdirSync(directory, { recursive: true, mode: 0o700 })
		chmodSync(directory, 0o700)
		this.#database = new Database(path, { create: true, strict: true })
		chmodSync(path, 0o600)
		this.#database.exec('PRAGMA busy_timeout = 5000')
		this.#database.exec('PRAGMA foreign_keys = ON')
		this.#database.exec('PRAGMA journal_mode = WAL')
		try {
			this.#migrate()
		} catch (error) {
			this.#database.close()
			throw error
		}
	}

	issueBearer(nowMs = Date.now(), issued = generateBearerToken()): IssuedToken {
		this.#database
			.query(
				`INSERT INTO auth_tokens (token_id, token_hash, created_at)
				 VALUES (?, ?, ?)`,
			)
			.run(issued.tokenId, issued.tokenHash, new Date(nowMs).toISOString())
		return issued
	}

	rotateBearer(tokenId: string, nowMs = Date.now(), issued = generateBearerToken()): IssuedToken {
		const rotate = this.#database.transaction(() => {
			const current = this.#database
				.query<{ tokenId: string; executorLabel: string | null }, [string]>(
					`SELECT token_id AS tokenId, executor_label AS executorLabel FROM auth_tokens
					 WHERE token_id = ? AND revoked_at IS NULL`,
				)
				.get(tokenId)
			if (!current) throw new Error('Active bearer credential not found')
			const at = new Date(nowMs).toISOString()
			this.#database
				.query(
					`UPDATE auth_tokens SET revoked_at = ?
					 WHERE token_id = ? AND revoked_at IS NULL`,
				)
				.run(at, tokenId)
			this.#database
				.query(
					`INSERT INTO auth_tokens (token_id, token_hash, created_at, executor_label)
					 VALUES (?, ?, ?, ?)`,
				)
				.run(issued.tokenId, issued.tokenHash, at, current.executorLabel)
			this.#database
				.query(`UPDATE auth_tokens SET replaced_by = ? WHERE token_id = ?`)
				.run(issued.tokenId, tokenId)
			this.#database
				.query(`UPDATE source_owners SET owner_id = ? WHERE owner_kind = 'bearer' AND owner_id = ?`)
				.run(issued.tokenId, tokenId)
		})
		rotate.immediate()
		return issued
	}

	revokeBearer(tokenId: string, nowMs = Date.now()): boolean {
		const result = this.#database
			.query(
				`UPDATE auth_tokens SET revoked_at = ?
				 WHERE token_id = ? AND revoked_at IS NULL`,
			)
			.run(new Date(nowMs).toISOString(), tokenId)
		return result.changes === 1
	}

	authenticateBearer(token: string): Principal | undefined {
		const row = this.#database
			.query<{ tokenId: string }, [string]>(
				`SELECT token_id AS tokenId FROM auth_tokens
				 WHERE token_hash = ? AND revoked_at IS NULL`,
			)
			.get(hashBearerToken(token))
		return row ? { kind: 'bearer', tokenId: row.tokenId } : undefined
	}

	bindExecutorLabel(tokenId: string, executorLabel: string): ExecutorBindingOutcome {
		const bind = this.#database.transaction((): ExecutorBindingOutcome => {
			const current = this.#database
				.query<{ executorLabel: string | null }, [string]>(
					`SELECT executor_label AS executorLabel FROM auth_tokens
					 WHERE token_id = ? AND revoked_at IS NULL`,
				)
				.get(tokenId)
			if (!current) return { outcome: 'conflict' }
			if (current.executorLabel === executorLabel) {
				return { outcome: 'bound', executorLabel }
			}
			if (current.executorLabel !== null) return { outcome: 'conflict' }
			const claimed = this.#database
				.query<{ value: number }, [string, string]>(
					`SELECT 1 AS value FROM auth_tokens
					 WHERE executor_label = ? AND revoked_at IS NULL AND token_id <> ?`,
				)
				.get(executorLabel, tokenId)
			if (claimed) return { outcome: 'conflict' }
			this.#database
				.query(
					`UPDATE auth_tokens SET executor_label = ?
					 WHERE token_id = ? AND revoked_at IS NULL AND executor_label IS NULL`,
				)
				.run(executorLabel, tokenId)
			return { outcome: 'bound', executorLabel }
		})
		return bind.immediate()
	}

	listBearerMetadata(): Array<{
		tokenId: string
		createdAt: string
		revokedAt: string | null
		replacedBy: string | null
		executorLabel: string | null
	}> {
		return this.#database
			.query<
				{
					tokenId: string
					createdAt: string
					revokedAt: string | null
					replacedBy: string | null
					executorLabel: string | null
				},
				[]
			>(
				`SELECT token_id AS tokenId, created_at AS createdAt,
				        revoked_at AS revokedAt, replaced_by AS replacedBy,
				        executor_label AS executorLabel
				 FROM auth_tokens ORDER BY created_at, token_id`,
			)
			.all()
	}

	putTargetOverride(
		date: string,
		targetMinutes: TargetOverride['targetMinutes'],
		nowMs = Date.now(),
	): TargetOverride {
		const at = new Date(nowMs).toISOString()
		this.#database
			.query(
				`INSERT INTO target_overrides (
					date, target_minutes, created_at, updated_at
				) VALUES (?, ?, ?, ?)
				ON CONFLICT (date) DO UPDATE SET
					target_minutes = excluded.target_minutes,
					updated_at = excluded.updated_at
				WHERE target_overrides.target_minutes <> excluded.target_minutes`,
			)
			.run(date, targetMinutes, at, at)
		return this.#database
			.query<
				TargetOverride,
				[string]
			>(
				`SELECT date, target_minutes AS targetMinutes,
				        created_at AS createdAt, updated_at AS updatedAt
				 FROM target_overrides WHERE date = ?`,
			)
			.get(date)!
	}

	clearTargetOverride(date: string): boolean {
		return this.#database.query('DELETE FROM target_overrides WHERE date = ?').run(date).changes === 1
	}

	targetOverrides(): ReadonlyMap<string, number> {
		return new Map(
			this.#database
				.query<{ date: string; targetMinutes: number }, []>(
					`SELECT date, target_minutes AS targetMinutes
					 FROM target_overrides ORDER BY date`,
				)
				.all()
				.map((row) => [row.date, row.targetMinutes]),
		)
	}

	ingest(principal: Principal, event: WorkEvent, receivedAtMs: number): IngestOutcome {
		const ingest = this.#database.transaction((): IngestOutcome => {
			const owner = this.#database
				.query<SourceOwnerRow, [string]>(
					`SELECT owner_kind AS ownerKind, owner_id AS ownerId
					 FROM source_owners WHERE source_instance = ?`,
				)
				.get(event.sourceInstance)
			if (owner && !principalOwns(owner, principal)) {
				return { outcome: 'rejected', reason: 'source_not_authorized' }
			}

			const byId = this.#eventById(event.eventId)
			if (byId) {
				return immutableEventEquals(byId, event)
					? { outcome: 'duplicate', receivedAt: byId.receivedAt }
					: { outcome: 'conflicted', reason: 'event_id_conflict' }
			}
			const bySequence = this.#eventBySequence(event.sourceInstance, event.sourceSequence)
			if (bySequence) {
				return immutableEventEquals(bySequence, event)
					? { outcome: 'duplicate', receivedAt: bySequence.receivedAt }
					: { outcome: 'conflicted', reason: 'source_sequence_conflict' }
			}
			if (event.schemaVersion === 2 && principal.kind === 'bearer') {
				const profile = this.#database
					.query<{ executorLabel: string | null }, [string]>(
						`SELECT executor_label AS executorLabel FROM auth_tokens
						 WHERE token_id = ? AND revoked_at IS NULL`,
					)
					.get(principal.tokenId)
				if (!profile?.executorLabel) {
					return { outcome: 'rejected', reason: 'executor_profile_required' }
				}
			}
			if (event.kind === 'agent.end') {
				const start = this.#database
					.query<Pick<EventRow, 'schemaVersion' | 'projectSlug'>, [string, string]>(
						`SELECT schema_version AS schemaVersion, project_slug AS projectSlug
						 FROM events
						 WHERE source_instance = ? AND session_id = ? AND kind = 'agent.start'
						 ORDER BY source_sequence LIMIT 1`,
					)
					.get(event.sourceInstance, event.sessionId)
				if (
					start &&
					(start.schemaVersion !== event.schemaVersion ||
						start.projectSlug !== (event.projectSlug ?? null))
				) {
					return { outcome: 'rejected', reason: 'session_attribution_mismatch' }
				}
			}
			const latestSequence = this.#database
				.query<{ value: number | null }, [string]>(
					`SELECT MAX(source_sequence) AS value FROM events WHERE source_instance = ?`,
				)
				.get(event.sourceInstance)?.value
			if (latestSequence !== null && latestSequence !== undefined && event.sourceSequence < latestSequence) {
				return { outcome: 'rejected', reason: 'source_sequence_order' }
			}

			// Old evidence is valid after an offline period. The plugin samples /v1/time
			// before upload to surface clocks that are behind; the service independently
			// prevents future-dated evidence from inflating current work.
			if (event.occurredAtMs - receivedAtMs > MAX_CLOCK_SKEW_MS) {
				return { outcome: 'rejected', reason: 'clock_skew' }
			}

			if (!owner) {
				this.#database
					.query(
						`INSERT INTO source_owners (source_instance, owner_kind, owner_id)
						 VALUES (?, ?, ?)`,
					)
					.run(
						event.sourceInstance,
						principal.kind,
						principal.kind === 'bearer' ? principal.tokenId : null,
					)
			}

			const receivedAt = new Date(receivedAtMs).toISOString()
			this.#database
				.query(
					`INSERT INTO events (
						event_id, schema_version, project_slug, source_instance, source_sequence,
						session_id, kind, occurred_at, occurred_at_ms,
						monotonic_duration_ms, received_at, received_at_ms
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					event.eventId,
					event.schemaVersion,
					event.projectSlug ?? null,
					event.sourceInstance,
					event.sourceSequence,
					event.sessionId,
					event.kind,
					event.occurredAt,
					event.occurredAtMs,
					event.monotonicDurationMs ?? null,
					receivedAt,
					receivedAtMs,
				)
			return { outcome: 'accepted', receivedAt }
		})
		return ingest.immediate()
	}

	events(): StoredWorkEvent[] {
		return this.#database
			.query<EventRow, []>(
				`SELECT schema_version AS schemaVersion, project_slug AS projectSlug,
				        event_id AS eventId,
				        source_instance AS sourceInstance, source_sequence AS sourceSequence,
				        session_id AS sessionId, kind, occurred_at AS occurredAt,
				        occurred_at_ms AS occurredAtMs,
				        monotonic_duration_ms AS monotonicDurationMs,
				        received_at AS receivedAt, received_at_ms AS receivedAtMs
				 FROM events ORDER BY source_instance, source_sequence`,
			)
			.all()
			.map(storedEvent)
	}

	attributedEvents(): AttributedStoredWorkEvent[] {
		return this.#database
			.query<AttributedEventRow, []>(
				`SELECT e.schema_version AS schemaVersion, e.project_slug AS projectSlug,
				        e.event_id AS eventId, e.source_instance AS sourceInstance,
				        e.source_sequence AS sourceSequence, e.session_id AS sessionId,
				        e.kind, e.occurred_at AS occurredAt,
				        e.occurred_at_ms AS occurredAtMs,
				        e.monotonic_duration_ms AS monotonicDurationMs,
				        e.received_at AS receivedAt, e.received_at_ms AS receivedAtMs,
				        CASE source_owners.owner_kind
				          WHEN 'oidc' THEN 'amp-orb'
				          ELSE COALESCE(auth_tokens.executor_label, 'unassigned-executor')
				        END AS executorLabel
				 FROM events e
				 JOIN source_owners ON source_owners.source_instance = e.source_instance
				 LEFT JOIN auth_tokens ON auth_tokens.token_id = source_owners.owner_id
				 ORDER BY e.source_instance, e.source_sequence`,
			)
			.all()
			.map((row) => ({ ...storedEvent(row), executorLabel: row.executorLabel }))
	}

	integrityCheck(): string {
		return this.#database.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()!
			.integrity_check
	}

	close(): void {
		this.#database.close()
	}

	#migrate(): void {
		const startupVersion = this.#database
			.query<{ user_version: number }, []>('PRAGMA user_version')
			.get()!.user_version
		if (startupVersion > DATABASE_VERSION) {
			throw new Error(
				`Database schema version ${startupVersion} is newer than supported version ${DATABASE_VERSION}`,
			)
		}
		if (startupVersion === DATABASE_VERSION) return

		const migrate = this.#database.transaction(() => {
			const version = this.#database
				.query<{ user_version: number }, []>('PRAGMA user_version')
				.get()!.user_version
			if (version > DATABASE_VERSION) {
				throw new Error(
					`Database schema version ${version} is newer than supported version ${DATABASE_VERSION}`,
				)
			}
			if (version === DATABASE_VERSION) return
			if (version === 0) {
				const tableCount = this.#database
					.query<{ value: number }, []>(
						`SELECT COUNT(*) AS value FROM sqlite_schema
						 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
					)
					.get()!.value
				if (tableCount !== 0) throw new Error('Unversioned service database is not empty')
				this.#database.exec(`
					CREATE TABLE auth_tokens (
						token_id TEXT PRIMARY KEY,
						token_hash TEXT NOT NULL UNIQUE,
						created_at TEXT NOT NULL,
						revoked_at TEXT,
						replaced_by TEXT REFERENCES auth_tokens(token_id),
						executor_label TEXT ${EXECUTOR_LABEL_CHECK}
					) STRICT;

					CREATE TABLE source_owners (
						source_instance TEXT PRIMARY KEY,
						owner_kind TEXT NOT NULL CHECK (owner_kind IN ('bearer', 'oidc')),
						owner_id TEXT REFERENCES auth_tokens(token_id),
						CHECK (
							(owner_kind = 'bearer' AND owner_id IS NOT NULL) OR
							(owner_kind = 'oidc' AND owner_id IS NULL)
						)
					) STRICT;

					${EVENTS_V2_TABLE};
				`)
			} else if (version === 1) {
				this.#database.exec(`
					ALTER TABLE auth_tokens ADD COLUMN executor_label TEXT ${EXECUTOR_LABEL_CHECK};
					ALTER TABLE events RENAME TO events_v1;
					${EVENTS_V2_TABLE};
					INSERT INTO events (
						event_id, schema_version, project_slug, source_instance, source_sequence,
						session_id, kind, occurred_at, occurred_at_ms,
						monotonic_duration_ms, received_at, received_at_ms
					)
					SELECT event_id, schema_version, NULL, source_instance, source_sequence,
					       session_id, kind, occurred_at, occurred_at_ms,
					       monotonic_duration_ms, received_at, received_at_ms
					FROM events_v1;
					DROP TABLE events_v1;
				`)
			}

			if (version === 3) {
				this.#database.exec(`
					ALTER TABLE target_overrides RENAME TO target_overrides_v3;
					${TARGET_OVERRIDES_V4_TABLE};
					INSERT INTO target_overrides (date, target_minutes, created_at, updated_at)
					SELECT date, target_minutes, created_at, updated_at FROM target_overrides_v3;
					DROP TABLE target_overrides_v3;
				`)
			} else {
				this.#database.exec(`${TARGET_OVERRIDES_V4_TABLE};`)
			}

			this.#database.exec(`
				CREATE UNIQUE INDEX IF NOT EXISTS auth_tokens_active_executor_label
					ON auth_tokens(executor_label)
					WHERE revoked_at IS NULL AND executor_label IS NOT NULL;
				CREATE INDEX IF NOT EXISTS source_owners_bearer_owner
					ON source_owners(owner_id) WHERE owner_kind = 'bearer';
				CREATE INDEX IF NOT EXISTS events_occurred_at_ms ON events(occurred_at_ms);
				CREATE INDEX IF NOT EXISTS events_project_slug_occurred_at_ms
					ON events(project_slug, occurred_at_ms) WHERE project_slug IS NOT NULL;
				PRAGMA user_version = ${DATABASE_VERSION};
			`)
		})
		migrate.immediate()
	}

	#eventById(eventId: string): EventRow | null {
		return this.#database
			.query<EventRow, [string]>(
				`SELECT schema_version AS schemaVersion, project_slug AS projectSlug,
				        event_id AS eventId,
				        source_instance AS sourceInstance, source_sequence AS sourceSequence,
				        session_id AS sessionId, kind, occurred_at AS occurredAt,
				        occurred_at_ms AS occurredAtMs,
				        monotonic_duration_ms AS monotonicDurationMs,
				        received_at AS receivedAt, received_at_ms AS receivedAtMs
				 FROM events WHERE event_id = ?`,
			)
			.get(eventId)
	}

	#eventBySequence(sourceInstance: string, sourceSequence: number): EventRow | null {
		return this.#database
			.query<EventRow, [string, number]>(
				`SELECT schema_version AS schemaVersion, project_slug AS projectSlug,
				        event_id AS eventId,
				        source_instance AS sourceInstance, source_sequence AS sourceSequence,
				        session_id AS sessionId, kind, occurred_at AS occurredAt,
				        occurred_at_ms AS occurredAtMs,
				        monotonic_duration_ms AS monotonicDurationMs,
				        received_at AS receivedAt, received_at_ms AS receivedAtMs
				 FROM events WHERE source_instance = ? AND source_sequence = ?`,
			)
			.get(sourceInstance, sourceSequence)
	}
}

function principalOwns(owner: SourceOwnerRow, principal: Principal): boolean {
	if (principal.kind === 'bearer') {
		return owner.ownerKind === 'bearer' && owner.ownerId === principal.tokenId
	}
	return owner.ownerKind === 'oidc'
}

function immutableEventEquals(row: EventRow, event: WorkEvent): boolean {
	return (
		row.schemaVersion === event.schemaVersion &&
		row.projectSlug === (event.projectSlug ?? null) &&
		row.eventId === event.eventId &&
		row.sourceInstance === event.sourceInstance &&
		row.sourceSequence === event.sourceSequence &&
		row.sessionId === event.sessionId &&
		row.kind === event.kind &&
		row.occurredAt === event.occurredAt &&
		row.occurredAtMs === event.occurredAtMs &&
		row.monotonicDurationMs === (event.monotonicDurationMs ?? null)
	)
}

function storedEvent(row: EventRow): StoredWorkEvent {
	return {
		schemaVersion: row.schemaVersion,
		...(row.projectSlug === null ? {} : { projectSlug: row.projectSlug }),
		eventId: row.eventId,
		sourceInstance: row.sourceInstance,
		sourceSequence: row.sourceSequence,
		sessionId: row.sessionId,
		kind: row.kind,
		occurredAt: row.occurredAt,
		occurredAtMs: row.occurredAtMs,
		...(row.monotonicDurationMs === null
			? {}
			: { monotonicDurationMs: row.monotonicDurationMs }),
		receivedAt: row.receivedAt,
		receivedAtMs: row.receivedAtMs,
	}
}
