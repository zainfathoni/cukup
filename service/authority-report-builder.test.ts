import { describe, expect, test } from 'bun:test'
import { decodeAuthorityReportResponse, type AuthorityRange } from './authority-report-codec.ts'
import {
	buildAuthorityReportSnapshot,
	type AuthorityReportSnapshotInput,
	type LabeledShadowDisclosureLane,
} from './authority-report-builder.ts'

const minute = 60_000
const cutoverMs = Date.parse('2026-09-20T17:00:00.000Z') // Monday 00:00 Asia/Jakarta.
const at = (minutes: number) => cutoverMs + minutes * minute
const range = { startMs: at(-30), endMs: at(40) }
const legacyRange = { startMs: range.startMs, endMs: cutoverMs }
const genericRange = { startMs: cutoverMs, endMs: range.endMs }
const available = (milliseconds: number) => ({
	availability: 'available' as const,
	globallyUnionedMilliseconds: milliseconds,
})
const unavailable = { availability: 'unavailable' as const }

function lane(
	startMs = genericRange.startMs,
	endMs = genericRange.endMs,
	label = 'Executor 1',
	synchronization: LabeledShadowDisclosureLane['synchronization'] = 'blocked',
): LabeledShadowDisclosureLane {
	return {
		label,
		collectorId: 'private-collector',
		executionSiteId: 'private-site',
		startMs,
		endMs,
		capabilityIntervals: [{
			startMs,
			endMs,
			workingTimeV1: { status: 'unknown' },
			agentRuntimeV1: { status: 'unknown' },
		}],
		collectionIntegrity: {
			otherwise: 'unknown',
			losses: [{
				status: 'known_loss',
				factId: 'private-fact',
				startMs,
				endMs,
				capabilities: ['execution.segments'],
				reason: 'abrupt_termination',
			}],
			},
		executionClosure: {
			status: 'pending',
			starts: [{ evidenceId: 'private-evidence', segmentId: 'private-segment', startMs }],
		},
		synchronization,
	}
}

function crossing(): AuthorityReportSnapshotInput {
	return {
		range: { ...range },
		classification: {
			authority: 'verified',
			mode: 'active',
			cutoverMs,
			asOfMs: range.endMs,
			partitions: [{
				authority: 'legacy',
				range: { ...legacyRange },
				workingTime: available(11 * minute),
			}, {
				authority: 'generic',
				range: { ...genericRange },
				workingTime: available(24 * minute),
				agentRuntime: available(16 * minute),
				disclosures: { availability: 'ready', disclosures: [lane()] },
			}],
		},
	}
}

function output(input: AuthorityReportSnapshotInput = crossing()): any {
	const result = buildAuthorityReportSnapshot(input)
	expect(result.ok).toBe(true)
	if (!result.ok) throw new Error(`Build failed: ${result.error}`)
	return result
}

function wireRange(value = range): AuthorityRange {
	return { start: new Date(value.startMs).toISOString(), end: new Date(value.endMs).toISOString() }
}

function deepFreeze(value: unknown): void {
	if (!value || typeof value !== 'object') return
	Object.freeze(value)
	for (const child of Object.values(value)) deepFreeze(child)
}

