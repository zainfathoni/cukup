import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { hashBearerToken } from './auth.ts'
import { MAX_CLOCK_SKEW_MS } from './config.ts'
import { ServiceStore } from './store.ts'
import type { Principal, WorkEvent } from './types.ts'

const temporaryDirectories: string[] = []
const now = Date.parse('2026-08-31T05:00:00.000Z')
const sourceA = '7ebc7d16-3945-4e30-b46e-2c288d747f6f'
const sourceB = 'ca3dfd5f-823b-4339-aefd-ade5f762b6f7'

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

function databasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), 'cukup-service-store-'))
	temporaryDirectories.push(directory)
	return join(directory, 'nested', 'service.sqlite')
}

function workEvent(overrides: Partial<WorkEvent> = {}): WorkEvent {
	const occurredAtMs = overrides.occurredAtMs ?? now
	return {
		schemaVersion: 1,
		eventId: '01990b2e-1c00-7000-8000-000000000001',
		sourceInstance: sourceA,
		sourceSequence: 1,
		sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		kind: 'agent.start',
		occurredAt: new Date(occurredAtMs).toISOString(),
		occurredAtMs,
		...overrides,
	}
}

function createVersion1Database(path: string): { token: string; tokenId: string } {
	mkdirSync(dirname(path), { recursive: true })
	const token = `cukup_v1_${'a'.repeat(43)}`
	const tokenId = '11111111-1111-4111-8111-111111111111'
	const database = new Database(path, { create: true, strict: true })
	database.exec(`
		CREATE TABLE auth_tokens (
			token_id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL,
			revoked_at TEXT,
			replaced_by TEXT REFERENCES auth_tokens(token_id)
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
		CREATE TABLE events (
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
	database
		.query('INSERT INTO auth_tokens (token_id, token_hash, created_at) VALUES (?, ?, ?)')
		.run(tokenId, hashBearerToken(token), new Date(now).toISOString())
	database
		.query('INSERT INTO source_owners (source_instance, owner_kind, owner_id) VALUES (?, ?, ?)')
		.run(sourceA, 'bearer', tokenId)
	database
		.query(
			`INSERT INTO events VALUES (?, 1, ?, 1, ?, 'agent.start', ?, ?, NULL, ?, ?)`,
		)
		.run(
			'01990b2e-1c00-7000-8000-000000000001',
			sourceA,
			'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			new Date(now - 60_000).toISOString(),
			now - 60_000,
			new Date(now).toISOString(),
			now,
		)
	database.close()
	return { token, tokenId }
}

function createVersion2Database(path: string): void {
	const current = new ServiceStore(path)
	current.close()
	const database = new Database(path, { strict: true })
	database.exec(`
		DROP TABLE shadow_coverage;
		DROP INDEX auth_tokens_active_execution_site_id;
		ALTER TABLE auth_tokens DROP COLUMN execution_site_id;
		DROP TABLE shadow_evidence;
		DROP TABLE shadow_collectors;
		DROP TABLE target_overrides;
		PRAGMA user_version = 2;
	`)
	database.close()
}

function createVersion3Database(path: string): void {
	const current = new ServiceStore(path)
	current.ingest({ kind: 'oidc' }, workEvent(), now)
	current.putTargetOverride('2026-09-01', 0, now)
	current.close()
	const database = new Database(path, { strict: true })
	database.exec(`
		DROP TABLE shadow_coverage;
		DROP INDEX auth_tokens_active_execution_site_id;
		ALTER TABLE auth_tokens DROP COLUMN execution_site_id;
		DROP TABLE shadow_evidence;
		DROP TABLE shadow_collectors;
		ALTER TABLE target_overrides RENAME TO target_overrides_v4;
		CREATE TABLE target_overrides (
			date TEXT PRIMARY KEY CHECK (
				length(date) = 10 AND
				date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
			),
			target_minutes INTEGER NOT NULL CHECK (target_minutes = 0),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		) STRICT;
		INSERT INTO target_overrides SELECT * FROM target_overrides_v4;
		DROP TABLE target_overrides_v4;
		PRAGMA user_version = 3;
	`)
	database.close()
}

describe('SQLite schema migration', () => {
	test('migrates v1 transactionally, preserves evidence, and remains stable across restart', () => {
		const path = databasePath()
		const credential = createVersion1Database(path)
		for (let restart = 0; restart < 2; restart += 1) {
			const store = new ServiceStore(path)
			expect(store.authenticateBearer(credential.token)).toEqual({
				kind: 'bearer',
				tokenId: credential.tokenId,
			})
			expect(store.events()).toEqual([
				expect.objectContaining({
					schemaVersion: 1,
					eventId: '01990b2e-1c00-7000-8000-000000000001',
					receivedAtMs: now,
				}),
			])
			store.close()
			const inspected = new Database(path, { readonly: true, strict: true })
			expect(inspected.query<{ user_version: number }, []>('PRAGMA user_version').get()).toEqual({
				user_version: 7,
			})
			expect(
				inspected
					.query<{ name: string }, []>(
						`SELECT name FROM pragma_table_info('events') WHERE name = 'project_slug'`,
					)
					.get(),
			).toEqual({ name: 'project_slug' })
			expect(
				inspected
					.query<{ name: string }, []>(
						`SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'target_overrides'`,
					)
					.get(),
			).toEqual({ name: 'target_overrides' })
			inspected.close()
		}
	})

	test('migrates the current v2 generation once and remains stable across restart', () => {
		const path = databasePath()
		createVersion2Database(path)
		for (let restart = 0; restart < 2; restart += 1) {
			const store = new ServiceStore(path)
			expect(store.targetOverrides()).toEqual(new Map())
			store.close()
			const inspected = new Database(path, { readonly: true, strict: true })
			expect(inspected.query<{ user_version: number }, []>('PRAGMA user_version').get()).toEqual({
				user_version: 7,
			})
			inspected.close()
		}
	})

	test('migrates production v3 transactionally without changing evidence or zero-minute overrides', () => {
		const path = databasePath()
		createVersion3Database(path)
		for (let restart = 0; restart < 2; restart += 1) {
			const store = new ServiceStore(path)
			expect(store.events()).toEqual([
				expect.objectContaining({
					eventId: '01990b2e-1c00-7000-8000-000000000001',
					receivedAtMs: now,
				}),
			])
			expect(store.targetOverrides()).toEqual(new Map([['2026-09-01', 0]]))
			store.close()
			const inspected = new Database(path, { readonly: true, strict: true })
			expect(inspected.query<{ user_version: number }, []>('PRAGMA user_version').get()).toEqual({
				user_version: 7,
			})
			expect(
				inspected
					.query<{ targetMinutes: number; createdAt: string; updatedAt: string }, []>(
						`SELECT target_minutes AS targetMinutes, created_at AS createdAt,
						        updated_at AS updatedAt FROM target_overrides`,
					)
					.get(),
			).toEqual({
				targetMinutes: 0,
				createdAt: '2026-08-31T05:00:00.000Z',
				updatedAt: '2026-08-31T05:00:00.000Z',
			})
			inspected.close()
		}
	})

	test('creates v7 directly with the exact target constraint and remains stable across restart', () => {
		const path = databasePath()
		const store = new ServiceStore(path)
		store.putTargetOverride('2026-09-01', 240, now)
		store.close()

		const database = new Database(path, { strict: true })
		expect(database.query<{ user_version: number }, []>('PRAGMA user_version').get()).toEqual({
			user_version: 7,
		})
		database
			.query('INSERT INTO target_overrides VALUES (?, ?, ?, ?)')
			.run('2026-09-02', 0, new Date(now).toISOString(), new Date(now).toISOString())
		expect(() =>
			database
				.query('INSERT INTO target_overrides VALUES (?, ?, ?, ?)')
				.run('2026-09-03', 1, new Date(now).toISOString(), new Date(now).toISOString()),
		).toThrow()
		database.close()

		const reopened = new ServiceStore(path)
		expect(reopened.targetOverrides()).toEqual(
			new Map([
				['2026-09-01', 240],
				['2026-09-02', 0],
			]),
		)
		reopened.close()
	})

	test('adds an opaque site to an existing bound v5 bearer and carries it through rotation', () => {
		const path = databasePath()
		const before = new ServiceStore(path)
		const credential = before.issueBearer(now)
		const unbound = before.issueBearer(now + 1)
		const revoked = before.issueBearer(now + 2)
		before.bindExecutorLabel(credential.tokenId, 'zain-macbook')
		before.bindExecutorLabel(revoked.tokenId, 'retired-machine')
		before.revokeBearer(revoked.tokenId, now + 3)
		before.ingest(before.authenticateBearer(credential.token)!, workEvent(), now)
		before.close()

		const versionFive = new Database(path, { strict: true })
		versionFive.exec(`
			DROP TABLE shadow_coverage;
			DROP INDEX auth_tokens_active_execution_site_id;
			ALTER TABLE auth_tokens DROP COLUMN execution_site_id;
			PRAGMA user_version = 5;
		`)
		versionFive.close()
		const migrated = new ServiceStore(path)
		const site = migrated.shadowExecutionSite(credential.tokenId)
		expect(site).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		)
		expect(migrated.shadowExecutionSite(unbound.tokenId)).toBeUndefined()
		expect(migrated.shadowExecutionSite(revoked.tokenId)).toBeUndefined()
		expect(migrated.events()).toEqual([expect.objectContaining({ eventId: workEvent().eventId })])
		const replacement = migrated.rotateBearer(credential.tokenId, now + 1)
		expect(migrated.shadowExecutionSite(replacement.tokenId)).toBe(site)
		migrated.close()
		const reopened = new ServiceStore(path)
		expect(reopened.shadowExecutionSite(replacement.tokenId)).toBe(site)
		expect(reopened.events()).toHaveLength(1)
		reopened.close()
	})

	test('rolls back schema-6 column, site initialization, and version on migration failure', () => {
		const path = databasePath()
		const current = new ServiceStore(path)
		const credential = current.issueBearer(now)
		current.bindExecutorLabel(credential.tokenId, 'zain-macbook')
		current.close()
		const versionFive = new Database(path, { strict: true })
		versionFive.exec(`
			DROP TABLE shadow_coverage;
			DROP INDEX auth_tokens_active_execution_site_id;
			ALTER TABLE auth_tokens DROP COLUMN execution_site_id;
			CREATE TRIGGER fail_site BEFORE UPDATE ON auth_tokens
				WHEN NEW.executor_label IS NOT NULL
				BEGIN SELECT RAISE(ABORT, 'injected site migration failure'); END;
			PRAGMA user_version = 5;
		`)
		expect(() => new ServiceStore(path)).toThrow('injected site migration failure')
		expect(versionFive.query('PRAGMA user_version').get()).toEqual({ user_version: 5 })
		expect(
			versionFive.query(
				`SELECT name FROM pragma_table_info('auth_tokens') WHERE name = 'execution_site_id'`,
			).all(),
		).toEqual([])
		versionFive.exec('DROP TRIGGER fail_site')
		versionFive.close()
		const repaired = new ServiceStore(path)
		expect(repaired.shadowExecutionSite(credential.tokenId)).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		)
		repaired.close()
	})

	test('refuses a future schema without resetting its migration version', () => {
		const path = databasePath()
		const store = new ServiceStore(path)
		store.close()
		const future = new Database(path, { strict: true })
		future.exec('PRAGMA user_version = 8')
		future.close()
		expect(() => new ServiceStore(path)).toThrow('newer than supported')
		const inspected = new Database(path, { readonly: true, strict: true })
		expect(inspected.query<{ user_version: number }, []>('PRAGMA user_version').get()).toEqual({
			user_version: 8,
		})
		inspected.close()
	})
})

describe('target overrides', () => {
	test('updates between full and half days while exact retries preserve audit timestamps', () => {
		const path = databasePath()
		const first = new ServiceStore(path)
		expect(first.putTargetOverride('2026-09-01', 0, now)).toEqual({
			date: '2026-09-01',
			targetMinutes: 0,
			createdAt: '2026-08-31T05:00:00.000Z',
			updatedAt: '2026-08-31T05:00:00.000Z',
		})
		expect(first.putTargetOverride('2026-09-01', 0, now + 60_000)).toEqual({
			date: '2026-09-01',
			targetMinutes: 0,
			createdAt: '2026-08-31T05:00:00.000Z',
			updatedAt: '2026-08-31T05:00:00.000Z',
		})
		expect(first.putTargetOverride('2026-09-01', 240, now + 120_000)).toEqual({
			date: '2026-09-01',
			targetMinutes: 240,
			createdAt: '2026-08-31T05:00:00.000Z',
			updatedAt: '2026-08-31T05:02:00.000Z',
		})
		expect(first.putTargetOverride('2026-09-01', 240, now + 180_000)).toEqual({
			date: '2026-09-01',
			targetMinutes: 240,
			createdAt: '2026-08-31T05:00:00.000Z',
			updatedAt: '2026-08-31T05:02:00.000Z',
		})
		expect(first.targetOverrides()).toEqual(new Map([['2026-09-01', 240]]))
		first.close()

		const inspected = new Database(path, { readonly: true, strict: true })
		expect(
			inspected
				.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('target_overrides')`)
				.all()
				.map((column) => column.name),
		).toEqual(['date', 'target_minutes', 'created_at', 'updated_at'])
		inspected.close()

		const reopened = new ServiceStore(path)
		expect(reopened.targetOverrides()).toEqual(new Map([['2026-09-01', 240]]))
		expect(reopened.clearTargetOverride('2026-09-01')).toBeTrue()
		expect(reopened.clearTargetOverride('2026-09-01')).toBeFalse()
		reopened.close()
		const cleared = new ServiceStore(path)
		expect(cleared.targetOverrides()).toEqual(new Map())
		cleared.close()
	})
})

