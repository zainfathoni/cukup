import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
		database.close()
		store.close()
		const reopened = new WorkHoursStore(path)
		expect(reopened.trackingIncomplete()).toBeTrue()
		reopened.close()
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
})
