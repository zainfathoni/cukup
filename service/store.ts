import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { generateBearerToken, hashBearerToken, type IssuedToken } from './auth.ts'
import { MAX_CLOCK_SKEW_MS, defaultServiceDatabasePath } from './config.ts'
import type { IngestOutcome, Principal, StoredWorkEvent, WorkEvent } from './types.ts'

type EventRow = {
	schemaVersion: 1
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
		this.#database.exec(`
			CREATE TABLE IF NOT EXISTS auth_tokens (
				token_id TEXT PRIMARY KEY,
				token_hash TEXT NOT NULL UNIQUE,
				created_at TEXT NOT NULL,
				revoked_at TEXT,
				replaced_by TEXT REFERENCES auth_tokens(token_id)
			) STRICT;

			CREATE TABLE IF NOT EXISTS source_owners (
				source_instance TEXT PRIMARY KEY,
				owner_kind TEXT NOT NULL CHECK (owner_kind IN ('bearer', 'oidc')),
				owner_id TEXT REFERENCES auth_tokens(token_id),
				CHECK (
					(owner_kind = 'bearer' AND owner_id IS NOT NULL) OR
					(owner_kind = 'oidc' AND owner_id IS NULL)
				)
			) STRICT;

			CREATE TABLE IF NOT EXISTS events (
				event_id TEXT PRIMARY KEY,
				schema_version INTEGER NOT NULL CHECK (schema_version = 1),
				source_instance TEXT NOT NULL REFERENCES source_owners(source_instance),
				source_sequence INTEGER NOT NULL CHECK (source_sequence >= 1),
				session_id TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('agent.start', 'agent.end')),
				occurred_at TEXT NOT NULL,
				occurred_at_ms INTEGER NOT NULL,
				monotonic_duration_ms INTEGER CHECK (monotonic_duration_ms IS NULL OR monotonic_duration_ms >= 0),
				received_at TEXT NOT NULL,
				received_at_ms INTEGER NOT NULL,
				UNIQUE (source_instance, source_sequence)
			) STRICT;

			PRAGMA user_version = 1;
		`)
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
				.query<{ tokenId: string }, [string]>(
					`SELECT token_id AS tokenId FROM auth_tokens
					 WHERE token_id = ? AND revoked_at IS NULL`,
				)
				.get(tokenId)
			if (!current) throw new Error('Active bearer credential not found')
			const at = new Date(nowMs).toISOString()
			this.#database
				.query(
					`INSERT INTO auth_tokens (token_id, token_hash, created_at)
					 VALUES (?, ?, ?)`,
				)
				.run(issued.tokenId, issued.tokenHash, at)
			this.#database
				.query(
					`UPDATE auth_tokens SET revoked_at = ?, replaced_by = ?
					 WHERE token_id = ?`,
				)
				.run(at, issued.tokenId, tokenId)
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

	listBearerMetadata(): Array<{
		tokenId: string
		createdAt: string
		revokedAt: string | null
		replacedBy: string | null
	}> {
		return this.#database
			.query<
				{
					tokenId: string
					createdAt: string
					revokedAt: string | null
					replacedBy: string | null
				},
				[]
			>(
				`SELECT token_id AS tokenId, created_at AS createdAt,
				        revoked_at AS revokedAt, replaced_by AS replacedBy
				 FROM auth_tokens ORDER BY created_at, token_id`,
			)
			.all()
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
						event_id, schema_version, source_instance, source_sequence,
						session_id, kind, occurred_at, occurred_at_ms,
						monotonic_duration_ms, received_at, received_at_ms
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					event.eventId,
					event.schemaVersion,
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
				`SELECT schema_version AS schemaVersion, event_id AS eventId,
				        source_instance AS sourceInstance, source_sequence AS sourceSequence,
				        session_id AS sessionId, kind, occurred_at AS occurredAt,
				        occurred_at_ms AS occurredAtMs,
				        monotonic_duration_ms AS monotonicDurationMs,
				        received_at AS receivedAt, received_at_ms AS receivedAtMs
				 FROM events ORDER BY source_instance, source_sequence`,
			)
			.all()
			.map((row) => ({
				schemaVersion: row.schemaVersion,
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
			}))
	}

	integrityCheck(): string {
		return this.#database.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()!
			.integrity_check
	}

	close(): void {
		this.#database.close()
	}

	#eventById(eventId: string): EventRow | null {
		return this.#database
			.query<EventRow, [string]>(
				`SELECT schema_version AS schemaVersion, event_id AS eventId,
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
				`SELECT schema_version AS schemaVersion, event_id AS eventId,
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
