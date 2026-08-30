import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TokenProviderError, type TokenProvider } from './auth.ts'
import {
	CukupServiceClient,
	PROTOCOL_SCHEMA_VERSION,
	type AuthoritativeSummary,
	type Fetcher,
} from './protocol.ts'
import { WorkHoursStore } from './store.ts'
import { RETRY_MAX_MS, SyncEngine, retryDelay } from './sync.ts'

const temporaryDirectories: string[] = []
const nowMs = Date.parse('2026-08-30T05:00:00.000Z')
const token = 'sync-test-token-abcdefghijklmnopqrstuvwxyz'

function databasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), 'cukup-sync-test-'))
	temporaryDirectories.push(directory)
	return join(directory, 'state.sqlite')
}

function summary(): AuthoritativeSummary {
	return {
		schema_version: PROTOCOL_SCHEMA_VERSION,
		as_of: new Date(nowMs).toISOString(),
		daily: { status: 'UNDER', worked_minutes: 60, target_minutes: 480, difference_minutes: 420 },
		weekly: { status: 'UNDER', worked_minutes: 60, target_minutes: 2_400, difference_minutes: 2_340 },
	}
}

function provider(getToken: () => string | Promise<string> = () => token): TokenProvider {
	return { async getToken() { return getToken() } }
}

function client(fetcher: Fetcher): CukupServiceClient {
	return new CukupServiceClient('https://cukup.dev', fetcher, () => nowMs)
}

