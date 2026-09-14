import { describe, expect, test } from 'bun:test'
import { SUMMARY_SCHEMA_VERSION, type AuthoritativeSummary } from './protocol.ts'
import { formatStatusDisplay } from './status.ts'

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
