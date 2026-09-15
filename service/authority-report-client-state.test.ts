import { describe, expect, test } from 'bun:test'
import {
	beginAuthorityReportRead,
	createAuthorityReportClientState,
	createAuthorityReportSessionEpoch,
	hideAuthorityReportClient,
	replaceAuthorityReportSession,
	settleAuthorityReportRead,
	type AuthorityReportClientState,
	type AuthorityReportRequestIdentity,
	type AuthorityReportSnapshotSlot,
} from './authority-report-client-state.ts'
import { AUTHORITY_REPORT_RESPONSE_MAX_BYTES, type AuthorityRange } from './authority-report-codec.ts'

const encoder = new TextEncoder()
const rangeA: AuthorityRange = {
	start: '2026-09-20T16:00:00.000Z',
	end: '2026-09-20T17:00:00.000Z',
}
const rangeB: AuthorityRange = {
	start: '2026-09-20T17:00:00.000Z',
	end: '2026-09-20T18:00:00.000Z',
}

function bytes(value: unknown): Uint8Array {
	return encoder.encode(typeof value === 'string' ? value : JSON.stringify(value))
}

function snapshot(range: AuthorityRange, observed = 11, label = 'Executor 1'): Record<string, unknown> {
	return {
		transport_version: 1,
		validity: { current_use: 'forbidden', valid_until: null, proof: null },
		report: {
			contract_version: 1,
			timezone: 'Asia/Jakarta',
			range,
			as_of: range.end,
			authority: 'verified',
			cutover: null,
			delivery: 'snapshot',
			reason: 'refresh_required',
			sections: [{
				authority: 'legacy',
				range,
				working_time: {
					metric: 'legacy_working_time', state: 'stale', reason: 'refresh_required',
					data: { observed_minutes: observed, target: 'none' },
				},
			}],
		},
		label,
	}
}

function validSnapshot(range: AuthorityRange, observed = 11): Record<string, unknown> {
	const value = snapshot(range, observed)
	delete value.label
	return value
}

function genericSnapshot(observed = 17, label = 'Executor 7'): Record<string, unknown> {
	return {
		transport_version: 1,
		validity: { current_use: 'forbidden', valid_until: null, proof: null },
		report: {
			contract_version: 1,
			timezone: 'Asia/Jakarta',
			range: rangeB,
			as_of: rangeB.end,
			authority: 'verified',
			cutover: rangeB.start,
			delivery: 'snapshot',
			reason: 'refresh_required',
			sections: [{
				authority: 'generic',
				range: rangeB,
				working_time: {
					metric: 'working_time_estimated', state: 'stale', reason: 'refresh_required',
					data: { observed_minutes: observed, target: 'none' },
				},
				agent_runtime: {
					metric: 'agent_runtime', state: 'stale', reason: 'refresh_required',
					data: { observed_minutes: 9, target: 'none' },
				},
				disclosures: {
					state: 'stale',
					reason: 'refresh_required',
					data: {
						start: rangeB.start,
						end: rangeB.end,
						lanes: [{
							label,
							capability_intervals: [{
								start: rangeB.start,
								end: rangeB.end,
								working_time_v1: { status: 'unknown' },
								agent_runtime_v1: { status: 'unknown' },
							}],
							known_losses: [],
							pending_execution: { status: 'none_pending', started_at: [] },
							synchronization: 'unknown',
						}],
					},
				},
			}],
		},
	}
}

function refusal(range: AuthorityRange): Record<string, unknown> {
	return {
		transport_version: 1,
		validity: { current_use: 'forbidden', valid_until: null, proof: null },
		report: {
			contract_version: 1,
			timezone: 'Asia/Jakarta',
			range,
			as_of: null,
			authority: 'unresolved',
			cutover: null,
			delivery: 'unavailable',
			reason: 'authority_unavailable',
			sections: [],
		},
	}
}

function begin(state: AuthorityReportClientState, range: AuthorityRange) {
	const result = beginAuthorityReportRead(state, range)
	if (!result.ok) throw new Error(`begin failed: ${result.error}`)
	return result
}

