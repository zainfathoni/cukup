import {
	decodeAuthorityReportRequest,
	decodeAuthorityReportResponse,
	type AuthorityRange,
	type AuthorityReportResponse,
} from './authority-report-codec.ts'

const sessionEpochBrand: unique symbol = Symbol('AuthorityReportSessionEpoch')

type DeepReadonly<T> = T extends readonly (infer Item)[]
	? readonly DeepReadonly<Item>[]
	: T extends object
		? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
		: T

export type AuthorityReportSessionEpoch = Readonly<{ readonly [sessionEpochBrand]: true }>

export type AuthorityReportRequestIdentity = Readonly<{
	sessionEpoch: AuthorityReportSessionEpoch
	generation: number
	range: Readonly<AuthorityRange>
}>

export type AuthorityReportSnapshotSlot = Readonly<{
	sessionEpoch: AuthorityReportSessionEpoch
	range: Readonly<AuthorityRange>
	response: DeepReadonly<AuthorityReportResponse>
}>

export type AuthorityReportClientResult =
	| 'empty'
	| 'reading'
	| 'snapshot_installed'
	| 'report_refused'
	| 'invalid_response'
	| 'transport_failure'
	| 'request_cancelled'
	| 'deadline_exceeded'
	| 'inactive'
	| 'generation_exhausted'

export type AuthorityReportClientState = Readonly<{
	sessionEpoch: AuthorityReportSessionEpoch | null
	generation: number
	range: Readonly<AuthorityRange> | null
	snapshot: AuthorityReportSnapshotSlot | null
	activeRequest: AuthorityReportRequestIdentity | null
	result: AuthorityReportClientResult
}>

export type AuthorityReportRequest = Readonly<{
	identity: AuthorityReportRequestIdentity
	bytes: Uint8Array
}>

export type BeginAuthorityReportReadResult =
	| Readonly<{
		ok: true
		state: AuthorityReportClientState
		request: AuthorityReportRequest
		superseded: AuthorityReportRequestIdentity | null
	}>
	| Readonly<{
		ok: false
		error: 'no_session' | 'invalid_range' | 'generation_exhausted'
		state: AuthorityReportClientState
		superseded: AuthorityReportRequestIdentity | null
	}>

export type AuthorityReportSettlement =
	| Readonly<{ type: 'response'; status: 200 | 503; bytes: Uint8Array }>
	| Readonly<{ type: 'failure'; category: 'transport_failure' | 'request_cancelled' | 'deadline_exceeded' }>

export type SettleAuthorityReportReadResult = Readonly<{
	state: AuthorityReportClientState
	result: 'ignored' | 'snapshot_installed' | 'report_refused' | 'invalid_response' |
		'transport_failure' | 'request_cancelled' | 'deadline_exceeded'
	retainedSnapshot: boolean
}>

export type ClearAuthorityReportClientResult = Readonly<{
	state: AuthorityReportClientState
	superseded: AuthorityReportRequestIdentity | null
}>

/** Allocates an opaque, process-local equality token. It contains no session identifier. */
export function createAuthorityReportSessionEpoch(): AuthorityReportSessionEpoch {
	return Object.freeze({}) as AuthorityReportSessionEpoch
}

export function createAuthorityReportClientState(
	sessionEpoch: AuthorityReportSessionEpoch | null = null,
): AuthorityReportClientState {
	return freezeState({
		sessionEpoch,
		generation: 0,
		range: null,
		snapshot: null,
		activeRequest: null,
		result: 'empty',
	})
}

/** Replacing or removing a session clears all private state and invalidates active work. */
export function replaceAuthorityReportSession(
	state: AuthorityReportClientState,
	sessionEpoch: AuthorityReportSessionEpoch | null,
): ClearAuthorityReportClientResult {
	return Object.freeze({
		state: freezeState({
			sessionEpoch,
			generation: state.generation,
			range: null,
			snapshot: null,
			activeRequest: null,
			result: sessionEpoch === null ? 'inactive' : 'empty',
		}),
		superseded: state.activeRequest,
	})
}

/** Hide and pagehide share this pure clearing transition; resume requires a new explicit begin. */
export function hideAuthorityReportClient(
	state: AuthorityReportClientState,
): ClearAuthorityReportClientResult {
	return Object.freeze({
		state: freezeState({
			sessionEpoch: state.sessionEpoch,
			generation: state.generation,
			range: null,
			snapshot: null,
			activeRequest: null,
			result: 'inactive',
		}),
		superseded: state.activeRequest,
	})
}