describe('append-only ingestion', () => {
	test('preserves receive time for exact event-ID and source-sequence replays', () => {
		const store = new ServiceStore(databasePath())
		const credential = store.issueBearer(now)
		const principal = store.authenticateBearer(credential.token)!
		const event = workEvent({ monotonicDurationMs: 1234 })

		expect(store.ingest(principal, event, now)).toEqual({
			outcome: 'accepted',
			receivedAt: '2026-08-31T05:00:00.000Z',
		})
		expect(store.ingest(principal, event, now + 5_000)).toEqual({
			outcome: 'duplicate',
			receivedAt: '2026-08-31T05:00:00.000Z',
		})
		expect(store.events()).toHaveLength(1)
		expect(store.events()[0]).toMatchObject({
			receivedAtMs: now,
			monotonicDurationMs: 1234,
		})
		store.close()
	})

	test('surfaces immutable conflicts without overwriting accepted evidence', () => {
		const store = new ServiceStore(databasePath())
		const principal = store.authenticateBearer(store.issueBearer(now).token)!
		const original = workEvent()
		store.ingest(principal, original, now)

		expect(
			store.ingest(
				principal,
				workEvent({ sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
				now,
			),
		).toEqual({ outcome: 'conflicted', reason: 'event_id_conflict' })
		expect(
			store.ingest(
				principal,
				workEvent({ eventId: '01990b2e-1c00-7000-8000-000000000002' }),
				now,
			),
		).toEqual({ outcome: 'conflicted', reason: 'source_sequence_conflict' })
		expect(store.events()).toEqual([
			expect.objectContaining({ eventId: original.eventId, sessionId: original.sessionId }),
		])
		store.close()
	})

	test('preserves mixed v1/v2 rows and includes schema and slug in exact replay', () => {
		const path = databasePath()
		const store = new ServiceStore(path)
		const issued = store.issueBearer(now)
		const principal = store.authenticateBearer(issued.token)!
		expect(store.ingest(principal, workEvent(), now).outcome).toBe('accepted')
		expect(store.bindExecutorLabel(issued.tokenId, 'zain-macbook')).toEqual({
			outcome: 'bound',
			executorLabel: 'zain-macbook',
		})
		const v2 = workEvent({
			schemaVersion: 2,
			projectSlug: 'cukup-service',
			eventId: '01990b2e-1c00-7000-8000-000000000002',
			sourceSequence: 2,
			sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
			occurredAtMs: now - 24 * 60 * 60 * 1_000,
		})
		expect(store.ingest(principal, v2, now).outcome).toBe('accepted')
		store.close()

		const reopened = new ServiceStore(path)
		const reopenedPrincipal = reopened.authenticateBearer(issued.token)!
		expect(reopened.ingest(reopenedPrincipal, workEvent(), now + 1).outcome).toBe('duplicate')
		expect(reopened.ingest(reopenedPrincipal, v2, now + 1)).toEqual({
			outcome: 'duplicate',
			receivedAt: new Date(now).toISOString(),
		})
		expect(
			reopened.ingest(reopenedPrincipal, { ...v2, schemaVersion: 1, projectSlug: undefined }, now + 1),
		).toEqual({ outcome: 'conflicted', reason: 'event_id_conflict' })
		expect(
			reopened.ingest(
				reopenedPrincipal,
				{
					...v2,
					eventId: '01990b2e-1c00-7000-8000-000000000003',
					projectSlug: 'another-project',
				},
				now + 1,
			),
		).toEqual({ outcome: 'conflicted', reason: 'source_sequence_conflict' })
		expect(reopened.events()).toEqual([
			expect.objectContaining({ schemaVersion: 1 }),
			expect.objectContaining({ schemaVersion: 2, projectSlug: 'cukup-service' }),
		])
		reopened.close()
	})

	test('rejects physical v2 before binding and rejects changed turn attribution', () => {
		const store = new ServiceStore(databasePath())
		const issued = store.issueBearer(now)
		const principal = store.authenticateBearer(issued.token)!
		const start = workEvent({ schemaVersion: 2, projectSlug: 'cukup-service' })
		expect(store.ingest(principal, start, now)).toEqual({
			outcome: 'rejected',
			reason: 'executor_profile_required',
		})
		store.bindExecutorLabel(issued.tokenId, 'zain-macbook')
		expect(store.ingest(principal, start, now).outcome).toBe('accepted')
		expect(
			store.ingest(
				principal,
				workEvent({
					schemaVersion: 2,
					projectSlug: 'changed-project',
					eventId: '01990b2e-1c00-7000-8000-000000000002',
					sourceSequence: 2,
					kind: 'agent.end',
				}),
				now,
			),
		).toEqual({ outcome: 'rejected', reason: 'session_attribution_mismatch' })
		store.close()
	})

	test('accepts delayed offline evidence and rejects excessive future evidence visibly', () => {
		const store = new ServiceStore(databasePath())
		const principal: Principal = { kind: 'oidc' }
		expect(
			store.ingest(
				principal,
				workEvent({ occurredAtMs: now - 24 * 60 * 60 * 1_000, sourceInstance: sourceA }),
				now,
			).outcome,
		).toBe('accepted')
		expect(
			store.ingest(
				principal,
				workEvent({
					eventId: '01990b2e-1c00-7000-8000-000000000002',
					sourceInstance: sourceA,
					sourceSequence: 2,
					occurredAtMs: now + MAX_CLOCK_SKEW_MS + 1,
				}),
				now,
			),
		).toEqual({ outcome: 'rejected', reason: 'clock_skew' })
		expect(store.events()).toHaveLength(1)
		store.close()
	})

	test('rejects a new lower sequence while allowing exact old replay', () => {
		const store = new ServiceStore(databasePath())
		const principal = store.authenticateBearer(store.issueBearer(now).token)!
		const later = workEvent({
			eventId: '01990b2e-1c00-7000-8000-000000000003',
			sourceSequence: 3,
		})
		expect(store.ingest(principal, later, now).outcome).toBe('accepted')
		expect(
			store.ingest(
				principal,
				workEvent({
					eventId: '01990b2e-1c00-7000-8000-000000000002',
					sourceSequence: 2,
				}),
				now,
			),
		).toEqual({ outcome: 'rejected', reason: 'source_sequence_order' })
		expect(store.ingest(principal, later, now + 1).outcome).toBe('duplicate')
		store.close()
	})
})

describe('authentication and source ownership', () => {
	test('stores only bearer hashes and keeps credentials independently revocable', () => {
		const path = databasePath()
		const store = new ServiceStore(path)
		const first = store.issueBearer(now)
		const second = store.issueBearer(now + 1)
		expect(store.authenticateBearer(first.token)).toEqual({ kind: 'bearer', tokenId: first.tokenId })
		expect(store.revokeBearer(first.tokenId, now + 2)).toBeTrue()
		expect(store.authenticateBearer(first.token)).toBeUndefined()
		expect(store.authenticateBearer(second.token)).toEqual({ kind: 'bearer', tokenId: second.tokenId })

		const raw = new Database(path, { readonly: true, strict: true })
		const rows = raw.query<{ token_hash: string }, []>('SELECT token_hash FROM auth_tokens').all()
		expect(rows.map((row) => row.token_hash)).toContain(hashBearerToken(first.token))
		expect(rows.map((row) => row.token_hash)).not.toContain(first.token)
		raw.close()
		expect(readFileSync(path).includes(Buffer.from(first.token))).toBeFalse()
		store.close()
	})

	test('transfers claimed random sources atomically during token rotation', () => {
		const store = new ServiceStore(databasePath())
		const old = store.issueBearer(now)
		const oldPrincipal = store.authenticateBearer(old.token)!
		store.ingest(oldPrincipal, workEvent(), now)

		const replacement = store.rotateBearer(old.tokenId, now + 1)
		expect(store.authenticateBearer(old.token)).toBeUndefined()
		const replacementPrincipal = store.authenticateBearer(replacement.token)!
		expect(
			store.ingest(
				replacementPrincipal,
				workEvent({
					eventId: '01990b2e-1c00-7000-8000-000000000002',
					sourceSequence: 2,
				}),
				now,
			).outcome,
		).toBe('accepted')
		store.close()
	})

	test('enforces immutable unique bindings and carries labels through atomic rotation', () => {
		const store = new ServiceStore(databasePath())
		const first = store.issueBearer(now)
		const second = store.issueBearer(now + 1)
		const principal = store.authenticateBearer(first.token)!
		store.ingest(principal, workEvent(), now)
		expect(store.attributedEvents()[0]?.executorLabel).toBe('unassigned-executor')
		expect(store.bindExecutorLabel(first.tokenId, 'zain-macbook')).toEqual({
			outcome: 'bound',
			executorLabel: 'zain-macbook',
		})
		expect(store.bindExecutorLabel(first.tokenId, 'zain-macbook').outcome).toBe('bound')
		expect(store.bindExecutorLabel(first.tokenId, 'vikas-mac-mini').outcome).toBe('conflict')
		expect(store.bindExecutorLabel(second.tokenId, 'zain-macbook').outcome).toBe('conflict')
		expect(store.attributedEvents()[0]?.executorLabel).toBe('zain-macbook')

		const site = store.shadowExecutionSite(first.tokenId)
		expect(() => store.rotateBearer(first.tokenId, now + 2, second)).toThrow()
		expect(store.authenticateBearer(first.token)).toEqual({ kind: 'bearer', tokenId: first.tokenId })
		expect(store.attributedEvents()[0]?.executorLabel).toBe('zain-macbook')
		expect(store.shadowExecutionSite(first.tokenId)).toBe(site)

		const replacement = store.rotateBearer(first.tokenId, now + 3)
		expect(store.authenticateBearer(first.token)).toBeUndefined()
		const replacementPrincipal = store.authenticateBearer(replacement.token)!
		expect(replacementPrincipal).toEqual({
			kind: 'bearer',
			tokenId: replacement.tokenId,
		})
		expect(store.ingest(replacementPrincipal, workEvent(), now + 4).outcome).toBe('duplicate')
		expect(store.attributedEvents()[0]?.executorLabel).toBe('zain-macbook')
		expect(store.listBearerMetadata().find((row) => row.tokenId === replacement.tokenId)).toMatchObject({
			executorLabel: 'zain-macbook',
			revokedAt: null,
		})
		expect(
			store
				.listBearerMetadata()
				.filter((row) => row.executorLabel === 'zain-macbook' && row.revokedAt === null),
		).toHaveLength(1)
		store.close()
	})

	test('derives historical executor attribution from stable source ownership', () => {
		const store = new ServiceStore(databasePath())
		const labeled = store.issueBearer(now)
		const unlabeled = store.issueBearer(now + 1)
		store.ingest(store.authenticateBearer(labeled.token)!, workEvent(), now)
		store.ingest(
			store.authenticateBearer(unlabeled.token)!,
			workEvent({
				eventId: '01990b2e-1c00-7000-8000-000000000002',
				sourceInstance: sourceB,
			}),
			now,
		)
		store.ingest(
			{ kind: 'oidc' },
			workEvent({
				eventId: '01990b2e-1c00-7000-8000-000000000003',
				sourceInstance: '9d725e65-8871-43a8-8841-a75218c58e62',
			}),
			now,
		)
		expect(store.attributedEvents().map((event) => event.executorLabel).sort()).toEqual([
			'amp-orb',
			'unassigned-executor',
			'unassigned-executor',
		])
		store.bindExecutorLabel(labeled.tokenId, 'zain-macbook')
		expect(store.attributedEvents().map((event) => event.executorLabel).sort()).toEqual([
			'amp-orb',
			'unassigned-executor',
			'zain-macbook',
		])
		store.close()
	})

	test('prevents bearer and OIDC principals from impersonating claimed sources', () => {
		const store = new ServiceStore(databasePath())
		const first = store.authenticateBearer(store.issueBearer(now).token)!
		const second = store.authenticateBearer(store.issueBearer(now + 1).token)!
		store.ingest(first, workEvent(), now)
		expect(
			store.ingest(
				second,
				workEvent({
					eventId: '01990b2e-1c00-7000-8000-000000000002',
					sourceSequence: 2,
				}),
				now,
			),
		).toEqual({ outcome: 'rejected', reason: 'source_not_authorized' })
		expect(
			store.ingest(
				{ kind: 'oidc' },
				workEvent({
					eventId: '01990b2e-1c00-7000-8000-000000000003',
					sourceSequence: 3,
				}),
				now,
			),
		).toEqual({ outcome: 'rejected', reason: 'source_not_authorized' })

		expect(
			store.ingest(
				{ kind: 'oidc' },
				workEvent({
					eventId: '01990b2e-1c00-7000-8000-000000000010',
					sourceInstance: sourceB,
				}),
				now,
			).outcome,
		).toBe('accepted')
		expect(
			store.ingest(
				first,
				workEvent({
					eventId: '01990b2e-1c00-7000-8000-000000000004',
					sourceInstance: sourceB,
					sourceSequence: 2,
				}),
				now,
			),
		).toEqual({ outcome: 'rejected', reason: 'source_not_authorized' })
		store.close()
	})
})