function install(state: AuthorityReportClientState, range: AuthorityRange, observed = 11) {
	const started = begin(state, range)
	const settled = settleAuthorityReportRead(started.state, started.request.identity, {
		type: 'response', status: 200, bytes: bytes(validSnapshot(range, observed)),
	})
	expect(settled.result).toBe('snapshot_installed')
	return settled.state
}

function observed(state: AuthorityReportClientState): number | undefined {
	const response = state.snapshot?.response as any
	return response?.report.sections[0]?.working_time.data?.observed_minutes
}

describe('authority-report client generation and session fences', () => {
	test('ignores older same-range generation while the newer request remains active', () => {
		const session = createAuthorityReportSessionEpoch()
		const first = begin(createAuthorityReportClientState(session), rangeA)
		const second = begin(first.state, rangeA)

		for (const settlement of [
			{ type: 'response' as const, status: 200 as const, bytes: bytes(validSnapshot(rangeA, 90)) },
			{ type: 'failure' as const, category: 'transport_failure' as const },
		]) {
			const stale = settleAuthorityReportRead(second.state, first.request.identity, settlement)
			expect(stale.result).toBe('ignored')
			expect(stale.state).toBe(second.state)
			expect(stale.state.activeRequest).toBe(second.request.identity)
		}

		const latest = settleAuthorityReportRead(second.state, second.request.identity, {
			type: 'response', status: 200, bytes: bytes(validSnapshot(rangeA, 31)),
		})
		expect(latest.result).toBe('snapshot_installed')
		expect(observed(latest.state)).toBe(31)
	})

	test('ignores out-of-order A after B and returns A for caller cancellation', () => {
		const session = createAuthorityReportSessionEpoch()
		const first = begin(createAuthorityReportClientState(session), rangeA)
		const second = begin(first.state, rangeB)
		expect(second.superseded).toBe(first.request.identity)

		const b = settleAuthorityReportRead(second.state, second.request.identity, {
			type: 'response', status: 200, bytes: bytes(validSnapshot(rangeB, 30)),
		})
		const lateA = settleAuthorityReportRead(b.state, first.request.identity, {
			type: 'response', status: 200, bytes: bytes(validSnapshot(rangeA, 99)),
		})
		expect(lateA.result).toBe('ignored')
		expect(observed(lateA.state)).toBe(30)
	})

	test('rejects same generation with a different range or session', () => {
		const session = createAuthorityReportSessionEpoch()
		const started = begin(createAuthorityReportClientState(session), rangeA)
		const otherRange = Object.freeze({ ...started.request.identity, range: rangeB })
		const otherSession = Object.freeze({
			...started.request.identity,
			sessionEpoch: createAuthorityReportSessionEpoch(),
		})
		for (const identity of [otherRange, otherSession]) {
			expect(settleAuthorityReportRead(started.state, identity, {
				type: 'response', status: 200, bytes: bytes(validSnapshot(rangeA)),
			}).result).toBe('ignored')
		}
	})

	test('logout/login invalidates the prior request without exposing identifiers', () => {
		const oldSession = createAuthorityReportSessionEpoch()
		const installed = install(createAuthorityReportClientState(oldSession), rangeA, 19)
		const started = begin(installed, rangeA)
		const loggedOut = replaceAuthorityReportSession(started.state, null)
		expect(loggedOut.superseded).toBe(started.request.identity)
		expect(loggedOut.state.snapshot).toBeNull()

		const loggedIn = replaceAuthorityReportSession(loggedOut.state, createAuthorityReportSessionEpoch())
		const stale = settleAuthorityReportRead(loggedIn.state, started.request.identity, {
			type: 'response', status: 200, bytes: bytes(validSnapshot(rangeA, 88)),
		})
		expect(stale.result).toBe('ignored')
		expect(stale.state.snapshot).toBeNull()
		expect(JSON.stringify(loggedIn.state.sessionEpoch)).toBe('{}')
	})

	test('an older failure cannot stale or clear a newer success', () => {
		const initial = createAuthorityReportClientState(createAuthorityReportSessionEpoch())
		const older = begin(initial, rangeA)
		const newer = begin(older.state, rangeA)
		const success = settleAuthorityReportRead(newer.state, newer.request.identity, {
			type: 'response', status: 200, bytes: bytes(validSnapshot(rangeA, 42)),
		})
		const oldFailure = settleAuthorityReportRead(success.state, older.request.identity, {
			type: 'failure', category: 'transport_failure',
		})
		expect(oldFailure.result).toBe('ignored')
		expect(oldFailure.state.result).toBe('snapshot_installed')
		expect(observed(oldFailure.state)).toBe(42)
	})
})

