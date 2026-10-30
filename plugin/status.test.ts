import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TokenProviderError } from './auth.ts'
import { CukupServiceClient, SUMMARY_SCHEMA_VERSION, type AuthoritativeSummary, type TrackSummary } from './protocol.ts'
import { formatStatusDisplay, readWorkHoursStatus } from './status.ts'
import { WorkHoursStore } from './store.ts'

const asOf = '2026-08-30T05:00:00.000Z'
const nowMs = Date.parse('2026-08-30T06:30:00.000Z')
const counts = { pending: 2, conflict: 0, rejected: 0 }
const syncState = {
	attemptCount: 0,
	nextAttemptAtMs: null,
	lastErrorKind: null,
	lastErrorAtMs: null,
	clock: null,
}

function summary(status: 'UNDER' | 'COMPLETE' | 'OVER'): AuthoritativeSummary {
	const values = {
		UNDER: { worked_minutes: 300, target_minutes: 480, difference_minutes: 180 },
		COMPLETE: { worked_minutes: 480, target_minutes: 480, difference_minutes: 0 },
		OVER: { worked_minutes: 540, target_minutes: 480, difference_minutes: 60 },
	}[status]
	return {
		schema_version: SUMMARY_SCHEMA_VERSION,
		as_of: asOf,
		daily: { status, ...values },
		weekly: { status, ...values },
	}
}

