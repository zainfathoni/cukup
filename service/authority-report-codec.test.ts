import { describe, expect, test } from 'bun:test'
import {
	AUTHORITY_REPORT_REQUEST_MAX_BYTES,
	AUTHORITY_REPORT_RESPONSE_MAX_BYTES,
	decodeAuthorityReportRequest,
	decodeAuthorityReportResponse,
	encodeAuthorityReportResponse,
	hasStrictAuthorityReportJsonSyntax,
	type AuthorityRange,
} from './authority-report-codec.ts'

const encoder = new TextEncoder()
const frozenCapabilities = [
	'engagement.composition', 'engagement.submission', 'engagement.follow_up',
	'engagement.approval', 'engagement.takeover', 'execution.segments',
	'recovery.engagement.composition', 'recovery.engagement.submission',
	'recovery.engagement.follow_up', 'recovery.engagement.approval',
	'recovery.engagement.takeover', 'recovery.execution_start.native',
	'recovery.execution_start.current_observation', 'recovery.execution_end.native',
	'process.lifecycle',
]
const range: AuthorityRange = {
	start: '2026-09-20T16:00:00.000Z',
	end: '2026-09-20T18:00:00.000Z',
}
const cutover = '2026-09-20T17:00:00.000Z'

function bytes(value: unknown): Uint8Array {
	return encoder.encode(typeof value === 'string' ? value : JSON.stringify(value))
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { transport_version: 1, range, ...overrides }
}

function unavailable(metric: string, reason = 'report_unavailable'): Record<string, unknown> {
	return { metric, state: 'unavailable', reason }
}

function stale(metric: string, observed = 0): Record<string, unknown> {
	return {
		metric,
		state: 'stale',
		reason: 'refresh_required',
		data: { observed_minutes: observed, target: 'none' },
	}
}

function lane(label = 'Executor 1', laneRange: AuthorityRange = { start: cutover, end: range.end }): Record<string, unknown> {
	return {
		label,
		capability_intervals: [{
			start: laneRange.start,
			end: laneRange.end,
			working_time_v1: {
				status: 'declared_limited',
				missing_capabilities: [
					'engagement.composition', 'engagement.submission', 'engagement.follow_up',
					'engagement.approval', 'engagement.takeover',
				],
				missing_recovery_capabilities: [
					'recovery.engagement.composition', 'recovery.engagement.submission',
					'recovery.engagement.follow_up', 'recovery.engagement.approval',
					'recovery.engagement.takeover',
				],
			},
			agent_runtime_v1: {
				status: 'declared_for_scope',
				missing_recovery_capabilities: ['recovery.execution_end.native'],
			},
		}],
		known_losses: [{
			start: laneRange.start,
			end: laneRange.end,
			capabilities: ['execution.segments'],
			reason: 'abrupt_termination',
		}],
		pending_execution: { status: 'pending', started_at: [laneRange.start, laneRange.start] },
		synchronization: 'unknown',
	}
}

function verifiedResponse(): Record<string, any> {
	return {
		transport_version: 1,
		validity: { current_use: 'forbidden', valid_until: null, proof: null },
		report: {
			contract_version: 1,
			timezone: 'Asia/Jakarta',
			range,
			as_of: range.end,
			authority: 'verified',
			cutover,
			delivery: 'snapshot',
			reason: 'refresh_required',
			sections: [{
				authority: 'legacy',
				range: { start: range.start, end: cutover },
				working_time: stale('legacy_working_time', 11),
			}, {
				authority: 'generic',
				range: { start: cutover, end: range.end },
				working_time: unavailable('working_time_estimated'),
				agent_runtime: stale('agent_runtime', 16),
				disclosures: {
					state: 'stale',
					reason: 'refresh_required',
					data: { start: cutover, end: range.end, lanes: [lane()] },
				},
			}],
		},
	}
}

function refusal(admitted = range): Record<string, unknown> {
	return {
		transport_version: 1,
		validity: { current_use: 'forbidden', valid_until: null, proof: null },
		report: {
			contract_version: 1,
			timezone: 'Asia/Jakarta',
			range: admitted,
			as_of: null,
			authority: 'unresolved',
			cutover: null,
			delivery: 'unavailable',
			reason: 'authority_unavailable',
			sections: [],
		},
	}
}

function responseResult(value: unknown, admitted = range) {
	return decodeAuthorityReportResponse(bytes(value), admitted)
}

