export const LOCAL_PROTOCOL = 'cukup.experimental.harness-evidence' as const
export const LOCAL_PROTOCOL_VERSION = 1 as const
export const LOCAL_CLOCK_SKEW_MS = 10 * 60 * 1_000

export const CAPABILITIES = [
	'engagement.composition',
	'engagement.submission',
	'engagement.follow_up',
	'engagement.approval',
	'engagement.takeover',
	'execution.segments',
	'recovery.engagement.composition',
	'recovery.engagement.submission',
	'recovery.engagement.follow_up',
	'recovery.engagement.approval',
	'recovery.engagement.takeover',
	'recovery.execution_start.native',
	'recovery.execution_start.current_observation',
	'recovery.execution_end.native',
	'process.lifecycle',
] as const

export type Capability = (typeof CAPABILITIES)[number]
export type EvidenceReason =
	| 'unknown_field'
	| 'prohibited_field'
	| 'invalid_evidence'
	| 'capability_mismatch'
	| 'invalid_timing'
	| 'invalid_order'
	| 'identity_conflict'
export type EnvelopeReason = 'unknown_field' | 'prohibited_field' | 'invalid_envelope'

export type ConformanceResult =
	| { evidence_id: string; status: 'accepted' | 'duplicate' }
	| { evidence_id: string; status: 'conflict'; reason: 'identity_conflict' }
	| { evidence_id: string; status: 'rejected'; reason: EvidenceReason }
	| { scope: 'envelope'; status: 'rejected'; reason: EnvelopeReason }
	| { scope: 'envelope'; status: 'unsupported_version'; reason: 'unsupported_version' }

export type Timing = {
	wall_time: string
	provenance: 'native_occurrence' | 'collector_observation'
	precision_ms: number
}

export type ProjectAttribution =
	| {
			kind: 'cukup_project'
			project_id: string
			basis: 'approved_mapping' | 'explicit_binding'
	  }
	| { kind: 'unassigned'; reason: 'absent' | 'ambiguous' }

export type Engagement = {
	family: 'engagement'
	evidence_id: string
	interaction: 'composition' | 'submission' | 'follow_up' | 'approval' | 'takeover'
	origin: 'human'
	recovered: boolean
	timing: Timing
	project_attribution: ProjectAttribution
}

export type ExecutionStart = {
	family: 'execution_start'
	evidence_id: string
	segment_id: string
	recovered: boolean
	timing: Timing
	project_attribution: ProjectAttribution
}

export type ExecutionEnd = {
	family: 'execution_end'
	evidence_id: string
	segment_id: string
	recovered: boolean
	timing: Timing
}

export type Evidence = Engagement | ExecutionStart | ExecutionEnd

export type NegotiationOffer = {
	protocol: typeof LOCAL_PROTOCOL
	supported_versions: number[]
	collector_instance_id: string
	capabilities: Capability[]
}

export type ParsedNegotiationEnvelope = {
	protocol: typeof LOCAL_PROTOCOL
	supportedVersions: number[]
	collectorInstanceId: string
	readCapabilities: () => unknown
}

export type ParsedEnvelope =
	| {
			collectorInstanceId: string
			protocolVersion: number
			capabilities: Capability[]
			evidence: ParsedEvidence[]
	  }
	| { reason: EnvelopeReason }
	| { unsupported: true }

const CAPABILITY_SET = new Set<string>(CAPABILITIES)
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function isUuidV4(value: string): boolean {
	return UUID_V4.test(value)
}

const ENVELOPE_FIELDS = new Set([
	'protocol',
	'protocol_version',
	'collector_instance_id',
	'capabilities',
	'evidence',
])
const NEGOTIATION_FIELDS = new Set([
	'protocol',
	'supported_versions',
	'collector_instance_id',
	'capabilities',
])
const ENGAGEMENT_FIELDS = new Set([
	'family',
	'evidence_id',
	'interaction',
	'origin',
	'recovered',
	'timing',
	'project_attribution',
])
const EXECUTION_START_FIELDS = new Set([
	'family',
	'evidence_id',
	'segment_id',
	'recovered',
	'timing',
	'project_attribution',
])
const EXECUTION_END_FIELDS = new Set([
	'family',
	'evidence_id',
	'segment_id',
	'recovered',
	'timing',
])
const TIMING_FIELDS = new Set(['wall_time', 'provenance', 'precision_ms'])
const PROJECT_FIELDS = new Set(['kind', 'project_id', 'basis'])
const UNASSIGNED_FIELDS = new Set(['kind', 'reason'])
const PROHIBITED_FIELDS = new Set([
	'metadata',
	'prompt',
	'output',
	'command',
	'path',
	'repository',
	'repo',
	'credential',
	'token',
	'native_id',
	'native_route',
	'cursor',
	'native_project_key',
	'payload',
	'model',
	'provider',
])

