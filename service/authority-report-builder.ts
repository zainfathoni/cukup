import {
	encodeAuthorityReportResponse,
	type AuthorityRange,
	type AuthorityReportResponse,
} from './authority-report-codec.ts'
import {
	deliverShadowDisclosures,
	type ShadowDisclosureDelivery,
	type ShadowDisclosureLane,
} from './shadow-disclosures.ts'

const MAX_TIME_MS = 253_402_300_799_999
const MAX_RANGE_MS = 31_622_400_000
const MINUTE_MS = 60_000

export type AuthorityReportMillisecondRange = { startMs: number; endMs: number }

export type AuthorityReportMetricSnapshot =
	| { availability: 'available'; globallyUnionedMilliseconds: number }
	| { availability: 'unavailable' }

export type LabeledShadowDisclosureLane = ShadowDisclosureLane & { label: string }
export type AuthorityReportDisclosureDelivery = ShadowDisclosureDelivery<LabeledShadowDisclosureLane>

export type AuthorityReportPartitionSnapshot =
	| {
		authority: 'legacy'
		range: AuthorityReportMillisecondRange
		workingTime: AuthorityReportMetricSnapshot
	}
	| {
		authority: 'generic'
		range: AuthorityReportMillisecondRange
		workingTime: AuthorityReportMetricSnapshot
		agentRuntime: AuthorityReportMetricSnapshot
		disclosures: AuthorityReportDisclosureDelivery
	}

export type AuthorityReportSnapshotInput = {
	range: AuthorityReportMillisecondRange
	classification:
		| {
			authority: 'unresolved'
			mode: null
			cutoverMs: null
			asOfMs: null
			partitions: readonly []
		}
		| {
			authority: 'verified'
			mode: 'legacy'
			cutoverMs: null
			asOfMs: number
			partitions: readonly AuthorityReportPartitionSnapshot[]
		}
		| {
			authority: 'verified'
			mode: 'armed' | 'active'
			cutoverMs: number
			asOfMs: number
			partitions: readonly AuthorityReportPartitionSnapshot[]
		}
}

export type AuthorityReportBuildResult =
	| { ok: true; value: AuthorityReportResponse; bytes: Uint8Array }
	| { ok: false; error: 'invalid_input' | 'invalid_response' | 'payload_too_large' }

/**
 * Pure inactive Stage 5AC boundary. Inputs are one caller-classified snapshot: this function
 * validates their shape but does not prove authority, freshness, clipping, unioning, or current use.
 */