export function beginAuthorityReportRead(
	state: AuthorityReportClientState,
	range: AuthorityRange,
): BeginAuthorityReportReadResult {
	if (state.sessionEpoch === null) {
		return Object.freeze({ ok: false, error: 'no_session', state, superseded: state.activeRequest })
	}
	if (state.generation === Number.MAX_SAFE_INTEGER) {
		const exhausted = freezeState({
			sessionEpoch: null,
			generation: state.generation,
			range: null,
			snapshot: null,
			activeRequest: null,
			result: 'generation_exhausted',
		})
		return Object.freeze({
			ok: false,
			error: 'generation_exhausted',
			state: exhausted,
			superseded: state.activeRequest,
		})
	}

	const requestBytes = new TextEncoder().encode(JSON.stringify({ transport_version: 1, range }))
	const decoded = decodeAuthorityReportRequest(requestBytes)
	if (!decoded.ok) {
		return Object.freeze({ ok: false, error: 'invalid_range', state, superseded: null })
	}
	const admittedRange = freezeRange(decoded.value.range)
	const generation = state.generation + 1
	const identity = Object.freeze({
		sessionEpoch: state.sessionEpoch,
		generation,
		range: admittedRange,
	})
	const compatibleSnapshot = snapshotMatches(state.snapshot, state.sessionEpoch, admittedRange)
		? state.snapshot
		: null
	const nextState = freezeState({
		sessionEpoch: state.sessionEpoch,
		generation,
		range: admittedRange,
		snapshot: compatibleSnapshot,
		activeRequest: identity,
		result: 'reading',
	})
	return Object.freeze({
		ok: true,
		state: nextState,
		request: Object.freeze({ identity, bytes: requestBytes.slice() }),
		superseded: state.activeRequest,
	})
}

export function settleAuthorityReportRead(
	state: AuthorityReportClientState,
	identity: AuthorityReportRequestIdentity,
	settlement: AuthorityReportSettlement,
): SettleAuthorityReportReadResult {
	if (!activeIdentityMatches(state, identity)) {
		return Object.freeze({ state, result: 'ignored', retainedSnapshot: state.snapshot !== null })
	}
	if (settlement.type === 'failure') {
		return finishFailure(state, settlement.category)
	}

	const decoded = decodeAuthorityReportResponse(settlement.bytes, identity.range)
	if (!decoded.ok) return finishFailure(state, 'invalid_response')
	if (settlement.status === 503) {
		return decoded.value.report.delivery === 'unavailable'
			? finishFailure(state, 'report_refused')
			: finishFailure(state, 'invalid_response')
	}
	if (decoded.value.report.delivery !== 'snapshot') return finishFailure(state, 'invalid_response')

	const response = deepFreeze(decoded.value)
	const snapshot = Object.freeze({
		sessionEpoch: identity.sessionEpoch,
		range: freezeRange(identity.range),
		response,
	})
	const nextState = freezeState({
		sessionEpoch: state.sessionEpoch,
		generation: state.generation,
		range: state.range,
		snapshot,
		activeRequest: null,
		result: 'snapshot_installed',
	})
	return Object.freeze({ state: nextState, result: 'snapshot_installed', retainedSnapshot: false })
}

function finishFailure(
	state: AuthorityReportClientState,
	result: 'report_refused' | 'invalid_response' | 'transport_failure' | 'request_cancelled' |
		'deadline_exceeded',
): SettleAuthorityReportReadResult {
	const retained = state.sessionEpoch !== null && state.range !== null &&
		snapshotMatches(state.snapshot, state.sessionEpoch, state.range)
	const nextState = freezeState({
		sessionEpoch: state.sessionEpoch,
		generation: state.generation,
		range: state.range,
		snapshot: retained ? state.snapshot : null,
		activeRequest: null,
		result,
	})
	return Object.freeze({ state: nextState, result, retainedSnapshot: retained })
}

function activeIdentityMatches(
	state: AuthorityReportClientState,
	identity: AuthorityReportRequestIdentity,
): boolean {
	const active = state.activeRequest
	return active !== null && state.sessionEpoch === identity.sessionEpoch &&
		active.sessionEpoch === identity.sessionEpoch && state.generation === identity.generation &&
		active.generation === identity.generation && state.range !== null &&
		sameRange(state.range, identity.range) && sameRange(active.range, identity.range)
}

function snapshotMatches(
	snapshot: AuthorityReportSnapshotSlot | null,
	sessionEpoch: AuthorityReportSessionEpoch,
	range: AuthorityRange,
): snapshot is AuthorityReportSnapshotSlot {
	return snapshot !== null && snapshot.sessionEpoch === sessionEpoch && sameRange(snapshot.range, range)
}

function sameRange(left: AuthorityRange, right: AuthorityRange): boolean {
	return left.start === right.start && left.end === right.end
}

function freezeRange(range: AuthorityRange): Readonly<AuthorityRange> {
	return Object.freeze({ start: range.start, end: range.end })
}

function freezeState(state: {
	sessionEpoch: AuthorityReportSessionEpoch | null
	generation: number
	range: Readonly<AuthorityRange> | null
	snapshot: AuthorityReportSnapshotSlot | null
	activeRequest: AuthorityReportRequestIdentity | null
	result: AuthorityReportClientResult
}): AuthorityReportClientState {
	return Object.freeze(state)
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
		return value as DeepReadonly<T>
	}
	Object.freeze(value)
	for (const nested of Object.values(value)) deepFreeze(nested)
	return value as DeepReadonly<T>
}