/** Selects the greatest receiver-supported version offered by the collector. */
export function negotiateVersion(
	offered: readonly number[],
	receiverSupported: readonly number[] = [LOCAL_PROTOCOL_VERSION],
): number | undefined {
	if (!isVersionDeclaration(offered)) return undefined
	const supported = new Set(receiverSupported)
	return [...offered].sort((a, b) => b - a).find((version) => supported.has(version))
}

/** Parses the same closed capability declaration used by evidence envelopes. */
export function parseNegotiationOffer(value: unknown): NegotiationOffer | undefined {
	const envelope = parseNegotiationEnvelope(value)
	if (envelope === undefined) return undefined
	return parseVersion1NegotiationOffer(envelope)
}

/** Parses only version-independent negotiation fields without reading version-specific capabilities. */
export function parseNegotiationEnvelope(value: unknown): ParsedNegotiationEnvelope | undefined {
	if (
		!isRecord(value) ||
		unknownKeys(value, NEGOTIATION_FIELDS).length > 0 ||
		Object.keys(value).length !== NEGOTIATION_FIELDS.size
	) {
		return undefined
	}
	if (
		value.protocol !== LOCAL_PROTOCOL ||
		!Array.isArray(value.supported_versions) ||
		!isVersionDeclaration(value.supported_versions) ||
		typeof value.collector_instance_id !== 'string' ||
		!UUID_V4.test(value.collector_instance_id)
	) {
		return undefined
	}
	return {
		protocol: LOCAL_PROTOCOL,
		supportedVersions: value.supported_versions,
		collectorInstanceId: value.collector_instance_id,
		readCapabilities: () => value.capabilities,
	}
}

/** Validates the version 1 capability declaration after version 1 has been selected. */
export function parseVersion1NegotiationOffer(
	envelope: ParsedNegotiationEnvelope,
): NegotiationOffer | undefined {
	const capabilities = envelope.readCapabilities()
	if (!isCapabilityDeclaration(capabilities)) return undefined
	return {
		protocol: envelope.protocol,
		supported_versions: envelope.supportedVersions,
		collector_instance_id: envelope.collectorInstanceId,
		capabilities,
	}
}

function isVersionDeclaration(value: readonly unknown[]): value is number[] {
	return (
		value.length > 0 &&
		value.every((version) => Number.isSafeInteger(version) && (version as number) >= 1) &&
		new Set(value).size === value.length
	)
}

/**
 * Executes message-contract fixtures against an ephemeral accepted-record set. This is not a
 * receiver: callers provide receipt time, and no acknowledgement or state is persisted.
 */
export function validateConformanceDeliveries(
	deliveries: readonly unknown[],
	receivedAt: string,
): ConformanceResult[] {
	const receivedAtMs = parseTime(receivedAt)
	if (receivedAtMs === undefined) throw new Error('invalid conformance receipt time')

	const evidenceById = new Map<string, string>()
	const startsBySegment = new Map<string, number>()
	const endedSegments = new Set<string>()
	const results: ConformanceResult[] = []

	for (const value of deliveries) {
		const envelopeResult = parseEvidenceEnvelope(value, receivedAtMs)
		if ('unsupported' in envelopeResult) {
			results.push({
				scope: 'envelope',
				status: 'unsupported_version',
				reason: 'unsupported_version',
			})
			continue
		}
		if ('reason' in envelopeResult) {
			results.push({ scope: 'envelope', status: 'rejected', reason: envelopeResult.reason })
			continue
		}

		for (const parsed of envelopeResult.evidence) {
			if ('reason' in parsed) {
				results.push({ evidence_id: parsed.evidenceId, status: 'rejected', reason: parsed.reason })
				continue
			}

			const evidence = parsed.value
			const canonical = stableStringify(evidence)
			const existing = evidenceById.get(evidence.evidence_id)
			if (existing !== undefined) {
				results.push(
					existing === canonical
						? { evidence_id: evidence.evidence_id, status: 'duplicate' }
						: {
								evidence_id: evidence.evidence_id,
								status: 'conflict',
								reason: 'identity_conflict',
							},
				)
				continue
			}

			if (evidence.family === 'execution_start') {
				if (startsBySegment.has(evidence.segment_id)) {
					results.push({
						evidence_id: evidence.evidence_id,
						status: 'conflict',
						reason: 'identity_conflict',
					})
					continue
				}
				startsBySegment.set(evidence.segment_id, Date.parse(evidence.timing.wall_time))
			} else if (evidence.family === 'execution_end') {
				const start = startsBySegment.get(evidence.segment_id)
				if (endedSegments.has(evidence.segment_id)) {
					results.push({
						evidence_id: evidence.evidence_id,
						status: 'conflict',
						reason: 'identity_conflict',
					})
					continue
				}
				const endAt = Date.parse(evidence.timing.wall_time)
				if (start === undefined || endAt < start) {
					results.push({
						evidence_id: evidence.evidence_id,
						status: 'rejected',
						reason: 'invalid_order',
					})
					continue
				}
				endedSegments.add(evidence.segment_id)
			}

			evidenceById.set(evidence.evidence_id, canonical)
			results.push({ evidence_id: evidence.evidence_id, status: 'accepted' })
		}
	}

	return results
}