export function buildAuthorityReportSnapshot(input: AuthorityReportSnapshotInput): AuthorityReportBuildResult {
	if (!isObject(input)) return { ok: false, error: 'invalid_input' }
	const range = readRange(input.range)
	if (!range) return { ok: false, error: 'invalid_input' }
	const admittedRange = wireRange(range)
	const classification = input.classification
	if (!isObject(classification)) return { ok: false, error: 'invalid_input' }
	if (classification.authority === 'unresolved') {
		if (classification.mode !== null || classification.cutoverMs !== null ||
			classification.asOfMs !== null || !Array.isArray(classification.partitions)) {
			return { ok: false, error: 'invalid_input' }
		}
		return encode({
			transport_version: 1,
			validity: { current_use: 'forbidden', valid_until: null, proof: null },
			report: {
				contract_version: 1,
				timezone: 'Asia/Jakarta',
				range: admittedRange,
				as_of: null,
				authority: 'unresolved',
				cutover: null,
				delivery: 'unavailable',
				reason: 'authority_unavailable',
				sections: [],
			},
		}, admittedRange)
	}

	if (classification.authority !== 'verified' || !Array.isArray(classification.partitions)) {
		return { ok: false, error: 'invalid_input' }
	}
	if (!validInstant(classification.asOfMs)) return { ok: false, error: 'invalid_input' }
	if (classification.mode !== 'legacy' && classification.mode !== 'armed' && classification.mode !== 'active') {
		return { ok: false, error: 'invalid_input' }
	}
	const expected = expectedPartitions(range, classification.mode, classification.cutoverMs)
	if (!expected || classification.partitions.length !== expected.length) {
		return { ok: false, error: 'invalid_input' }
	}

	try {
		const sections: unknown[] = []
		for (let index = 0; index < expected.length; index++) {
			const specification = expected[index]!
			const partition = classification.partitions[index]
			if (!isObject(partition) || partition.authority !== specification.authority ||
				!sameRange(partition.range, specification.range)) {
				return { ok: false, error: 'invalid_input' }
			}
			const elapsedMilliseconds = Math.max(
				0,
				Math.min(specification.range.endMs, classification.asOfMs) - specification.range.startMs,
			)
			const elapsed = elapsedMilliseconds > 0
			if (partition.authority === 'legacy') {
				const workingTime = metric(partition.workingTime, 'legacy_working_time', elapsedMilliseconds)
				if (!workingTime) return { ok: false, error: 'invalid_input' }
				sections.push({
					authority: 'legacy',
					range: wireRange(specification.range),
					working_time: workingTime,
				})
				continue
			}

			const classifiedWorkingTime = metric(
				partition.workingTime, 'working_time_estimated', elapsedMilliseconds,
			)
			const classifiedAgentRuntime = metric(
				partition.agentRuntime, 'agent_runtime', elapsedMilliseconds,
			)
			const disclosureDelivery = readDisclosureDelivery(partition.disclosures)
			if (!classifiedWorkingTime || !classifiedAgentRuntime || !disclosureDelivery) {
				return { ok: false, error: 'invalid_input' }
			}
			const availableDisclosures = disclosureDelivery.availability === 'unavailable'
				? undefined : disclosureDelivery
			const disclosuresAvailable = availableDisclosures !== undefined
			if ((!elapsed && (classifiedWorkingTime.state !== 'unavailable' ||
				classifiedAgentRuntime.state !== 'unavailable' || disclosuresAvailable)) ||
				(classification.mode === 'armed' && (classifiedWorkingTime.state !== 'unavailable' ||
					classifiedAgentRuntime.state !== 'unavailable' || disclosuresAvailable))) {
				return { ok: false, error: 'invalid_input' }
			}
			const requiredDisclosuresAvailable = elapsed && classification.mode === 'active' && disclosuresAvailable
			const workingTime = requiredDisclosuresAvailable ? classifiedWorkingTime
				: unavailableMetric('working_time_estimated', elapsed)
			const agentRuntime = requiredDisclosuresAvailable ? classifiedAgentRuntime
				: unavailableMetric('agent_runtime', elapsed)
			sections.push({
				authority: 'generic',
				range: wireRange(specification.range),
				working_time: workingTime,
				agent_runtime: agentRuntime,
				disclosures: requiredDisclosuresAvailable
					? staleDisclosures(availableDisclosures!, specification.range, classification.asOfMs)
					: { state: 'unavailable', reason: elapsed ? 'report_unavailable' : 'not_started' },
			})
		}

		const hasData = sections.some((section) => {
			const value = section as { working_time: { state: string }; agent_runtime?: { state: string } }
			return value.working_time.state === 'stale' || value.agent_runtime?.state === 'stale'
		})
		return encode({
			transport_version: 1,
			validity: { current_use: 'forbidden', valid_until: null, proof: null },
			report: {
				contract_version: 1,
				timezone: 'Asia/Jakarta',
				range: admittedRange,
				as_of: timestamp(classification.asOfMs),
				authority: 'verified',
				cutover: classification.cutoverMs === null ? null : timestamp(classification.cutoverMs),
				delivery: hasData ? 'snapshot' : 'unavailable',
				reason: hasData ? 'refresh_required' : 'report_unavailable',
				sections,
			},
		}, admittedRange)
	} catch {
		return { ok: false, error: 'invalid_input' }
	}
}