function clone<T>(value: T): T {
	return structuredClone(value)
}

describe('authority-report request codec', () => {
	test('distinguishes 16/17 containers and escaped decoded 64/65-byte keys', () => {
		const nested = (depth: number) => bytes(`${'['.repeat(depth)}0${']'.repeat(depth)}`)
		expect(hasStrictAuthorityReportJsonSyntax(nested(16))).toBe(true)
		expect(hasStrictAuthorityReportJsonSyntax(nested(17))).toBe(false)

		const escapedRocket = '\\ud83d\\ude80'
		const objectWithKey = (key: string) => bytes(`{"${key}":0}`)
		expect(encoder.encode('🚀'.repeat(16))).toHaveLength(64)
		expect(hasStrictAuthorityReportJsonSyntax(objectWithKey(escapedRocket.repeat(16)))).toBe(true)
		expect(encoder.encode(`${'🚀'.repeat(16)}x`)).toHaveLength(65)
		expect(hasStrictAuthorityReportJsonSyntax(objectWithKey(`${escapedRocket.repeat(16)}x`))).toBe(false)
	})

	test('distinguishes the inclusive 1024-byte body boundary', () => {
		const body = JSON.stringify(request())
		const atLimit = body + ' '.repeat(AUTHORITY_REPORT_REQUEST_MAX_BYTES - encoder.encode(body).byteLength)
		expect(bytes(atLimit)).toHaveLength(1_024)
		expect(decodeAuthorityReportRequest(bytes(atLimit))).toEqual({
			ok: true,
			value: { transport_version: 1, range },
		})
		expect(decodeAuthorityReportRequest(bytes(`${atLimit} `))).toEqual({
			ok: false,
			error: 'payload_too_large',
		})
	})

	test('rejects decoded duplicate keys at nested depths and malformed text', () => {
		const escapedDuplicate = '{"transport_version":1,"range":{"start":"2026-09-20T16:00:00.000Z",' +
			'"st\\u0061rt":"2026-09-20T16:00:00.000Z","end":"2026-09-20T18:00:00.000Z"}}'
		for (const body of [
			bytes(escapedDuplicate),
			new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(JSON.stringify(request()))]),
			new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]),
			bytes('{"transport_version":1,"range":{"start":"\\ud800","end":"2026-09-20T18:00:00.000Z"}}'),
			bytes(`${JSON.stringify(request())}{}`),
		]) {
			expect(decodeAuthorityReportRequest(body)).toEqual({ ok: false, error: 'invalid_request' })
		}
	})

	test('accepts only canonical nonnegative safe-integer lexemes', () => {
		for (const lexeme of ['-0', '-1', '1.0', '1e0', '1E+0', '9007199254740992']) {
			const body = `{"transport_version":${lexeme},"range":${JSON.stringify(range)}}`
			expect(decodeAuthorityReportRequest(bytes(body))).toEqual({ ok: false, error: 'invalid_request' })
		}
		expect(decodeAuthorityReportRequest(bytes(request({ transport_version: 2 })))).toEqual({
			ok: false,
			error: 'unsupported_version',
		})
		expect(decodeAuthorityReportRequest(bytes({ ...request({ transport_version: 2 }), extra: 0 }))).toEqual({
			ok: false,
			error: 'invalid_request',
		})
	})

	test('enforces exact timestamp round trips, limits, order, and maximum span', () => {
		const maximumSpan = 31_622_400_000
		const start = Date.parse('2026-01-01T00:00:00.000Z')
		const exactMaximumRange = {
			start: new Date(start).toISOString(),
			end: new Date(start + maximumSpan).toISOString(),
		}
		for (const admitted of [
			{ start: '1970-01-01T00:00:00.000Z', end: '1970-01-01T00:00:00.001Z' },
			{ start: '9999-12-31T23:59:59.998Z', end: '9999-12-31T23:59:59.999Z' },
			exactMaximumRange,
		]) {
			expect(decodeAuthorityReportRequest(bytes(request({ range: admitted }))).ok).toBe(true)
		}
		for (const rejected of [
			{ start: exactMaximumRange.start, end: new Date(start + maximumSpan + 1).toISOString() },
			{ start: range.start, end: range.start },
			{ start: range.end, end: range.start },
			{ start: '1969-12-31T23:59:59.999Z', end: '1970-01-01T00:00:00.000Z' },
			{ start: '2026-02-29T00:00:00.000Z', end: range.end },
			{ start: '2026-09-20T16:00:00Z', end: range.end },
			{ start: '10000-01-01T00:00:00.000Z', end: '10000-01-01T00:00:00.001Z' },
		]) {
			expect(decodeAuthorityReportRequest(bytes(request({ range: rejected })))).toEqual({
				ok: false,
				error: 'invalid_request',
			})
		}
	})
})