export type ParsedEvidence = { value: Evidence } | { evidenceId: string; reason: EvidenceReason }

/** Parses a supported envelope without retaining unknown or rejected payload fields. */
export function parseEvidenceEnvelope(
	value: unknown,
	receivedAtMs: number,
): ParsedEnvelope {
	if (
		isRecord(value) &&
		Number.isSafeInteger(value.protocol_version) &&
		value.protocol_version !== LOCAL_PROTOCOL_VERSION
	) {
		return { unsupported: true }
	}
	if (!isRecord(value)) return { reason: 'invalid_envelope' }
	if (unknownKeys(value, ENVELOPE_FIELDS).length > 0) {
		return {
			reason: hasProhibitedKey(value, ENVELOPE_FIELDS) ? 'prohibited_field' : 'unknown_field',
		}
	}
	if (
		value.protocol !== LOCAL_PROTOCOL ||
		value.protocol_version !== LOCAL_PROTOCOL_VERSION ||
		typeof value.collector_instance_id !== 'string' ||
		!UUID_V4.test(value.collector_instance_id) ||
		!Array.isArray(value.evidence) ||
		!isCapabilityDeclaration(value.capabilities)
	) {
		return { reason: 'invalid_envelope' }
	}
	const capabilities = new Set(value.capabilities as Capability[])
	return {
		collectorInstanceId: value.collector_instance_id,
		protocolVersion: value.protocol_version,
		capabilities: value.capabilities as Capability[],
		evidence: value.evidence.map((evidence) =>
			parseEvidence(evidence, capabilities, receivedAtMs),
		),
	}
}

function isCapabilityDeclaration(value: unknown): value is Capability[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((capability) => typeof capability === 'string' && CAPABILITY_SET.has(capability)) &&
		new Set(value).size === value.length &&
		!hasRecoveryWithoutBaseCapability(value)
	)
}

function parseEvidence(
	value: unknown,
	capabilities: ReadonlySet<Capability>,
	receivedAtMs: number,
): ParsedEvidence {
	const evidenceId =
		isRecord(value) && typeof value.evidence_id === 'string' && UUID_V4.test(value.evidence_id)
			? value.evidence_id
			: ''
	if (!isRecord(value)) return { evidenceId, reason: 'invalid_evidence' }
	const fields =
		value.family === 'engagement'
			? ENGAGEMENT_FIELDS
			: value.family === 'execution_start'
				? EXECUTION_START_FIELDS
				: value.family === 'execution_end'
					? EXECUTION_END_FIELDS
					: undefined
	if (fields === undefined) return { evidenceId, reason: 'invalid_evidence' }
	if (unknownKeys(value, fields).length > 0) {
		return {
			evidenceId,
			reason: hasProhibitedKey(value, fields) ? 'prohibited_field' : 'unknown_field',
		}
	}
	if (evidenceId === '' || typeof value.recovered !== 'boolean') {
		return { evidenceId, reason: 'invalid_evidence' }
	}
	const timing = parseTiming(value.timing, receivedAtMs)
	if ('reason' in timing) return { evidenceId, reason: timing.reason }

	if (value.family === 'engagement') {
		const interaction = value.interaction
		if (
			!isInteraction(interaction) ||
			value.origin !== 'human' ||
			!capabilities.has(`engagement.${interaction}`)
		) {
			return { evidenceId, reason: 'invalid_evidence' }
		}
		if (
			value.recovered &&
			(timing.value.provenance !== 'native_occurrence' ||
				!capabilities.has(`recovery.engagement.${interaction}`))
		) {
			return {
				evidenceId,
				reason:
					timing.value.provenance === 'native_occurrence'
						? 'capability_mismatch'
						: 'invalid_timing',
			}
		}
		const project = parseProject(value.project_attribution)
		if (project === undefined) return { evidenceId, reason: 'invalid_evidence' }
		return { value: { ...(value as Engagement), timing: timing.value, project_attribution: project } }
	}

	if (
		typeof value.segment_id !== 'string' ||
		!UUID_V4.test(value.segment_id) ||
		!capabilities.has('execution.segments')
	) {
		return { evidenceId, reason: 'capability_mismatch' }
	}
	if (
		value.family === 'execution_end' &&
		value.recovered &&
		timing.value.provenance !== 'native_occurrence'
	) {
		return { evidenceId, reason: 'invalid_timing' }
	}
	if (value.recovered) {
		const recoveryCapability =
			value.family === 'execution_end'
				? 'recovery.execution_end.native'
				: timing.value.provenance === 'native_occurrence'
					? 'recovery.execution_start.native'
					: 'recovery.execution_start.current_observation'
		if (!capabilities.has(recoveryCapability)) {
			return { evidenceId, reason: 'capability_mismatch' }
		}
	}
	if (value.family === 'execution_start') {
		const project = parseProject(value.project_attribution)
		if (project === undefined) return { evidenceId, reason: 'invalid_evidence' }
		return { value: { ...(value as ExecutionStart), timing: timing.value, project_attribution: project } }
	}
	return { value: { ...(value as ExecutionEnd), timing: timing.value } }
}

