import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