describe('status display', () => {
	test('reads only the summary and preserves all state on success and failure', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'cukup-status-read-'))
		const path = join(directory, 'state.sqlite')
		const store = new WorkHoursStore(path)
		const database = new Database(path, { readonly: true })
		const token = 'synthetic-status-credential-not-a-real-token'
		try {
			for (let i = 0; i < 3; i++) {
				const event = store.record({ threadId: 'T-synthetic', messageId: String(i), kind: 'start', atMs: nowMs + i })!
				if (i > 0) store.applyDeliveryResults([{ event_id: event.event_id, status: i === 1 ? 'conflict' : 'rejected' }])
			}
			store.markTrackingIncomplete('event-recording', nowMs - 1_000)
			store.recordSyncFailure('network', 3, nowMs + 60_000, nowMs)
			store.setWeekdayTargetMinutes(420)
			store.cacheSummary({ ...summary('COMPLETE'), weekly: summary('OVER').weekly }, nowMs - 60_000)
			const before = database.serialize()
			const fresh: TrackSummary = {
				...summary('UNDER'),
				track: 'work',
				timezone: 'Asia/Jakarta',
				as_of: '2026-08-30T17:00:00.000Z',
				weekly: { status: 'OVER', worked_minutes: 2_550, target_minutes: 2_400, difference_minutes: 150 },
			}
			const requests: Array<{ url: string; method?: string; body: unknown }> = []
			let response = () => Response.json(fresh)
			const client = new CukupServiceClient('https://cukup.example', async (url, init) => {
				requests.push({ url, method: init.method, body: init.body })
				expect(new Headers(init.headers).get('authorization') === `Bearer ${token}`).toBeTrue()
				return response()
			})
			const input = { client, tokenProvider: { getToken: async () => token }, store, trackingGap: () => store.trackingGap(), now: () => Date.parse(fresh.as_of) + 60_000 }
			const text = await readWorkHoursStatus(input)
			expect(text).toStartWith('AUTHORITATIVE · HISTORICAL TRACKING GAP')
			expect(text).toContain('as_of 2026-08-30T17:00:00.000Z · age 1m')
			expect(text).toContain('Today: UNDER · 5h 00m / 8h 00m · 3h 00m remaining')
			expect(text).toContain('Week: GOAL MET · 42h 30m / 40h 00m')
			expect(text).toContain('pending 1 · CONFLICTS 1 · REJECTIONS 1')
			expect(text).toContain('missing evidence will not be recovered')
			expect(text).toContain('daily 2026-08-31; weekly 2026-08-31 through 2026-09-06')
			expect(text).toContain('not measured human attention')
			expect(text).toContain('Track: work')
			expect(text).toContain('No local estimate is added')
			expect(text).not.toContain(token)
			expect(database.serialize()).toEqual(before)

			for (const fail of [
				() => new Response(token, { status: 401 }),
				() => new Response(token, { status: 503 }),
				() => Response.json({ secret: token }),
				() => Response.json(summary('COMPLETE')),
				() => { throw new Error(token) },
			]) {
				response = fail
				const stale = await readWorkHoursStatus(input)
				expect(stale).toStartWith('UNKNOWN · work status unavailable')
				expect(stale).toContain('STALE · LEGACY GLOBAL ACTIVITY ONLY · HISTORICAL TRACKING GAP')
				expect(stale).toContain(`as_of ${asOf}`)
				expect(stale).toContain('Cached global daily activity: 8h 00m')
				expect(stale).toContain('Cached global weekly activity: 9h 00m')
				expect(stale).toContain('Requested track: work')
				expect(stale).toContain('Cached global snapshot scope: daily')
				expect(stale).toContain('pending 1 · CONFLICTS 1 · REJECTIONS 1')
				expect(stale).toContain('missing evidence will not be recovered')
				for (const misleading of ['Today:', 'Week:', 'COMPLETE', 'OVER', 'remaining', ' / ']) {
					expect(stale).not.toContain(misleading)
				}
				expect(stale).toContain('daily 2026-08-30; weekly 2026-08-24 through 2026-08-30')
				expect(stale).not.toContain(token)
				expect(database.serialize()).toEqual(before)
			}
			expect(requests).toEqual(Array(6).fill({ url: 'https://cukup.example/v1/summary?track=work', method: 'GET', body: undefined }))
			for (const kind of ['missing', 'unsafe', 'mint-failed'] as const) {
				const stale = await readWorkHoursStatus({ ...input, tokenProvider: { getToken: async () => { throw new TokenProviderError(kind) } } })
				expect(stale).toStartWith('UNKNOWN · work status unavailable')
				expect(database.serialize()).toEqual(before)
			}
			expect(requests).toHaveLength(6)
		} finally {
			database.close()
			store.close()
			rmSync(directory, { recursive: true, force: true })
		}
	})

	test('reports unknown instead of zero or local estimates when data is unavailable', async () => {
		const input = {
			tokenProvider: { getToken: async () => { throw new Error('must not request credentials') } },
			store: { cachedSummary: () => undefined, outboxCounts: () => counts, syncState: () => syncState },
			trackingGap: () => undefined,
			now: () => nowMs,
		}
		const unknown = await readWorkHoursStatus(input)
		expect(unknown).toStartWith('UNKNOWN · work status unavailable')
		expect(unknown).toContain('UNKNOWN · no authoritative summary')
		expect(unknown).toContain('Asia/Jakarta')
		expect(unknown).not.toContain('Today:')
		expect(unknown).not.toContain('Local fallback')
		const failed = await readWorkHoursStatus({ ...input, store: { ...input.store, outboxCounts: () => { throw new Error('private local path') } } })
		expect(failed).toStartWith('UNKNOWN · local diagnostics are unavailable')
		expect(failed).not.toContain('private local path')
	})

	test('renders authoritative and stale daily/weekly UNDER, COMPLETE, and OVER results', () => {
		for (const authoritative of [true, false]) {
			for (const status of ['UNDER', 'COMPLETE', 'OVER'] as const) {
				const text = formatStatusDisplay({
					cache: { summary: summary(status), fetchedAtMs: nowMs },
					authoritative,
					counts,
					syncState,
					nowMs,
				})
				const freshness = authoritative ? 'AUTHORITATIVE' : 'STALE'
				expect(text).toStartWith(`${freshness} · as_of ${asOf} · age 1h 30m · pending 2`)
				expect(text).toContain(`Today: ${status}`)
				expect(text).toContain(`Week: ${status}`)
			}
		}
	})

	test('marks an offline cached summary stale and surfaces conflicts and rejections', () => {
		const text = formatStatusDisplay({
			cache: { summary: summary('UNDER'), fetchedAtMs: nowMs - 60_000 },
			authoritative: false,
			counts: { pending: 3, conflict: 1, rejected: 2 },
			syncState: { ...syncState, lastErrorKind: 'network' },
			nowMs,
		})
		expect(text).toStartWith('STALE ·')
		expect(text).toContain('pending 3 · CONFLICTS 1 · REJECTIONS 2 · sync OFFLINE')
	})

	test('separates a historical evidence gap from a healthy authoritative sync', () => {
		const text = formatStatusDisplay({
			cache: { summary: summary('COMPLETE'), fetchedAtMs: nowMs },
			authoritative: true,
			trackingGap: {
				firstObservedAtMs: null,
				lastObservedAtMs: null,
				reasons: ['legacy-unknown'],
			},
			counts,
			syncState,
			nowMs,
		})
		expect(text).toStartWith('AUTHORITATIVE · HISTORICAL TRACKING GAP')
		expect(text).toContain(`as_of ${asOf}`)
		expect(text).toContain('reason unknown legacy cause')
		expect(text).toContain('missing evidence will not be recovered')
	})

	test('keeps a current local-state failure unknown', () => {
		const text = formatStatusDisplay({
			cache: { summary: summary('COMPLETE'), fetchedAtMs: nowMs },
			authoritative: false,
			trackingGap: {
				firstObservedAtMs: nowMs,
				lastObservedAtMs: nowMs,
				reasons: ['sync-local-state'],
			},
			counts,
			syncState,
			nowMs,
			transientErrorKind: 'local-state',
		})
		expect(text).toStartWith('UNKNOWN · TRACKING INCOMPLETE')
		expect(text).toContain(new Date(nowMs).toISOString())
	})

	test('makes missing and unsafe physical credentials actionable without exposing a token', () => {
		for (const [kind, label] of [
			['authentication-missing', 'CREDENTIAL FILE MISSING'],
			['authentication-unsafe', 'CREDENTIAL FILE PERMISSIONS UNSAFE'],
		] as const) {
			const text = formatStatusDisplay({
				authoritative: false,
				counts,
				syncState,
				nowMs,
				transientErrorKind: kind,
			})
			expect(text).toContain(`sync ${label}`)
		}
	})
})