function parseTiming(
	value: unknown,
	receivedAtMs: number,
): { value: Timing } | { reason: EvidenceReason } {
	if (!isRecord(value) || unknownKeys(value, TIMING_FIELDS).length > 0) {
		return {
			reason:
				isRecord(value) && hasProhibitedKey(value, TIMING_FIELDS)
					? 'prohibited_field'
					: 'invalid_timing',
		}
	}
	if (
		typeof value.wall_time !== 'string' ||
		(value.provenance !== 'native_occurrence' && value.provenance !== 'collector_observation') ||
		!Number.isSafeInteger(value.precision_ms) ||
		(value.precision_ms as number) < 1 ||
		(value.precision_ms as number) > 60_000
	) {
		return { reason: 'invalid_timing' }
	}
	const wallTimeMs = parseTime(value.wall_time)
	if (wallTimeMs === undefined || wallTimeMs > receivedAtMs + LOCAL_CLOCK_SKEW_MS) {
		return { reason: 'invalid_timing' }
	}
	return { value: value as Timing }
}

function parseProject(value: unknown): ProjectAttribution | undefined {
	if (!isRecord(value)) return undefined
	if (value.kind === 'cukup_project') {
		if (
			unknownKeys(value, PROJECT_FIELDS).length > 0 ||
			typeof value.project_id !== 'string' ||
			!UUID_V4.test(value.project_id) ||
			(value.basis !== 'approved_mapping' && value.basis !== 'explicit_binding')
		) {
			return undefined
		}
		return value as ProjectAttribution
	}
	if (
		value.kind === 'unassigned' &&
		unknownKeys(value, UNASSIGNED_FIELDS).length === 0 &&
		(value.reason === 'absent' || value.reason === 'ambiguous')
	) {
		return value as ProjectAttribution
	}
	return undefined
}

function parseTime(value: string): number | undefined {
	if (!UTC_MILLISECONDS.test(value)) return undefined
	const parsed = Date.parse(value)
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined
}

function isInteraction(value: unknown): value is Engagement['interaction'] {
	return (
		value === 'composition' ||
		value === 'submission' ||
		value === 'follow_up' ||
		value === 'approval' ||
		value === 'takeover'
	)
}

function hasRecoveryWithoutBaseCapability(capabilities: unknown[]): boolean {
	return capabilities.some((capability) => {
		if (typeof capability !== 'string') return false
		if (capability.startsWith('recovery.engagement.')) {
			return !capabilities.includes(capability.replace('recovery.', ''))
		}
		return capability.startsWith('recovery.execution_') && !capabilities.includes('execution.segments')
	})
}

function unknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
	return Object.keys(value).filter((key) => !allowed.has(key))
}

function hasProhibitedKey(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return unknownKeys(value, allowed).some((key) => PROHIBITED_FIELDS.has(key))
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
			.join(',')}}`
	}
	return JSON.stringify(value)
}

/** Canonicalizes an already parsed evidence fact for durable immutable comparison. */
export function canonicalizeEvidence(value: Evidence): string {
	return stableStringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