describe('authority-report client admission and retention', () => {
	test('installs a valid 200 snapshot but treats a valid 503 refusal as failure', () => {
		const initial = createAuthorityReportClientState(createAuthorityReportSessionEpoch())
		const installed = install(initial, rangeA)
		expect(installed.snapshot?.response.validity).toEqual({
			current_use: 'forbidden', valid_until: null, proof: null,
		})

		const refresh = begin(installed, rangeA)
		const refused = settleAuthorityReportRead(refresh.state, refresh.request.identity, {
			type: 'response', status: 503, bytes: bytes(refusal(rangeA)),
		})
		expect(refused.result).toBe('report_refused')
		expect(refused.retainedSnapshot).toBe(true)
		expect(observed(refused.state)).toBe(11)
	})

	test('rejects crossed status/body combinations and retains only a compatible snapshot', () => {
		const initial = createAuthorityReportClientState(createAuthorityReportSessionEpoch())
		const installed = install(initial, rangeA, 14)
		for (const [status, response] of [
			[503, validSnapshot(rangeA, 70)],
			[200, refusal(rangeA)],
		] as const) {
			const refresh = begin(installed, rangeA)
			const settled = settleAuthorityReportRead(refresh.state, refresh.request.identity, {
				type: 'response', status, bytes: bytes(response),
			})
			expect(settled.result).toBe('invalid_response')
			expect(settled.retainedSnapshot).toBe(true)
			expect(settled.state.snapshot).toBe(installed.snapshot)
			expect(settled.state.activeRequest).toBeNull()
			expect(observed(settled.state)).toBe(14)
		}
	})

	test('rejects malformed, oversized, and nested-invalid bytes without installation', () => {
		for (const responseBytes of [
			bytes('{'),
			new Uint8Array(AUTHORITY_REPORT_RESPONSE_MAX_BYTES + 1),
			bytes({ ...validSnapshot(rangeA), validity: { current_use: 'current', valid_until: null, proof: null } }),
			bytes({ ...validSnapshot(rangeA), report: { ...(validSnapshot(rangeA).report as object), extra: true } }),
		]) {
			const started = begin(createAuthorityReportClientState(createAuthorityReportSessionEpoch()), rangeA)
			const settled = settleAuthorityReportRead(started.state, started.request.identity, {
				type: 'response', status: 200, bytes: responseBytes,
			})
			expect(settled.result).toBe('invalid_response')
			expect(settled.state.snapshot).toBeNull()
		}
	})

	test('retains same-range snapshot with original data but clears it on range change', () => {
		const initial = createAuthorityReportClientState(createAuthorityReportSessionEpoch())
		const first = begin(initial, rangeB)
		const installedResult = settleAuthorityReportRead(first.state, first.request.identity, {
			type: 'response', status: 200, bytes: bytes(genericSnapshot()),
		})
		expect(installedResult.result).toBe('snapshot_installed')
		const installed = installedResult.state
		const original = installed.snapshot

		const same = begin(installed, { ...rangeB })
		const failed = settleAuthorityReportRead(same.state, same.request.identity, {
			type: 'failure', category: 'deadline_exceeded',
		})
		expect(failed.retainedSnapshot).toBe(true)
		expect(failed.state.snapshot).toBe(original)
		expect(observed(failed.state)).toBe(17)
		const retained = failed.state.snapshot!.response as any
		expect(retained.report.as_of).toBe(rangeB.end)
		expect(retained.report.cutover).toBe(rangeB.start)
		expect(retained.report.sections[0].working_time.data.target).toBe('none')
		expect(retained.report.sections[0].disclosures.data.lanes[0]).toMatchObject({
			label: 'Executor 7', synchronization: 'unknown',
		})

		const changed = begin(failed.state, rangeA)
		expect(changed.state.snapshot).toBeNull()
		const changedFailure = settleAuthorityReportRead(changed.state, changed.request.identity, {
			type: 'failure', category: 'transport_failure',
		})
		expect(changedFailure.retainedSnapshot).toBe(false)
		expect(changedFailure.state.snapshot).toBeNull()
	})

	test('copies and freezes range and decoded response against caller mutation', () => {
		const mutableRange = { ...rangeA }
		const started = begin(createAuthorityReportClientState(createAuthorityReportSessionEpoch()), mutableRange)
		mutableRange.start = rangeB.start
		const payload = validSnapshot(rangeA, 23)
		const payloadBytes = bytes(payload)
		const settled = settleAuthorityReportRead(started.state, started.request.identity, {
			type: 'response', status: 200, bytes: payloadBytes,
		})
		payloadBytes.fill(0)
		;(payload.report as any).sections[0].working_time.data.observed_minutes = 900
		expect(settled.state.range).toEqual(rangeA)
		expect(observed(settled.state)).toBe(23)
		expect(Object.isFrozen(settled.state.snapshot?.response.report.sections)).toBe(true)
		const retainedMetric = (settled.state.snapshot!.response.report.sections[0] as any).working_time
		expect(Reflect.set(retainedMetric.data, 'observed_minutes', 901)).toBe(false)
		expect(Reflect.set(settled.state.snapshot!.range, 'start', rangeB.start)).toBe(false)
		expect(() => (settled.state.snapshot!.response.report.sections as any[]).push({})).toThrow()
		expect(observed(settled.state)).toBe(23)
	})

	test('never promotes legacy/current/target/ready/synchronization fields', () => {
		const invalidPackets = [
			[{ ...validSnapshot(rangeA), transport_version: 2 }, rangeA],
			[validSnapshot(rangeB), rangeA],
			[{ ...validSnapshot(rangeA),
				validity: { current_use: 'allowed', valid_until: rangeA.end, proof: {} } }, rangeA],
			[(() => {
				const value = structuredClone(validSnapshot(rangeA)) as any
				value.report.sections[0].working_time.data.target = 'ready'
				return value
			})(), rangeA],
			[(() => {
				const value = structuredClone(validSnapshot(rangeA)) as any
				value.report.sections[0].working_time.comparison = 'on_track'
				return value
			})(), rangeA],
			[(() => {
				const value = structuredClone(genericSnapshot()) as any
				value.report.sections[0].working_time.state = 'ready'
				return value
			})(), rangeB],
			[(() => {
				const value = structuredClone(genericSnapshot()) as any
				value.report.sections[0].disclosures.data.lanes[0].synchronization = 'ready'
				return value
			})(), rangeB],
		] as const
		for (const [packet, admittedRange] of invalidPackets) {
			const started = begin(createAuthorityReportClientState(createAuthorityReportSessionEpoch()), admittedRange)
			const settled = settleAuthorityReportRead(started.state, started.request.identity, {
				type: 'response', status: 200, bytes: bytes(packet),
			})
			expect(settled.result).toBe('invalid_response')
			expect(settled.state.snapshot).toBeNull()
		}
	})

	test('emits only the closed request and retains no rejected-body sentinel or diagnostics', () => {
		const started = begin(createAuthorityReportClientState(createAuthorityReportSessionEpoch()), rangeA)
		expect(JSON.parse(new TextDecoder().decode(started.request.bytes))).toEqual({
			transport_version: 1,
			range: rangeA,
		})
		expect(Object.keys(started.state).sort()).toEqual([
			'activeRequest', 'generation', 'range', 'result', 'sessionEpoch', 'snapshot',
		])
		const sentinel = 'PRIVATE-SENTINEL-5AD'
		const rejected = settleAuthorityReportRead(started.state, started.request.identity, {
			type: 'response',
			status: 200,
			bytes: bytes({ ...validSnapshot(rangeA), diagnostic: sentinel }),
		})
		expect(rejected.result).toBe('invalid_response')
		expect(JSON.stringify(rejected)).not.toContain(sentinel)
		expect(Object.keys(rejected).sort()).toEqual(['result', 'retainedSnapshot', 'state'])
	})
})

