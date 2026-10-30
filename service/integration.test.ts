import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { readWorkHoursStatus } from '../plugin/status.ts'
import { createLocalStack } from './fixture.ts'

test('status reads service totals without delivering pending local evidence', async () => {
	const stack = createLocalStack()
	const { pluginStore, serviceStore, client, sync, nowMs } = stack
	try {
		const principal = serviceStore.authenticateBearer(stack.token)!
		if (principal.kind !== 'bearer') throw new Error('Expected a fixture bearer')
		serviceStore.bindExecutorLabel(principal.tokenId, 'synthetic-machine')
		for (const [index, [projectSlug, start, end]] of ([
			['bta', 180, 150], ['bta-notes', 165, 135], ['cukup', 150, 90], [null, 45, 30],
		] as const).entries()) {
			const messageId = String(index)
			pluginStore.record(
				{ threadId: 'T-synthetic', messageId, kind: 'start', atMs: nowMs - start * 60_000 },
				undefined,
				projectSlug === null ? { schemaVersion: 1, projectSlug: null } : { schemaVersion: 2, projectSlug },
			)
			pluginStore.recordEndIfStarted({ threadId: 'T-synthetic', messageId, kind: 'end', status: 'done', atMs: nowMs - end * 60_000 })
		}
		await sync.runNow()
		pluginStore.record({ threadId: 'T-synthetic', messageId: 'pending', kind: 'start', atMs: nowMs - 20 * 60_000 }, undefined, { schemaVersion: 2, projectSlug: 'bta' })
		pluginStore.recordEndIfStarted({ threadId: 'T-synthetic', messageId: 'pending', kind: 'end', status: 'done', atMs: nowMs - 5 * 60_000 })
		const pluginDatabase = new Database(stack.pluginPath, { readonly: true })
		const serviceDatabase = new Database(stack.servicePath, { readonly: true })
		try {
			const pluginBefore = pluginDatabase.serialize()
			const serviceBefore = serviceDatabase.serialize()
			for (const track of ['work', 'play', 'all'] as const) {
				const text = await readWorkHoursStatus({
					client, track,
					tokenProvider: { getToken: async () => stack.token },
					store: pluginStore,
					trackingGap: () => sync.trackingGap(),
					now: () => nowMs,
				})
				expect(text).toStartWith('AUTHORITATIVE')
				expect(text).toContain(`Track: ${track}`)
				if (track === 'work') {
					expect(text).toContain('Today: UNDER · 1h 00m / 8h 00m · 7h 00m remaining')
					expect(text).toContain('Week: UNDER · 1h 00m / 40h 00m · 39h 00m remaining')
				} else if (track === 'play') {
					expect(text).toContain('Today: TOLERANCE · 1h 45m · soft limit 1h 00m · upper limit 2h 00m · 45m above soft limit')
					expect(text).toContain('Week: WITHIN · 1h 45m · soft limit 7h 00m · upper limit 14h 00m · 5h 15m below soft limit')
				} else {
					expect(text).toContain('Today: WITHIN · 2h 15m · soft limit 9h 00m · upper limit 10h 00m')
					expect(text).toContain('Week: WITHIN · 2h 15m · soft limit 47h 00m · upper limit 54h 00m · 44h 45m below soft limit')
				}
				expect(text).toContain('pending 2')
			}
			expect(serviceStore.events()).toHaveLength(8)
			expect((await client.fetchSummary(stack.token)).daily).toEqual({ status: 'UNDER', worked_minutes: 135, target_minutes: 480, difference_minutes: 345 })
			expect(pluginDatabase.serialize()).toEqual(pluginBefore)
			expect(serviceDatabase.serialize()).toEqual(serviceBefore)
		} finally {
			pluginDatabase.close()
			serviceDatabase.close()
		}
	} finally {
		await stack.close()
	}
})

test('track status preserves weekend goals and exact-date overrides', async () => {
	for (const [date, override, workGoal, allLimit, workWeekGoal, allWeekLimit] of [
		['2026-08-30', undefined, 0, 60, 2_400, 2_820],
		['2026-08-31', 240, 240, 300, 2_160, 2_580],
	] as const) {
		const stack = createLocalStack({ nowMs: Date.parse(`${date}T05:00:00.000Z`) })
		try {
			if (override !== undefined) stack.serviceStore.putTargetOverride(date, override, stack.nowMs)
			for (const track of ['work', 'play', 'all'] as const) {
				const summary = await stack.client.fetchTrackSummary(stack.token, track)
				expect(summary.daily.target_minutes).toBe(track === 'work' ? workGoal : track === 'play' ? 60 : allLimit)
				expect(summary.weekly.target_minutes).toBe(track === 'work' ? workWeekGoal : track === 'play' ? 420 : allWeekLimit)
			}
			const text = await readWorkHoursStatus({
				client: stack.client, tokenProvider: { getToken: async () => stack.token },
				store: stack.pluginStore, trackingGap: () => undefined, now: () => stack.nowMs,
			})
			expect(text).toContain(workGoal === 0 ? 'Today: NO SCHEDULED GOAL · 0m unplanned Work' : 'Today: UNDER · 0m / 4h 00m · 4h 00m remaining')
		} finally {
			await stack.close()
		}
	}
})

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

	try {
		const stack = createLocalStack()
		try {
			expect(stack.token).toMatch(/^cukup_v1_/)
			expect(stack.pluginPath.startsWith(stack.directory)).toBe(true)
			expect(stack.servicePath.startsWith(stack.directory)).toBe(true)
			expect(await stack.sync.runNow()).toEqual({ authoritativeSummary: true })
			await expect(stack.client.fetchSummary('header.payload.signature')).rejects.toThrow(
				'Cukup authentication was rejected.',
			)
		} finally {
			await stack.close()
		}
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
	}
})

test('the local stack removes temporary state when setup fails', () => {
	let directory: string | undefined

	expect(() =>
		createLocalStack({
			seedPluginDatabase(pluginPath) {
				directory = pluginPath.replace(/\/plugin\/state\.sqlite$/, '')
				throw new Error('seed failed')
			},
		}),
	).toThrow('seed failed')

	expect(directory).toBeDefined()
	expect(existsSync(directory!)).toBe(false)
})