function record(store: WorkHoursStore, number: number) {
	return store.record({
		threadId: `T-${number}`,
		messageId: String(number),
		kind: 'start',
		atMs: nowMs + number,
	})!
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

describe('SyncEngine', () => {
	test('uploads in source order and applies mixed partial success without deleting conflicts', async () => {
		const store = new WorkHoursStore(databasePath())
		const events = [record(store, 1), record(store, 2), record(store, 3)]
		let uploadedSequences: number[] = []
		const fetcher: Fetcher = async (url, init) => {
			if (url.endsWith('/v1/time')) return Response.json({ server_time: new Date(nowMs).toISOString() })
			if (url.endsWith('/v1/events:batch')) {
				const body = JSON.parse(String(init.body))
				uploadedSequences = body.events.map((event: { source_sequence: number }) => event.source_sequence)
				return Response.json({
					results: [
						{ event_id: events[0]!.event_id, status: 'accepted' },
						{ event_id: events[1]!.event_id, status: 'conflict', code: 'SEQUENCE_CONFLICT' },
						{ event_id: events[2]!.event_id, status: 'rejected', code: 'CLOCK_SKEW' },
					],
				})
			}
			return Response.json(summary())
		}
		const engine = new SyncEngine({ store, client: client(fetcher), tokenProvider: provider(), now: () => nowMs })
		expect(await engine.runNow()).toEqual({ authoritativeSummary: true })
		expect(uploadedSequences).toEqual([...uploadedSequences].sort((left, right) => left - right))
		expect(store.outboxCounts()).toEqual({ pending: 0, conflict: 1, rejected: 1 })
		expect(store.cachedSummary()?.summary).toEqual(summary())
		await engine.dispose()
		store.close()
	})

	test('deletes reported successes but retries records omitted by a partial response', async () => {
		const store = new WorkHoursStore(databasePath())
		const first = record(store, 1)
		record(store, 2)
		const fetcher: Fetcher = async (url) => {
			if (url.endsWith('/v1/time')) return Response.json({ server_time: new Date(nowMs).toISOString() })
			return Response.json({ results: [{ event_id: first.event_id, status: 'accepted' }] })
		}
		const engine = new SyncEngine({ store, client: client(fetcher), tokenProvider: provider(), now: () => nowMs })
		expect(await engine.runNow()).toEqual({ authoritativeSummary: false, errorKind: 'partial-response' })
		expect(store.outboxCounts().pending).toBe(1)
		expect(store.pendingEvents(10)[0]?.source_sequence).toBe(first.source_sequence + 1)
		await engine.dispose()
		store.close()
	})

	test('persists bounded jittered backoff and resumes it after restart', async () => {
		const path = databasePath()
		const store = new WorkHoursStore(path)
		record(store, 1)
		const delays: number[] = []
		const timer = { unref() {} } as ReturnType<typeof setTimeout>
		const fetcher: Fetcher = async () => { throw new Error('offline') }
		const engine = new SyncEngine({
			store,
			client: client(fetcher),
			tokenProvider: provider(),
			now: () => nowMs,
			random: () => 0,
			setTimer: (_callback, delay) => { delays.push(delay); return timer },
			clearTimer() {},
		})
		expect(await engine.runNow()).toEqual({ authoritativeSummary: false, errorKind: 'network' })
		expect(delays).toEqual([800])
		expect(store.syncState().nextAttemptAtMs).toBe(nowMs + 800)
		await engine.dispose()
		store.close()

		const reopened = new WorkHoursStore(path)
		const restartDelays: number[] = []
		const restarted = new SyncEngine({
			store: reopened,
			client: client(fetcher),
			tokenProvider: provider(),
			now: () => nowMs,
			setTimer: (_callback, delay) => { restartDelays.push(delay); return timer },
			clearTimer() {},
		})
		restarted.start()
		expect(restartDelays).toEqual([800])
		for (let attempt = 1; attempt <= 40; attempt += 1) {
			expect(retryDelay(attempt, 1)).toBeLessThanOrEqual(RETRY_MAX_MS)
		}
		await restarted.dispose()
		reopened.close()
	})

	test('converges offline outbox rows exactly once after the network returns', async () => {
		const store = new WorkHoursStore(databasePath())
		const events = [record(store, 1), record(store, 2)]
		let online = false
		const received = new Set<string>()
		const fetcher: Fetcher = async (url, init) => {
			if (!online) throw new Error('offline')
			if (url.endsWith('/v1/time')) return Response.json({ server_time: new Date(nowMs).toISOString() })
			if (url.endsWith('/v1/events:batch')) {
				const body = JSON.parse(String(init.body))
				return Response.json({
					results: body.events.map((event: { event_id: string }) => {
						const status = received.has(event.event_id) ? 'duplicate' : 'accepted'
						received.add(event.event_id)
						return { event_id: event.event_id, status }
					}),
				})
			}
			return Response.json(summary())
		}
		const engine = new SyncEngine({ store, client: client(fetcher), tokenProvider: provider(), now: () => nowMs })
		expect((await engine.runNow()).errorKind).toBe('network')
		expect(store.outboxCounts().pending).toBe(2)
		online = true
		expect(await engine.runNow()).toEqual({ authoritativeSummary: true })
		expect(store.outboxCounts().pending).toBe(0)
		expect([...received].sort()).toEqual(events.map((event) => event.event_id).sort())
		await engine.dispose()
		store.close()
	})

	test('retains events and surfaces auth revocation until a rotated token is supplied', async () => {
		const path = databasePath()
		const store = new WorkHoursStore(path)
		const event = record(store, 1)
		let currentToken = 'revoked-token-abcdefghijklmnopqrstuvwxyz'
		let providerCalls = 0
		const fetcher: Fetcher = async (url, init) => {
			const requestToken = new Headers(init.headers).get('authorization')
			if (requestToken?.includes('revoked-token')) return new Response(null, { status: 401 })
			if (url.endsWith('/v1/time')) return Response.json({ server_time: new Date(nowMs).toISOString() })
			if (url.endsWith('/v1/events:batch')) {
				return Response.json({ results: [{ event_id: event.event_id, status: 'accepted' }] })
			}
			return Response.json(summary())
		}
		const engine = new SyncEngine({
			store,
			client: client(fetcher),
			tokenProvider: provider(() => { providerCalls += 1; return currentToken }),
			now: () => nowMs,
		})
		expect(await engine.runNow()).toEqual({ authoritativeSummary: false, errorKind: 'authentication' })
		expect(store.outboxCounts().pending).toBe(1)
		expect(store.syncState().nextAttemptAtMs).toBeNull()
		currentToken = 'rotated-token-abcdefghijklmnopqrstuvwxyz'
		expect(await engine.runNow()).toEqual({ authoritativeSummary: true })
		expect(store.outboxCounts().pending).toBe(0)
		expect(providerCalls).toBe(2)
		await engine.dispose()
		store.close()
		const persistedBytes = readFileSync(path).toString('utf8')
		expect(persistedBytes).not.toContain('revoked-token')
		expect(persistedBytes).not.toContain('rotated-token')
	})

	test('keeps skewed events pending, caches summary, and visibly records the skew warning', async () => {
		const store = new WorkHoursStore(databasePath())
		record(store, 1)
		let batchRequests = 0
		const fetcher: Fetcher = async (url) => {
			if (url.endsWith('/v1/time')) {
				return Response.json({ server_time: new Date(nowMs + 11 * 60_000).toISOString() })
			}
			if (url.endsWith('/v1/events:batch')) batchRequests += 1
			return Response.json(summary())
		}
		const engine = new SyncEngine({ store, client: client(fetcher), tokenProvider: provider(), now: () => nowMs })
		expect(await engine.runNow()).toEqual({ authoritativeSummary: true, errorKind: 'clock-skew' })
		expect(batchRequests).toBe(0)
		expect(store.outboxCounts().pending).toBe(1)
		expect(store.syncState().clock?.offsetMs).toBe(11 * 60_000)
		expect(store.syncState().lastErrorKind).toBe('clock-skew')
		expect(store.cachedSummary()?.summary).toEqual(summary())
		await engine.dispose()
		store.close()
	})

	test('makes OIDC mint failure visible while preserving pending rows', async () => {
		const store = new WorkHoursStore(databasePath())
		record(store, 1)
		const engine = new SyncEngine({
			store,
			client: client(async () => Response.json({})),
			tokenProvider: provider(() => { throw new TokenProviderError('mint-failed') }),
			now: () => nowMs,
		})
		expect(await engine.runNow()).toEqual({
			authoritativeSummary: false,
			errorKind: 'authentication-mint-failed',
		})
		expect(store.outboxCounts().pending).toBe(1)
		expect(store.syncState().lastErrorKind).toBe('authentication-mint-failed')
		await engine.dispose()
		store.close()
	})
})
