import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createLocalStack } from './fixture.ts'

test('plugin migrates and converges delayed legacy evidence through the service contract', async () => {
	const nowMs = Date.parse('2026-08-31T05:00:00.000Z')
	const startedAtMs = nowMs - 24 * 60 * 60 * 1_000
	const stack = createLocalStack({
		nowMs,
		seedPluginDatabase(pluginPath) {
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
		},
	})
	const { pluginStore, serviceStore, sync } = stack

	try {
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
	} finally {
		await stack.close()
	}
})

test('the local stack needs no ambient credential, token file, or service URL', async () => {
	const removed = ['CUKUP_TOKEN_FILE', 'CUKUP_SERVICE_URL', 'CUKUP_DATABASE_PATH'] as const
	const previous = new Map(removed.map((name) => [name, process.env[name]]))
	for (const name of removed) delete process.env[name]

	const stack = createLocalStack()
	try {
		expect(stack.token).toMatch(/^cukup_v1_/)
		expect(stack.pluginPath.startsWith(stack.directory)).toBe(true)
		expect(stack.servicePath.startsWith(stack.directory)).toBe(true)
		expect((await stack.client.fetchSummary(stack.token)).schema_version).toBe(1)
		await expect(stack.client.fetchSummary('an-unverifiable-workload-jwt')).rejects.toThrow(
			'Cukup authentication was rejected.',
		)
	} finally {
		await stack.close()
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
	}
})