describe('authority-report client lifecycle edges', () => {
	test('clears populated state and permanently refuses wrap at MAX_SAFE_INTEGER', () => {
		const session = createAuthorityReportSessionEpoch()
		const installed = install(createAuthorityReportClientState(session), rangeA)
		const reading = begin(installed, rangeA)
		const state = {
			...reading.state,
			generation: Number.MAX_SAFE_INTEGER,
		} as AuthorityReportClientState
		const result = beginAuthorityReportRead(state, rangeA)
		expect(result).toMatchObject({ ok: false, error: 'generation_exhausted' })
		expect(result.superseded).toBe(reading.request.identity)
		expect(result.state).toMatchObject({
			sessionEpoch: null,
			generation: Number.MAX_SAFE_INTEGER,
			range: null,
			snapshot: null,
			activeRequest: null,
			result: 'generation_exhausted',
		})
		const replaced = replaceAuthorityReportSession(result.state, createAuthorityReportSessionEpoch())
		const retried = beginAuthorityReportRead(replaced.state, rangeA)
		expect(retried).toMatchObject({ ok: false, error: 'generation_exhausted' })
		expect(retried.state.generation).toBe(Number.MAX_SAFE_INTEGER)
	})

	test('hide clears display/work and resume requires an explicit fresh begin', () => {
		const session = createAuthorityReportSessionEpoch()
		const installed = install(createAuthorityReportClientState(session), rangeA)
		const reading = begin(installed, rangeA)
		const hidden = hideAuthorityReportClient(reading.state)
		expect(hidden.superseded).toBe(reading.request.identity)
		expect(hidden.state).toMatchObject({ range: null, snapshot: null, activeRequest: null, result: 'inactive' })

		const late = settleAuthorityReportRead(hidden.state, reading.request.identity, {
			type: 'response', status: 200, bytes: bytes(validSnapshot(rangeA, 55)),
		})
		expect(late.result).toBe('ignored')
		expect(late.state.snapshot).toBeNull()
		const resumed = begin(hidden.state, rangeA)
		expect(resumed.request.identity.generation).toBe(reading.request.identity.generation + 1)
	})

	test('forged active identity with equal values cannot bypass active range checks', () => {
		const started = begin(createAuthorityReportClientState(createAuthorityReportSessionEpoch()), rangeA)
		const forged = {
			sessionEpoch: started.request.identity.sessionEpoch,
			generation: started.request.identity.generation,
			range: { ...rangeA },
		} as AuthorityReportRequestIdentity
		const settled = settleAuthorityReportRead(started.state, forged, {
			type: 'response', status: 200, bytes: bytes(validSnapshot(rangeA, 33)),
		})
		expect(settled.result).toBe('snapshot_installed')
		expect(observed(settled.state)).toBe(33)
	})
})

function assertSnapshotIsRecursivelyReadonly(snapshot: AuthorityReportSnapshotSlot): void {
	// @ts-expect-error Installed response objects are recursively readonly to consumers.
	snapshot.response.report.range.start = rangeB.start
	// @ts-expect-error Installed response arrays are recursively readonly to consumers.
	snapshot.response.report.sections.pop()
}