describe('authority-report response codec', () => {
	test('distinguishes the inclusive 262144-byte body boundary', () => {
		const body = JSON.stringify(refusal())
		const atLimit = body + ' '.repeat(AUTHORITY_REPORT_RESPONSE_MAX_BYTES - encoder.encode(body).byteLength)
		expect(bytes(atLimit)).toHaveLength(262_144)
		expect(decodeAuthorityReportResponse(bytes(atLimit), range).ok).toBe(true)
		expect(decodeAuthorityReportResponse(bytes(`${atLimit} `), range)).toEqual({
			ok: false,
			error: 'payload_too_large',
		})
	})

	test('requires forbidden current use and null deadline/proof exactly', () => {
		expect(responseResult(refusal()).ok).toBe(true)
		for (const validity of [
			{ current_use: 'allowed', valid_until: null, proof: null },
			{ current_use: 'forbidden', valid_until: range.end, proof: null },
			{ current_use: 'forbidden', valid_until: null, proof: {} },
			{ current_use: 'forbidden', valid_until: null, proof: null, extra: 0 },
		]) {
			const value = refusal() as any
			value.validity = validity
			expect(responseResult(value).ok).toBe(false)
		}
	})

	test('requires the exact admitted range and canonical authority partition', () => {
		expect(responseResult(verifiedResponse()).ok).toBe(true)
		const mismatch = verifiedResponse()
		mismatch.report.range = { start: range.start, end: '2026-09-20T18:00:00.001Z' }
		expect(responseResult(mismatch).ok).toBe(false)

		for (const mutate of [
			(value: any) => value.report.sections.reverse(),
			(value: any) => { value.report.sections[0].range.end = '2026-09-20T16:59:59.999Z' },
			(value: any) => { value.report.sections[1].authority = 'legacy' },
			(value: any) => { value.report.cutover = '2026-09-21T17:00:00.000Z' },
		]) {
			const value = verifiedResponse()
			mutate(value)
			expect(responseResult(value).ok).toBe(false)
		}
	})

	test('distinguishes unavailable data from observed zero and requires targetless stale metrics', () => {
		const zero = verifiedResponse()
		zero.report.sections[1].working_time = stale('working_time_estimated', 0)
		expect(responseResult(zero).ok).toBe(true)

		const unavailableWithData = verifiedResponse()
		unavailableWithData.report.sections[1].working_time = {
			...unavailable('working_time_estimated'), data: { observed_minutes: 0, target: 'none' },
		}
		expect(responseResult(unavailableWithData).ok).toBe(false)

		for (const data of [
			{ observed_minutes: 16, target: 'comparison' },
			{ observed_minutes: 16, target: 'none', comparison: { target_minutes: 20 } },
			{ observed_minutes: -1, target: 'none' },
			{ observed_minutes: 1.5, target: 'none' },
		]) {
			const value = verifiedResponse()
			value.report.sections[1].agent_runtime.data = data
			expect(responseResult(value).ok).toBe(false)
		}
	})

	test('accepts only semantically valid future not-started sections', () => {
		const futureRange = { start: cutover, end: '2026-09-20T18:00:00.000Z' }
		const value = verifiedResponse()
		value.report.range = futureRange
		value.report.as_of = '2026-09-20T16:59:59.999Z'
		value.report.sections = [{
			authority: 'generic', range: futureRange,
			working_time: unavailable('working_time_estimated', 'not_started'),
			agent_runtime: unavailable('agent_runtime', 'not_started'),
			disclosures: { state: 'unavailable', reason: 'not_started' },
		}]
		value.report.delivery = 'unavailable'
		value.report.reason = 'report_unavailable'
		expect(responseResult(value, futureRange).ok).toBe(true)
		expect(encodeAuthorityReportResponse(value, futureRange).ok).toBe(true)
		value.report.as_of = cutover
		expect(responseResult(value, futureRange).ok).toBe(true)
		expect(encodeAuthorityReportResponse(value, futureRange).ok).toBe(true)
		value.report.as_of = '2026-09-20T17:00:00.001Z'
		expect(responseResult(value, futureRange).ok).toBe(false)
		expect(encodeAuthorityReportResponse(value, futureRange).ok).toBe(false)
		value.report.sections[0].working_time.reason = 'report_unavailable'
		value.report.sections[0].agent_runtime.reason = 'report_unavailable'
		value.report.sections[0].disclosures.reason = 'report_unavailable'
		expect(responseResult(value, futureRange).ok).toBe(true)
		expect(encodeAuthorityReportResponse(value, futureRange).ok).toBe(true)

		value.report.as_of = '2026-09-20T16:59:59.999Z'
		expect(responseResult(value, futureRange).ok).toBe(false)
		expect(encodeAuthorityReportResponse(value, futureRange).ok).toBe(false)
	})

	test('withholds both generic metrics when required disclosures are unavailable', () => {
		const inconsistent = verifiedResponse()
		inconsistent.report.sections[1].disclosures = { state: 'unavailable', reason: 'report_unavailable' }
		expect(responseResult(inconsistent).ok).toBe(false)
		expect(encodeAuthorityReportResponse(inconsistent, range).ok).toBe(false)

		const payloadFree = verifiedResponse()
		payloadFree.report.sections[1].working_time = unavailable('working_time_estimated')
		payloadFree.report.sections[1].agent_runtime = unavailable('agent_runtime')
		payloadFree.report.sections[1].disclosures = { state: 'unavailable', reason: 'report_unavailable' }
		expect(responseResult(payloadFree).ok).toBe(true)
		expect(encodeAuthorityReportResponse(payloadFree, range).ok).toBe(true)
	})

	test('rejects unknown nested enums and corrupt generic data without salvaging valid legacy data', () => {
		for (const mutate of [
			(value: any) => { value.report.sections[1].disclosures.data.lanes[0].known_losses[0].reason = 'disk_full' },
			(value: any) => { value.report.sections[1].disclosures.data.lanes[0].capability_intervals[0]
				.working_time_v1 = { status: 'future_status' } },
			(value: any) => { value.report.sections[1].disclosures.data.lanes[0].known_losses[0]
				.capabilities = ['future.capability'] },
			(value: any) => { value.report.sections[1].disclosures.data.lanes[0].synchronization = 'queued' },
		]) {
			const value = verifiedResponse()
			mutate(value)
			expect(responseResult(value)).toEqual({ ok: false, error: 'invalid_response' })
		}
	})

	test('enforces unique bounded labels and the 64-lane ceiling without truncation', () => {
		const value = verifiedResponse()
		value.report.sections[1].disclosures.data.lanes = Array.from({ length: 64 }, (_, index) => lane(`Executor ${index + 1}`))
		expect(responseResult(value).ok).toBe(true)
		value.report.sections[1].disclosures.data.lanes.push(lane('Executor 65'))
		expect(responseResult(value).ok).toBe(false)
		for (const label of ['x'.repeat(128), '🚀'.repeat(32)]) {
			const atLimit = verifiedResponse()
			atLimit.report.sections[1].disclosures.data.lanes[0].label = label
			expect(encoder.encode(label)).toHaveLength(128)
			expect(responseResult(atLimit).ok).toBe(true)
		}

		for (const label of ['', 'x'.repeat(129), `${'🚀'.repeat(32)}x`, 'unsafe\nlabel']) {
			const badLabel = verifiedResponse()
			badLabel.report.sections[1].disclosures.data.lanes[0].label = label
			if (label.endsWith('x') && label.startsWith('🚀')) expect(encoder.encode(label)).toHaveLength(129)
			expect(responseResult(badLabel).ok).toBe(false)
		}
		const duplicate = verifiedResponse()
		duplicate.report.sections[1].disclosures.data.lanes.push(lane())
		expect(responseResult(duplicate).ok).toBe(false)
	})

	test('enforces every per-lane limit and capability assessment vocabulary', () => {
		const value = verifiedResponse()
		const targetLane = value.report.sections[1].disclosures.data.lanes[0]
		targetLane.known_losses = Array.from({ length: 128 }, () => clone(targetLane.known_losses[0]))
		targetLane.pending_execution.started_at = Array.from({ length: 128 }, () => cutover)
		expect(responseResult(value).ok).toBe(true)

		const tooManyLosses = clone(value)
		tooManyLosses.report.sections[1].disclosures.data.lanes[0].known_losses.push(clone(targetLane.known_losses[0]))
		expect(responseResult(tooManyLosses).ok).toBe(false)
		const tooManyPending = clone(value)
		tooManyPending.report.sections[1].disclosures.data.lanes[0].pending_execution.started_at.push(cutover)
		expect(responseResult(tooManyPending).ok).toBe(false)

		const capabilities = verifiedResponse()
		capabilities.report.sections[1].disclosures.data.lanes[0].known_losses[0].capabilities = [...frozenCapabilities]
		expect(responseResult(capabilities).ok).toBe(true)
		capabilities.report.sections[1].disclosures.data.lanes[0].known_losses[0].capabilities.push(frozenCapabilities[0])
		expect(responseResult(capabilities).ok).toBe(false)

		const noLosses = verifiedResponse()
		noLosses.report.sections[1].disclosures.data.lanes[0].known_losses = []
		expect(responseResult(noLosses).ok).toBe(true)
		expect(encodeAuthorityReportResponse(noLosses, range).ok).toBe(true)
		const emptyLoss = verifiedResponse()
		emptyLoss.report.sections[1].disclosures.data.lanes[0].known_losses[0].capabilities = []
		expect(responseResult(emptyLoss).ok).toBe(false)
		expect(encodeAuthorityReportResponse(emptyLoss, range).ok).toBe(false)
		const recoveryOnlyLoss = verifiedResponse()
		recoveryOnlyLoss.report.sections[1].disclosures.data.lanes[0]
			.known_losses[0].capabilities = ['recovery.execution_end.native']
		expect(responseResult(recoveryOnlyLoss).ok).toBe(true)
		expect(encodeAuthorityReportResponse(recoveryOnlyLoss, range).ok).toBe(true)
	})

	test('requires paired declaration presence and recovery/base consistency', () => {
		const mixedPresence = verifiedResponse()
		mixedPresence.report.sections[1].disclosures.data.lanes[0]
			.capability_intervals[0].working_time_v1 = { status: 'unknown' }
		expect(responseResult(mixedPresence).ok).toBe(false)

		const impossibleRecovery = verifiedResponse()
		impossibleRecovery.report.sections[1].disclosures.data.lanes[0]
			.capability_intervals[0].agent_runtime_v1 = {
				status: 'declared_limited',
				missing_capabilities: ['execution.segments'],
				missing_recovery_capabilities: [],
			}
		expect(responseResult(impossibleRecovery).ok).toBe(false)

		const bothUnknown = verifiedResponse()
		const interval = bothUnknown.report.sections[1].disclosures.data.lanes[0].capability_intervals[0]
		interval.working_time_v1 = { status: 'unknown' }
		interval.agent_runtime_v1 = { status: 'unknown' }
		expect(responseResult(bothUnknown).ok).toBe(true)
	})

	test('allows declaration knowledge to begin but never revert to unknown', () => {
		const middle = '2026-09-20T17:30:00.000Z'
		const declaredThenUnknown = verifiedResponse()
		const declared = clone(declaredThenUnknown.report.sections[1].disclosures.data.lanes[0]
			.capability_intervals[0])
		declared.end = middle
		declaredThenUnknown.report.sections[1].disclosures.data.lanes[0].capability_intervals = [
			declared,
			{ start: middle, end: range.end, working_time_v1: { status: 'unknown' },
				agent_runtime_v1: { status: 'unknown' } },
		]
		expect(responseResult(declaredThenUnknown).ok).toBe(false)
		expect(encodeAuthorityReportResponse(declaredThenUnknown, range).ok).toBe(false)

		const unknownThenDeclared = verifiedResponse()
		const laterDeclaration = clone(unknownThenDeclared.report.sections[1].disclosures.data.lanes[0]
			.capability_intervals[0])
		laterDeclaration.start = middle
		unknownThenDeclared.report.sections[1].disclosures.data.lanes[0].capability_intervals = [
			{ start: cutover, end: middle, working_time_v1: { status: 'unknown' },
				agent_runtime_v1: { status: 'unknown' } },
			laterDeclaration,
		]
		expect(responseResult(unknownThenDeclared).ok).toBe(true)
		expect(encodeAuthorityReportResponse(unknownThenDeclared, range).ok).toBe(true)
	})

	test('accepts 128 partitioning intervals and rejects 129', () => {
		const value = verifiedResponse()
		const start = Date.parse(cutover)
		const end = Date.parse(range.end)
		const step = (end - start) / 128
		const intervals = Array.from({ length: 128 }, (_, index) => ({
			start: new Date(start + index * step).toISOString(),
			end: new Date(start + (index + 1) * step).toISOString(),
			working_time_v1: { status: 'unknown' },
			agent_runtime_v1: { status: 'unknown' },
		}))
		value.report.sections[1].disclosures.data.lanes[0].capability_intervals = intervals
		expect(responseResult(value).ok).toBe(true)
		const tooMany = verifiedResponse()
		const step129 = (end - start) / 129
		tooMany.report.sections[1].disclosures.data.lanes[0].capability_intervals =
			Array.from({ length: 129 }, (_, index) => ({
				start: new Date(start + Math.floor(index * step129)).toISOString(),
				end: new Date(start + Math.floor((index + 1) * step129)).toISOString(),
				working_time_v1: { status: 'unknown' },
				agent_runtime_v1: { status: 'unknown' },
			}))
		expect(responseResult(tooMany).ok).toBe(false)
	})

	test('rejects escaped nested duplicates, malformed UTF-8, BOM, surrogates, trailing JSON, and numeric lexemes', () => {
		const valid = JSON.stringify(refusal())
		const duplicate = valid.replace('"range":{"start"', '"range":{"start":"2026-09-20T16:00:00.000Z","st\\u0061rt"')
		const validWithMarker = JSON.stringify(verifiedResponse()).replace('Executor 1', 'MARKER')
		const malformedLabel = bytes(validWithMarker)
		const markerOffset = validWithMarker.indexOf('MARKER')
		malformedLabel[markerOffset] = 0x80
		for (const body of [
			bytes(duplicate),
			new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(valid)]),
			malformedLabel,
			bytes(valid.replace('"Asia/Jakarta"', '"\\udfff"')),
			bytes(`${valid}null`),
			bytes(valid.replace('"transport_version":1', '"transport_version":1e0')),
		]) {
			expect(decodeAuthorityReportResponse(body, range).ok).toBe(false)
		}
	})

	test('canonical encoding revalidates semantics, ordering, and output size', () => {
		const reordered = {
			report: refusal().report,
			validity: { proof: null, valid_until: null, current_use: 'forbidden' },
			transport_version: 1,
		}
		const encoded = encodeAuthorityReportResponse(reordered, range)
		expect(encoded.ok).toBe(true)
		if (!encoded.ok) return
		expect(new TextDecoder().decode(encoded.bytes).startsWith(
			'{"transport_version":1,"validity":{"current_use":"forbidden","valid_until":null,"proof":null},"report":',
		)).toBe(true)
		expect(decodeAuthorityReportResponse(encoded.bytes, range).ok).toBe(true)
		const reversedRange = { end: range.end, start: range.start }
		const reversed = encodeAuthorityReportResponse(reordered, reversedRange)
		expect(reversed).toEqual(encoded)

		const invalid = verifiedResponse()
		invalid.report.sections[1].agent_runtime.data.target = 'comparison'
		expect(encodeAuthorityReportResponse(invalid, range)).toEqual({ ok: false, error: 'invalid_response' })
		const surrogate = verifiedResponse()
		surrogate.report.sections[1].disclosures.data.lanes[0].label = '\ud800'
		expect(encodeAuthorityReportResponse(surrogate, range)).toEqual({ ok: false, error: 'invalid_response' })

		const oversized = verifiedResponse()
		const sourceLane = oversized.report.sections[1].disclosures.data.lanes[0]
		const start = Date.parse(cutover)
		const step = (Date.parse(range.end) - start) / 128
		sourceLane.capability_intervals = Array.from({ length: 128 }, (_, index) => ({
			start: new Date(start + index * step).toISOString(),
			end: new Date(start + (index + 1) * step).toISOString(),
			working_time_v1: { status: 'unknown' }, agent_runtime_v1: { status: 'unknown' },
		}))
		oversized.report.sections[1].disclosures.data.lanes = Array.from(
			{ length: 64 }, (_, index) => ({ ...clone(sourceLane), label: `Executor ${index + 1}` }),
		)
		expect(encodeAuthorityReportResponse(oversized, range)).toEqual({
			ok: false,
			error: 'payload_too_large',
		})
	})
})
