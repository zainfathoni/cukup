import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EVENT_SCHEMA_VERSION_V1, EVENT_SCHEMA_VERSION_V2 } from './protocol.ts'
import { WorkHoursStore } from './store.ts'

const temporaryDirectories: string[] = []

function databasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), 'amp-work-hours-test-'))
	temporaryDirectories.push(directory)
	return join(directory, 'nested', 'state.sqlite')
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

describe('WorkHoursStore', () => {
	test('persists events idempotently across store instances', () => {
		const path = databasePath()
		const first = new WorkHoursStore(path)
		first.record({ threadId: 'T-one', messageId: '1', kind: 'start', atMs: 100 })
		first.record({ threadId: 'T-one', messageId: '1', kind: 'start', atMs: 999 })
		first.close()

		const reopened = new WorkHoursStore(path)
		expect(reopened.events()).toEqual([
			{ threadId: 'T-one', messageId: '1', kind: 'start', atMs: 100 },
		])
		reopened.close()
	})

	test('conditionally records an end only after its matching start', () => {
		const store = new WorkHoursStore(databasePath())
		expect(
			store.recordEndIfStarted({
				threadId: 'T-one',
				messageId: '1',
				kind: 'end',
				atMs: 100,
				status: 'done',
			}),
		).toBeUndefined()
		expect(store.events()).toEqual([])

		store.record({ threadId: 'T-one', messageId: '1', kind: 'start', atMs: 200 })
		expect(
			store.recordEndIfStarted(
				{ threadId: 'T-one', messageId: '1', kind: 'end', atMs: 300, status: 'error' },
				100,
			),
		).toMatchObject({ kind: 'agent.end', monotonic_duration_ms: 100 })
		expect(store.events()).toEqual([
			{ threadId: 'T-one', messageId: '1', kind: 'start', atMs: 200 },
			{ threadId: 'T-one', messageId: '1', kind: 'end', atMs: 300, status: 'error' },
		])
		store.close()
	})

	test('writes legacy fallback evidence and its outbox row in one transaction', () => {
		const path = databasePath()
		const store = new WorkHoursStore(path)
		const database = new Database(path)
		database.exec(`
			CREATE TRIGGER reject_outbox BEFORE INSERT ON outbox
			BEGIN
				SELECT RAISE(ABORT, 'injected outbox failure');
			END;
		`)
		expect(() =>
			store.record({ threadId: 'T-one', messageId: '1', kind: 'start', atMs: 100 }),
		).toThrow('injected outbox failure')
		expect(store.events()).toEqual([])
		expect(store.outboxCounts()).toEqual({ pending: 0, conflict: 0, rejected: 0 })
		expect(store.trackingIncomplete()).toBeTrue()
		expect(store.trackingGap()).toMatchObject({ reasons: ['event-recording'] })
		database.close()
		store.close()
		const reopened = new WorkHoursStore(path)
		expect(reopened.trackingIncomplete()).toBeTrue()
		expect(reopened.trackingGap()).toMatchObject({ reasons: ['event-recording'] })
		reopened.acknowledgeTrackingGap()
		expect(reopened.trackingGap()).toBeUndefined()
		reopened.close()
	})

	test('reads and safely acknowledges a legacy boolean-only tracking gap', () => {
		const path = databasePath()
		const store = new WorkHoursStore(path)
		const database = new Database(path)
		database.query("INSERT INTO settings (key, value) VALUES ('tracking-incomplete', 'true')").run()
		expect(store.trackingGap()).toEqual({
			firstObservedAtMs: null,
			lastObservedAtMs: null,
			reasons: ['legacy-unknown'],
		})
		store.markTrackingIncomplete('thread-state-observation', 1_000)
		expect(store.trackingGap()).toEqual({
			firstObservedAtMs: null,
			lastObservedAtMs: 1_000,
			reasons: ['legacy-unknown', 'thread-state-observation'],
		})
		store.acknowledgeTrackingGap()
		expect(store.trackingIncomplete()).toBeFalse()
		expect(store.trackingGap()).toBeUndefined()
		database.close()
		store.close()
	})

	test('uses persistent random source identity, per-turn sessions, and monotonic source order', () => {
		const path = databasePath()
		const store = new WorkHoursStore(path)
		const first = store.record({ threadId: 'T-one', messageId: '1', kind: 'start', atMs: 100 })
		store.close()

		const reopened = new WorkHoursStore(path)
		const second = reopened.record(
			{ threadId: 'T-one', messageId: '1', kind: 'end', atMs: 200, status: 'done' },
			99.6,
		)
		expect(first?.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
		expect(first?.source_instance_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
		expect(first?.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
		expect(second?.source_sequence).toBe((first?.source_sequence ?? 0) + 1)
		expect(second?.source_instance_id).toBe(first?.source_instance_id)
		expect(second?.session_id).toBe(first?.session_id)
		expect(second?.monotonic_duration_ms).toBe(100)
		const third = reopened.record({ threadId: 'T-two', messageId: '2', kind: 'start', atMs: 300 })
		expect(third?.source_instance_id).toBe(first?.source_instance_id)
		expect(third?.session_id).not.toBe(first?.session_id)
		expect(third?.source_sequence).toBe((second?.source_sequence ?? 0) + 1)
		reopened.close()
	})

	test('replays a v1 row after interrupted delivery deletion without changing its wire shape', () => {
		const path = databasePath()
		const first = new WorkHoursStore(path)
		const recorded = first.record({ threadId: 'T-one', messageId: '1', kind: 'start', atMs: 100 })!
		first.close()

		const upgraded = new WorkHoursStore(path)
		const replayed = upgraded.pendingEvents(10)[0]!
		expect(replayed).toEqual(recorded)
		expect(Object.keys(replayed).sort()).toEqual([
			'event_id',
			'kind',
			'occurred_at',
			'schema_version',
			'session_id',
			'source_instance_id',
			'source_sequence',
		])
		expect(replayed.schema_version).toBe(EVENT_SCHEMA_VERSION_V1)
		upgraded.close()
	})

	test('reuses a v2 turn snapshot across restart and a changed Project Slug', () => {
		const path = databasePath()
		const first = new WorkHoursStore(path)
		const start = first.record(
			{ threadId: 'T-one', messageId: '1', kind: 'start', atMs: 100 },
			undefined,
			{ schemaVersion: EVENT_SCHEMA_VERSION_V2, projectSlug: 'project-before' },
		)!
		first.close()

		const restarted = new WorkHoursStore(path)
		const end = restarted.record(
			{ threadId: 'T-one', messageId: '1', kind: 'end', atMs: 200, status: 'done' },
			undefined,
			{ schemaVersion: EVENT_SCHEMA_VERSION_V2, projectSlug: 'project-after' },
		)!
		expect(start).toMatchObject({
			schema_version: EVENT_SCHEMA_VERSION_V2,
			project_slug: 'project-before',
		})
		expect(end).toMatchObject({
			schema_version: EVENT_SCHEMA_VERSION_V2,
			project_slug: 'project-before',
			session_id: start.session_id,
		})
		restarted.close()
	})

	test('keeps a v1 turn v1 and makes an orphan end v1 Unassigned', () => {
		const store = new WorkHoursStore(databasePath())
		const start = store.record({ threadId: 'T-v1', messageId: '1', kind: 'start', atMs: 100 })!
		const end = store.record(
			{ threadId: 'T-v1', messageId: '1', kind: 'end', atMs: 200, status: 'done' },
			undefined,
			{ schemaVersion: EVENT_SCHEMA_VERSION_V2, projectSlug: 'later-config' },
		)!
		const orphan = store.record(
			{ threadId: 'T-orphan', messageId: '2', kind: 'end', atMs: 300, status: 'error' },
			undefined,
			{ schemaVersion: EVENT_SCHEMA_VERSION_V2, projectSlug: 'current-config' },
		)!
		for (const event of [start, end, orphan]) {
			expect(event.schema_version).toBe(EVENT_SCHEMA_VERSION_V1)
			expect(event).not.toHaveProperty('project_slug')
		}
		expect(end.session_id).toBe(start.session_id)
		store.close()
	})

	test('deletes only accepted and exact duplicate rows while retaining conflicts and rejections', () => {
		const store = new WorkHoursStore(databasePath())
		const events = [
			store.record({ threadId: 'T-one', messageId: '1', kind: 'start', atMs: 100 }),
			store.record({ threadId: 'T-two', messageId: '2', kind: 'start', atMs: 200 }),
			store.record({ threadId: 'T-three', messageId: '3', kind: 'start', atMs: 300 }),
			store.record({ threadId: 'T-four', messageId: '4', kind: 'start', atMs: 400 }),
		]
		store.applyDeliveryResults([
			{ event_id: events[0]!.event_id, status: 'accepted' },
			{ event_id: events[1]!.event_id, status: 'duplicate' },
			{ event_id: events[2]!.event_id, status: 'conflict' },
			{ event_id: events[3]!.event_id, status: 'rejected' },
		])
		expect(store.outboxCounts()).toEqual({ pending: 0, conflict: 1, rejected: 1 })
		expect(store.pendingEvents(10)).toEqual([])
		store.close()
	})

	test('supports interleaved writes from multiple SQLite connections', () => {
		const path = databasePath()
		const first = new WorkHoursStore(path)
		const second = new WorkHoursStore(path)
		first.record({ threadId: 'T-one', messageId: '1', kind: 'start', atMs: 100 })
		second.record({ threadId: 'T-two', messageId: '2', kind: 'start', atMs: 200 })
		first.record({
			threadId: 'T-one',
			messageId: '1',
			kind: 'end',
			atMs: 300,
			status: 'done',
		})
		expect(second.events()).toHaveLength(3)
		first.close()
		second.close()
	})

	test('stores the weekday target and falls back to eight hours', () => {
		const store = new WorkHoursStore(databasePath())
		expect(store.weekdayTargetMinutes()).toBe(480)
		store.setWeekdayTargetMinutes(450)
		expect(store.weekdayTargetMinutes()).toBe(450)
		expect(() => store.setWeekdayTargetMinutes(1441)).toThrow()
		store.close()
	})

	test('restricts state directory and database permissions', () => {
		const path = databasePath()
		const directory = join(path, '..')
		chmodSync(join(directory, '..'), 0o755)
		const store = new WorkHoursStore(path)
		expect(statSync(directory).mode & 0o777).toBe(0o700)
		expect(statSync(path).mode & 0o777).toBe(0o600)
		store.close()
	})

	test('migrates legacy events deterministically and reruns without duplicate duration', () => {
		const path = databasePath()
		mkdirSync(dirname(path), { recursive: true })
		const legacy = new Database(path, { create: true })
		legacy.exec(`
			CREATE TABLE events (
				event_key TEXT PRIMARY KEY,
				thread_id TEXT NOT NULL,
				message_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				at_ms INTEGER NOT NULL,
				status TEXT
			);
			CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			INSERT INTO events VALUES
				('T-one' || char(0) || '1' || char(0) || 'start', 'T-one', '1', 'start', 100, NULL),
				('T-one' || char(0) || '1' || char(0) || 'end', 'T-one', '1', 'end', 200, 'done');
		`)
		legacy.close()

		const first = new WorkHoursStore(path)
		const migrated = first.pendingEvents(10)
		expect(migrated.map((event) => event.source_sequence)).toEqual([1, 2])
		expect(migrated.map((event) => event.event_id)).toEqual([
			expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-5/),
			expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-5/),
		])
		expect(migrated[0]?.session_id).toBe(migrated[1]?.session_id)
		expect(migrated.every((event) => event.schema_version === EVENT_SCHEMA_VERSION_V1)).toBeTrue()
		expect(migrated.every((event) => !('project_slug' in event))).toBeTrue()
		expect(migrated.every((event) => event.monotonic_duration_ms === undefined)).toBeTrue()
		first.close()

		const rerun = new WorkHoursStore(path)
		expect(rerun.pendingEvents(10)).toEqual(migrated)
		expect(rerun.events()).toHaveLength(2)
		rerun.applyDeliveryResults(
			migrated.map((event) => ({ event_id: event.event_id, status: 'accepted' as const })),
		)
		rerun.close()

		const afterAcceptance = new WorkHoursStore(path)
		expect(afterAcceptance.pendingEvents(10)).toEqual([])
		expect(afterAcceptance.events()).toHaveLength(2)
		expect(
			afterAcceptance.record({ threadId: 'T-two', messageId: '2', kind: 'start', atMs: 300 })
				?.source_sequence,
		).toBe(3)
		afterAcceptance.close()
	})

	test('migrates every existing outbox row and turn session to v1 Unassigned', () => {
		const path = databasePath()
		mkdirSync(dirname(path), { recursive: true })
		const legacy = new Database(path, { create: true })
		legacy.exec(`
			CREATE TABLE events (
				event_key TEXT PRIMARY KEY,
				thread_id TEXT NOT NULL,
				message_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				at_ms INTEGER NOT NULL,
				status TEXT
			);
			CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE outbox (
				event_id TEXT PRIMARY KEY,
				source_instance_id TEXT NOT NULL,
				source_sequence INTEGER NOT NULL,
				session_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				occurred_at TEXT NOT NULL,
				monotonic_duration_ms INTEGER,
				delivery_state TEXT NOT NULL DEFAULT 'pending',
				UNIQUE (source_instance_id, source_sequence)
			);
			CREATE TABLE legacy_migrations (
				event_key TEXT PRIMARY KEY,
				event_id TEXT NOT NULL UNIQUE,
				source_sequence INTEGER NOT NULL UNIQUE
			);
			CREATE TABLE turn_sessions (turn_key TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE);
			INSERT INTO settings VALUES
				('source-instance-id', '6a19480a-2d4d-4a29-8dbf-735f8300aba0'),
				('legacy-migration-namespace', 'b5c3a3d7-57e0-42cf-9732-59f68f31ab53'),
				('next-source-sequence', '4');
			INSERT INTO outbox VALUES
				('event-pending', '6a19480a-2d4d-4a29-8dbf-735f8300aba0', 1, 'session-pending', 'agent.start', '2026-08-30T00:00:00.000Z', NULL, 'pending'),
				('event-conflict', '6a19480a-2d4d-4a29-8dbf-735f8300aba0', 2, 'session-conflict', 'agent.start', '2026-08-30T00:01:00.000Z', NULL, 'conflict'),
				('event-rejected', '6a19480a-2d4d-4a29-8dbf-735f8300aba0', 3, 'session-rejected', 'agent.end', '2026-08-30T00:02:00.000Z', NULL, 'rejected');
			INSERT INTO turn_sessions VALUES ('T-pending' || char(0) || '1', 'session-pending');
		`)
		legacy.close()

		const upgraded = new WorkHoursStore(path)
		expect(upgraded.pendingEvents(10)).toEqual([
			expect.objectContaining({
				event_id: 'event-pending',
				schema_version: EVENT_SCHEMA_VERSION_V1,
			}),
		])
		const database = new Database(path)
		expect(
			database
				.query<{ schema: number; slug: string | null }, []>(
					'SELECT schema_version AS schema, project_slug AS slug FROM outbox ORDER BY source_sequence',
				)
				.all(),
		).toEqual([
			{ schema: EVENT_SCHEMA_VERSION_V1, slug: null },
			{ schema: EVENT_SCHEMA_VERSION_V1, slug: null },
			{ schema: EVENT_SCHEMA_VERSION_V1, slug: null },
		])
		expect(
			database
				.query<{ schema: number; slug: string | null }, []>(
					'SELECT schema_version AS schema, project_slug AS slug FROM turn_sessions',
				)
				.get(),
		).toEqual({ schema: EVENT_SCHEMA_VERSION_V1, slug: null })
		expect(
			database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
		).toBe(2)
		database.close()
		upgraded.close()
	})

	test('refuses a future schema without lowering its version or creating current tables', () => {
		const path = databasePath()
		mkdirSync(dirname(path), { recursive: true })
		const future = new Database(path, { create: true })
		future.exec('CREATE TABLE future_state (value TEXT); PRAGMA user_version = 3;')
		future.close()

		expect(() => new WorkHoursStore(path)).toThrow(
			'Plugin database schema version 3 is newer than supported version 2',
		)

		const unchanged = new Database(path)
		expect(
			unchanged.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
		).toBe(3)
		expect(
			unchanged
				.query<{ count: number }, []>(
					"SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'events'",
				)
				.get()?.count,
		).toBe(0)
		unchanged.close()
	})
})