describe('buildAuthorityReportSnapshot', () => {
	test('keeps crossing authority and metrics separate with independently derived asymmetric totals', () => {
		// Original legacy windows globally union to 31 minutes, but exact pre-C clipping is 11.
		const fullLegacyMilliseconds = 31 * minute
		const result = output()
		const sections = result.value.report.sections
		expect(sections.map((section: any) => [section.authority, section.range])).toEqual([
			['legacy', wireRange(legacyRange)],
			['generic', wireRange(genericRange)],
		])
		expect(sections[0].working_time.data.observed_minutes).toBe(11)
		expect(sections[0].working_time.data.observed_minutes).not.toBe(fullLegacyMilliseconds / minute)
		expect(sections[1].working_time.data.observed_minutes).toBe(24)
		expect(sections[1].agent_runtime.data.observed_minutes).toBe(16)
		expect(result.value.report).not.toHaveProperty('observed_minutes')
		expect(sections[1].working_time.data).toEqual({ observed_minutes: 24, target: 'none' })
		expect(sections[1].agent_runtime.data).toEqual({ observed_minutes: 16, target: 'none' })
	})

	test('accepts generic-only and legacy-only exact partitions without authority fallback', () => {
		const genericOnly = crossing() as any
		genericOnly.range = genericRange
		genericOnly.classification.partitions = [genericOnly.classification.partitions[1]]
		expect(output(genericOnly).value.report.sections.map((section: any) => section.authority)).toEqual(['generic'])

		const legacyOnly: AuthorityReportSnapshotInput = {
			range: legacyRange,
			classification: {
				authority: 'verified', mode: 'legacy', cutoverMs: null, asOfMs: cutoverMs,
				partitions: [{ authority: 'legacy', range: legacyRange, workingTime: available(11 * minute) }],
			},
		}
		const legacy = output(legacyOnly).value.report
		expect(legacy.cutover).toBeNull()
		expect(legacy.sections.map((section: any) => section.authority)).toEqual(['legacy'])

		const unresolved = crossing() as any
		unresolved.classification = {
			authority: 'unresolved', mode: null, cutoverMs: null, asOfMs: null,
			partitions: crossing().classification.partitions,
		}
		const refusal = output(unresolved).value.report
		expect(refusal).toMatchObject({
			authority: 'unresolved', as_of: null, cutover: null,
			delivery: 'unavailable', reason: 'authority_unavailable', sections: [],
		})
	})

	test('floors one already globally unioned metric total once and distinguishes zero from unavailable', () => {
		const input = crossing() as any
		// Two disjoint 40-second intervals have already been globally unioned to 80,000 ms.
		input.classification.partitions[0].workingTime = available(80_000)
		input.classification.partitions[1].workingTime = available(0)
		input.classification.partitions[1].agentRuntime = unavailable
		const sections = output(input).value.report.sections
		expect(sections[0].working_time.data.observed_minutes).toBe(1)
		expect(sections[1].working_time).toMatchObject({
			state: 'stale', data: { observed_minutes: 0, target: 'none' },
		})
		expect(sections[1].agent_runtime).toEqual({
			metric: 'agent_runtime', state: 'unavailable', reason: 'report_unavailable',
		})
	})

	test('required disclosure unavailability withholds both generic metrics while independent legacy survives', () => {
		const input = crossing() as any
		input.classification.partitions[1].disclosures = { availability: 'unavailable' }
		const report = output(input).value.report
		expect(report.delivery).toBe('snapshot')
		expect(report.sections[0].working_time.data.observed_minutes).toBe(11)
		expect(report.sections[1]).toMatchObject({
			working_time: { state: 'unavailable', reason: 'report_unavailable' },
			agent_runtime: { state: 'unavailable', reason: 'report_unavailable' },
			disclosures: { state: 'unavailable', reason: 'report_unavailable' },
		})
		expect(JSON.stringify(report.sections[1])).not.toContain('24')
		expect(JSON.stringify(report.sections[1])).not.toContain('16')
	})

	test('uses Stage 5N stale delivery and strips private disclosure identities', () => {
		const value = output().value
		const disclosure = value.report.sections[1].disclosures
		expect(disclosure.data.lanes[0].synchronization).toBe('unknown')
		const serialized = JSON.stringify(value)
		for (const secret of ['private-collector', 'private-site', 'private-fact', 'private-evidence', 'private-segment']) {
			expect(serialized).not.toContain(secret)
		}
	})

	test('marks a wholly future partition not_started rather than observed zero', () => {
		const input = crossing() as any
		input.range = genericRange
		input.classification.asOfMs = cutoverMs
		input.classification.partitions = [{
			authority: 'generic', range: genericRange,
			workingTime: unavailable, agentRuntime: unavailable,
			disclosures: { availability: 'unavailable' },
		}]
		const report = output(input).value.report
		expect(report.delivery).toBe('unavailable')
		expect(report.sections[0]).toMatchObject({
			working_time: { state: 'unavailable', reason: 'not_started' },
			agent_runtime: { state: 'unavailable', reason: 'not_started' },
			disclosures: { state: 'unavailable', reason: 'not_started' },
		})
	})

	test('fails closed on malformed partitions, ranges, cutovers, and millisecond totals', () => {
		const cases: any[] = [null, {}, { range }, { range, classification: null }]
		const unknownAuthority = crossing() as any
		unknownAuthority.classification.authority = 'assumed'
		cases.push(unknownAuthority)
		const reversed = crossing() as any
		reversed.classification.partitions.reverse()
		cases.push(reversed)
		const gap = crossing() as any
		gap.classification.partitions[0].range.endMs--
		cases.push(gap)
		const invalidRange = crossing() as any
		invalidRange.range.endMs = invalidRange.range.startMs
		cases.push(invalidRange)
		const excessiveRange = crossing() as any
		excessiveRange.range.endMs = excessiveRange.range.startMs + 31_622_400_001
		cases.push(excessiveRange)
		const badCutover = crossing() as any
		badCutover.classification.cutoverMs++
		cases.push(badCutover)
		const badMode = crossing() as any
		badMode.classification.mode = 'generic'
		cases.push(badMode)
		for (const milliseconds of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			const badTotal = crossing() as any
			badTotal.classification.partitions[1].workingTime = available(milliseconds)
			cases.push(badTotal)
		}
		const exceedsElapsedRange = crossing() as any
		exceedsElapsedRange.classification.partitions[1].workingTime = available(40 * minute + 1)
		cases.push(exceedsElapsedRange)
		const badMetricAvailability = crossing() as any
		badMetricAvailability.classification.partitions[1].workingTime.availability = 'ready'
		cases.push(badMetricAvailability)
		const badDisclosureAvailability = crossing() as any
		badDisclosureAvailability.classification.partitions[1].disclosures.availability = 'available'
		cases.push(badDisclosureAvailability)
		for (const candidate of cases) {
			expect(buildAuthorityReportSnapshot(candidate)).toEqual({ ok: false, error: 'invalid_input' })
		}
	})

	test('validates both generic metric snapshots before required-disclosure withholding', () => {
		for (const field of ['workingTime', 'agentRuntime'] as const) {
			for (const milliseconds of [-1, 1.5, 40 * minute + 1]) {
				const input = crossing() as any
				input.classification.partitions[1].disclosures = { availability: 'unavailable' }
				input.classification.partitions[1][field] = available(milliseconds)
				expect(buildAuthorityReportSnapshot(input)).toEqual({ ok: false, error: 'invalid_input' })
			}
		}
	})

	test('fails closed through the codec on unsafe labels and collection limits', () => {
		for (const label of ['', 'x'.repeat(129), 'unsafe\nlabel']) {
			const input = crossing() as any
			input.classification.partitions[1].disclosures.disclosures[0].label = label
			expect(buildAuthorityReportSnapshot(input)).toEqual({ ok: false, error: 'invalid_response' })
		}
		const tooMany = crossing() as any
		tooMany.classification.partitions[1].disclosures.disclosures = Array.from(
			{ length: 65 }, (_, index) => lane(undefined, undefined, `Executor ${index + 1}`),
		)
		expect(buildAuthorityReportSnapshot(tooMany)).toEqual({ ok: false, error: 'invalid_response' })
	})

	test('rejects fractional disclosure timestamps and mismatched discarded lane bounds', () => {
		for (const mutate of [
			(value: any) => { value.capabilityIntervals[0].endMs += 0.5 },
			(value: any) => { value.collectionIntegrity.losses[0].startMs += 0.5 },
			(value: any) => { value.executionClosure.starts[0].startMs += 0.5 },
			(value: any) => { value.endMs -= 1 },
		]) {
			const input = crossing() as any
			mutate(input.classification.partitions[1].disclosures.disclosures[0])
			expect(buildAuthorityReportSnapshot(input)).toEqual({ ok: false, error: 'invalid_response' })
		}
	})

	test('rejects non-array assessment capability lists without rejecting legitimate empty arrays', () => {
		for (const field of ['workingTimeV1', 'agentRuntimeV1'] as const) {
			const input = crossing() as any
			const interval = input.classification.partitions[1].disclosures.disclosures[0].capabilityIntervals[0]
			interval.workingTimeV1 = { status: 'declared_for_scope', missingRecoveryCapabilities: [] }
			interval.agentRuntimeV1 = { status: 'declared_for_scope', missingRecoveryCapabilities: [] }
			interval[field].missingRecoveryCapabilities = ''
			expect(buildAuthorityReportSnapshot(input)).toEqual({ ok: false, error: 'invalid_response' })
		}

		const valid = crossing() as any
		const interval = valid.classification.partitions[1].disclosures.disclosures[0].capabilityIntervals[0]
		interval.workingTimeV1 = { status: 'declared_for_scope', missingRecoveryCapabilities: [] }
		interval.agentRuntimeV1 = { status: 'declared_for_scope', missingRecoveryCapabilities: [] }
		expect(buildAuthorityReportSnapshot(valid).ok).toBe(true)
	})

	test('returns exact codec-accepted frozen-input-safe bytes without aliasing mutable inputs', () => {
		const input = crossing()
		const original = structuredClone(input)
		deepFreeze(input)
		const result = output(input)
		expect(input).toEqual(original)
		expect(decodeAuthorityReportResponse(result.bytes, wireRange())).toEqual({ ok: true, value: result.value })
		const originalLabel = result.value.report.sections[1].disclosures.data.lanes[0].label
		result.value.report.sections[1].disclosures.data.lanes[0].label = 'Changed output'
		expect((input.classification.partitions[1] as any).disclosures.disclosures[0].label).toBe(originalLabel)
		expect(input).toEqual(original)
	})
})