function expectedPartitions(
	range: AuthorityReportMillisecondRange,
	mode: 'legacy' | 'armed' | 'active',
	cutoverMs: number | null,
): Array<{ authority: 'legacy' | 'generic'; range: AuthorityReportMillisecondRange }> | undefined {
	if (mode === 'legacy') return cutoverMs === null ? [{ authority: 'legacy', range }] : undefined
	if (cutoverMs === null || !validInstant(cutoverMs) || !isJakartaMondayMidnight(cutoverMs)) return undefined
	const partitions: Array<{ authority: 'legacy' | 'generic'; range: AuthorityReportMillisecondRange }> = []
	if (range.startMs < cutoverMs) partitions.push({
		authority: 'legacy', range: { startMs: range.startMs, endMs: Math.min(range.endMs, cutoverMs) },
	})
	if (range.endMs > cutoverMs) partitions.push({
		authority: 'generic', range: { startMs: Math.max(range.startMs, cutoverMs), endMs: range.endMs },
	})
	return partitions
}

function metric(
	snapshot: unknown,
	name: 'legacy_working_time' | 'working_time_estimated' | 'agent_runtime',
	elapsedMilliseconds: number,
): Record<string, unknown> | undefined {
	if (!isObject(snapshot) ||
		(snapshot.availability !== 'available' && snapshot.availability !== 'unavailable')) return undefined
	if (elapsedMilliseconds === 0) {
		return snapshot.availability === 'unavailable'
			? unavailableMetric(name, false)
			: undefined
	}
	if (snapshot.availability === 'unavailable') {
		return unavailableMetric(name, true)
	}
	const milliseconds = snapshot.globallyUnionedMilliseconds
	if (typeof milliseconds !== 'number' || !Number.isSafeInteger(milliseconds) ||
		milliseconds < 0 || milliseconds > elapsedMilliseconds) return undefined
	return {
		metric: name,
		state: 'stale',
		reason: 'refresh_required',
		data: { observed_minutes: Math.floor(milliseconds / MINUTE_MS), target: 'none' },
	}
}

function unavailableMetric(
	name: 'legacy_working_time' | 'working_time_estimated' | 'agent_runtime',
	elapsed: boolean,
): Record<string, unknown> {
	return { metric: name, state: 'unavailable', reason: elapsed ? 'report_unavailable' : 'not_started' }
}

function readDisclosureDelivery(value: unknown): AuthorityReportDisclosureDelivery | undefined {
	if (!isObject(value)) return undefined
	if (value.availability === 'unavailable') return { availability: 'unavailable' }
	if ((value.availability !== 'ready' && value.availability !== 'stale') || !Array.isArray(value.disclosures)) {
		return undefined
	}
	return value as AuthorityReportDisclosureDelivery
}

function staleDisclosures(
	delivery: { availability: 'ready' | 'stale'; disclosures: LabeledShadowDisclosureLane[] },
	range: AuthorityReportMillisecondRange,
	asOfMs: number,
): unknown {
	const endMs = Math.min(range.endMs, asOfMs)
	if (!withinDisclosureLimits(delivery.disclosures, range.startMs, endMs)) return { state: 'invalid' }
	const stale = deliverShadowDisclosures('stale', delivery.disclosures)
	if (stale.availability === 'unavailable') throw new Error('Stale disclosure delivery unavailable')
	return {
		state: 'stale',
		reason: 'refresh_required',
		data: {
			start: timestamp(range.startMs),
			end: timestamp(endMs),
			lanes: stale.disclosures.map((lane) => ({
				label: lane.label,
				capability_intervals: lane.capabilityIntervals.map((interval) => ({
					start: timestamp(interval.startMs),
					end: timestamp(interval.endMs),
					working_time_v1: assessment(interval.workingTimeV1),
					agent_runtime_v1: assessment(interval.agentRuntimeV1),
				})),
				known_losses: lane.collectionIntegrity.losses.map((loss) => ({
					start: timestamp(loss.startMs),
					end: timestamp(loss.endMs),
					capabilities: [...loss.capabilities],
					reason: loss.reason,
				})),
				pending_execution: {
					status: lane.executionClosure.status,
					started_at: lane.executionClosure.starts.map((start) => timestamp(start.startMs)),
				},
				synchronization: lane.synchronization,
			})),
		},
	}
}

