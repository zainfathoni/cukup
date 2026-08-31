import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CukupServiceClient } from '../plugin/protocol.ts'
import { WorkHoursStore } from '../plugin/store.ts'
import { SyncEngine } from '../plugin/sync.ts'
import { createApp } from './app.ts'
import { ServiceLogger } from './logger.ts'
import { ServiceStore } from './store.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

test('plugin migrates and converges delayed legacy evidence through the service contract', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'cukup-integration-'))
	temporaryDirectories.push(directory)
	const pluginPath = join(directory, 'plugin', 'state.sqlite')
	const servicePath = join(directory, 'service', 'state.sqlite')
	mkdirSync(dirname(pluginPath), { recursive: true })

	const nowMs = Date.parse('2026-08-31T05:00:00.000Z')
	const startedAtMs = nowMs - 24 * 60 * 60 * 1_000
	const legacy = new Database(pluginPath, { create: true })
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
	`)
	legacy
		.query('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)')
		.run('legacy-start', 'T-private', 'M-private', 'start', startedAtMs, null)
	legacy
		.query('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)')
		.run('legacy-end', 'T-private', 'M-private', 'end', startedAtMs + 30 * 60_000, 'done')
	legacy.close()

	const pluginStore = new WorkHoursStore(pluginPath)
	const serviceStore = new ServiceStore(servicePath)
	const issued = serviceStore.issueBearer(nowMs)
	const app = createApp({
		store: serviceStore,
		oidcVerifier: { verify: async () => false },
		now: () => nowMs,
		logger: new ServiceLogger(() => {}),
	})
	const client = new CukupServiceClient(
		'https://api.cukup.dev',
		(input, init) => app.fetch(new Request(input, init)),
		() => nowMs,
	)
	const sync = new SyncEngine({
		store: pluginStore,
		client,
		tokenProvider: { getToken: async () => issued.token },
		now: () => nowMs,
	})

	expect(pluginStore.pendingEvents(10)).toEqual([
		expect.objectContaining({
			event_id: expect.stringMatching(/^[0-9a-f-]{14}5/),
			session_id: expect.stringMatching(/^[0-9a-f-]{14}5/),
		}),
		expect.objectContaining({
			event_id: expect.stringMatching(/^[0-9a-f-]{14}5/),
			session_id: expect.stringMatching(/^[0-9a-f-]{14}5/),
		}),
	])
	expect(await sync.runNow()).toEqual({ authoritativeSummary: true })
	expect(pluginStore.outboxCounts()).toEqual({ pending: 0, conflict: 0, rejected: 0 })
	expect(serviceStore.events()).toHaveLength(2)
	expect(pluginStore.cachedSummary()?.summary.as_of).toBe('2026-08-31T05:00:00.000Z')

	expect(await sync.runNow()).toEqual({ authoritativeSummary: true })
	expect(serviceStore.events()).toHaveLength(2)

	await sync.dispose()
	pluginStore.close()
	serviceStore.close()
})