function withinDisclosureLimits(
	disclosures: readonly LabeledShadowDisclosureLane[],
	startMs: number,
	endMs: number,
): boolean {
	return disclosures.length <= 64 && disclosures.every((lane) =>
		validInstant(lane.startMs) && validInstant(lane.endMs) &&
		lane.startMs === startMs && lane.endMs === endMs &&
		lane.capabilityIntervals.length <= 128 &&
		lane.collectionIntegrity.losses.length <= 128 &&
		lane.executionClosure.starts.length <= 128 &&
		lane.capabilityIntervals.every((interval) => validInstant(interval.startMs) &&
			validInstant(interval.endMs) &&
			assessmentWithinLimits(interval.workingTimeV1)) &&
		lane.capabilityIntervals.every((interval) => validInstant(interval.startMs) &&
			validInstant(interval.endMs) &&
			assessmentWithinLimits(interval.agentRuntimeV1)) &&
		lane.collectionIntegrity.losses.every((loss) => validInstant(loss.startMs) &&
			validInstant(loss.endMs) && loss.capabilities.length <= 15) &&
		lane.executionClosure.starts.every((start) => validInstant(start.startMs)))
}

function assessmentWithinLimits(value: unknown): boolean {
	if (!isObject(value)) return false
	if (value.status === 'unknown') return true
	if (value.status === 'declared_for_scope') {
		return Array.isArray(value.missingRecoveryCapabilities) && value.missingRecoveryCapabilities.length <= 15
	}
	return value.status === 'declared_limited' && Array.isArray(value.missingCapabilities) &&
		value.missingCapabilities.length <= 15 && Array.isArray(value.missingRecoveryCapabilities) &&
		value.missingRecoveryCapabilities.length <= 15
}

function assessment(
	value: ShadowDisclosureLane['capabilityIntervals'][number]['workingTimeV1'],
): unknown {
	if (value.status === 'unknown') return { status: 'unknown' }
	if (value.status === 'declared_for_scope') return {
		status: value.status,
		missing_recovery_capabilities: [...value.missingRecoveryCapabilities],
	}
	return {
		status: value.status,
		missing_capabilities: [...value.missingCapabilities],
		missing_recovery_capabilities: [...value.missingRecoveryCapabilities],
	}
}

function encode(value: unknown, admittedRange: AuthorityRange): AuthorityReportBuildResult {
	const encoded = encodeAuthorityReportResponse(value, admittedRange)
	if (!encoded.ok) return { ok: false, error: encoded.error }
	return { ok: true, value: JSON.parse(new TextDecoder().decode(encoded.bytes)), bytes: encoded.bytes }
}

function readRange(value: unknown): AuthorityReportMillisecondRange | undefined {
	if (!isObject(value)) return undefined
	return validInstant(value.startMs) && validInstant(value.endMs) && value.startMs < value.endMs &&
		value.endMs - value.startMs <= MAX_RANGE_MS ? { startMs: value.startMs, endMs: value.endMs } : undefined
}

function sameRange(left: unknown, right: AuthorityReportMillisecondRange): boolean {
	return isObject(left) && left.startMs === right.startMs && left.endMs === right.endMs
}

function wireRange(range: AuthorityReportMillisecondRange): AuthorityRange {
	return { start: timestamp(range.startMs), end: timestamp(range.endMs) }
}

function timestamp(value: number): string {
	if (!validInstant(value)) throw new Error('Invalid timestamp')
	return new Date(value).toISOString()
}

function validInstant(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_TIME_MS
}

function isJakartaMondayMidnight(value: number): boolean {
	const date = new Date(value)
	return date.getUTCDay() === 0 && date.getUTCHours() === 17 && date.getUTCMinutes() === 0 &&
		date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
