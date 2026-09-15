export const AUTHORITY_REPORT_REQUEST_MAX_BYTES = 1_024
export const AUTHORITY_REPORT_RESPONSE_MAX_BYTES = 262_144

const CAPABILITIES = [
	'engagement.composition', 'engagement.submission', 'engagement.follow_up',
	'engagement.approval', 'engagement.takeover', 'execution.segments',
	'recovery.engagement.composition', 'recovery.engagement.submission',
	'recovery.engagement.follow_up', 'recovery.engagement.approval',
	'recovery.engagement.takeover', 'recovery.execution_start.native',
	'recovery.execution_start.current_observation', 'recovery.execution_end.native',
	'process.lifecycle',
] as const
const LOSS_REASONS = [
	'storage_exhaustion', 'source_without_replay', 'abrupt_termination',
	'operator_discard', 'unspecified',
] as const
type Capability = (typeof CAPABILITIES)[number]

const MAX_TIME = 253_402_300_799_999
const MAX_RANGE_MS = 31_622_400_000
const MAX_DEPTH = 16
const MAX_ARRAY_LENGTH = 128
const MAX_KEY_BYTES = 64
const MAX_STRING_BYTES = 128
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const textEncoder = new TextEncoder()
const capabilitySet = new Set<string>(CAPABILITIES)
const lossReasonSet = new Set<string>(LOSS_REASONS)

const workingCapabilities = new Set<string>([
	'engagement.composition', 'engagement.submission', 'engagement.follow_up',
	'engagement.approval', 'engagement.takeover',
])
const workingRecoveryCapabilities = new Set<string>([
	'recovery.engagement.composition', 'recovery.engagement.submission',
	'recovery.engagement.follow_up', 'recovery.engagement.approval',
	'recovery.engagement.takeover',
])
const runtimeCapabilities = new Set<string>(['execution.segments'])
const runtimeRecoveryCapabilities = new Set<string>([
	'recovery.execution_start.native', 'recovery.execution_start.current_observation',
	'recovery.execution_end.native',
])

export type AuthorityRange = { start: string; end: string }
export type AuthorityReportRequest = { transport_version: 1; range: AuthorityRange }

type Assessment =
	| { status: 'unknown' }
	| { status: 'declared_for_scope'; missing_recovery_capabilities: Capability[] }
	| {
		status: 'declared_limited'
		missing_capabilities: Capability[]
		missing_recovery_capabilities: Capability[]
	}

type Metric =
	| {
		metric: 'legacy_working_time' | 'working_time_estimated' | 'agent_runtime'
		state: 'stale'
		reason: 'refresh_required'
		data: { observed_minutes: number; target: 'none' }
	}
	| {
		metric: 'legacy_working_time' | 'working_time_estimated' | 'agent_runtime'
		state: 'unavailable'
		reason: 'report_unavailable' | 'not_started'
	}

type DisclosureLane = {
	label: string
	capability_intervals: Array<{
		start: string
		end: string
		working_time_v1: Assessment
		agent_runtime_v1: Assessment
	}>
	known_losses: Array<{
		start: string
		end: string
		capabilities: Capability[]
		reason: (typeof LOSS_REASONS)[number]
	}>
	pending_execution: { status: 'none_pending' | 'pending'; started_at: string[] }
	synchronization: 'unknown'
}

type Disclosures =
	| {
		state: 'stale'
		reason: 'refresh_required'
		data: { start: string; end: string; lanes: DisclosureLane[] }
	}
	| { state: 'unavailable'; reason: 'report_unavailable' | 'not_started' }

type LegacySection = {
	authority: 'legacy'
	range: AuthorityRange
	working_time: Metric
}
type GenericSection = {
	authority: 'generic'
	range: AuthorityRange
	working_time: Metric
	agent_runtime: Metric
	disclosures: Disclosures
}
type Section = LegacySection | GenericSection

type AuthorityReport =
	| {
		contract_version: 1
		timezone: 'Asia/Jakarta'
		range: AuthorityRange
		as_of: null
		authority: 'unresolved'
		cutover: null
		delivery: 'unavailable'
		reason: 'authority_unavailable'
		sections: []
	}
	| {
		contract_version: 1
		timezone: 'Asia/Jakarta'
		range: AuthorityRange
		as_of: string
		authority: 'verified'
		cutover: string | null
		delivery: 'snapshot' | 'unavailable'
		reason: 'refresh_required' | 'report_unavailable'
		sections: Section[]
	}

export type AuthorityReportResponse = {
	transport_version: 1
	validity: { current_use: 'forbidden'; valid_until: null; proof: null }
	report: AuthorityReport
}

export type AuthorityReportRequestDecodeResult =
	| { ok: true; value: AuthorityReportRequest }
	| { ok: false; error: 'payload_too_large' | 'invalid_request' | 'unsupported_version' }

export type AuthorityReportResponseCodecResult =
	| { ok: true; value: AuthorityReportResponse }
	| { ok: false; error: 'payload_too_large' | 'invalid_response' }

export type AuthorityReportEncodeResult =
	| { ok: true; bytes: Uint8Array }
	| { ok: false; error: 'payload_too_large' | 'invalid_response' }

/** Token-only conformance/final-byte check; semantic admission still requires a typed decoder. */
export function hasStrictAuthorityReportJsonSyntax(bytes: Uint8Array): boolean {
	return bytes.byteLength <= AUTHORITY_REPORT_RESPONSE_MAX_BYTES && parseStrictJson(bytes) !== undefined
}

export function decodeAuthorityReportRequest(bytes: Uint8Array): AuthorityReportRequestDecodeResult {
	if (bytes.byteLength > AUTHORITY_REPORT_REQUEST_MAX_BYTES) {
		return { ok: false, error: 'payload_too_large' }
	}
	const value = parseStrictJson(bytes)
	if (!value || !exactObject(value, ['transport_version', 'range'])) {
		return { ok: false, error: 'invalid_request' }
	}
	const range = readRange(value.range, MAX_RANGE_MS)
	if (!range || !positiveSafeInteger(value.transport_version)) {
		return { ok: false, error: 'invalid_request' }
	}
	if (value.transport_version !== 1) return { ok: false, error: 'unsupported_version' }
	return { ok: true, value: { transport_version: 1, range } }
}

export function decodeAuthorityReportResponse(
	bytes: Uint8Array,
	admittedRange: AuthorityRange,
): AuthorityReportResponseCodecResult {
	if (bytes.byteLength > AUTHORITY_REPORT_RESPONSE_MAX_BYTES) {
		return { ok: false, error: 'payload_too_large' }
	}
	const value = parseStrictJson(bytes)
	const response = value === undefined ? undefined : readResponse(value, admittedRange)
	return response ? { ok: true, value: response } : { ok: false, error: 'invalid_response' }
}

export function encodeAuthorityReportResponse(
	value: unknown,
	admittedRange: AuthorityRange,
): AuthorityReportEncodeResult {
	const response = readResponse(value, admittedRange)
	if (!response) return { ok: false, error: 'invalid_response' }
	const bytes = textEncoder.encode(JSON.stringify(response))
	return bytes.byteLength <= AUTHORITY_REPORT_RESPONSE_MAX_BYTES
		? { ok: true, bytes }
		: { ok: false, error: 'payload_too_large' }
}

function readResponse(value: unknown, admittedRange: AuthorityRange): AuthorityReportResponse | undefined {
	const canonicalRange = readRange(admittedRange, MAX_RANGE_MS)
	if (!canonicalRange || !exactObject(value, ['transport_version', 'validity', 'report']) ||
		value.transport_version !== 1 || !exactObject(value.validity, ['current_use', 'valid_until', 'proof']) ||
		value.validity.current_use !== 'forbidden' || value.validity.valid_until !== null ||
		value.validity.proof !== null) return undefined
	const report = readReport(value.report, canonicalRange)
	if (!report) return undefined
	return {
		transport_version: 1,
		validity: { current_use: 'forbidden', valid_until: null, proof: null },
		report,
	}
}

function readReport(value: unknown, admittedRange: AuthorityRange): AuthorityReport | undefined {
	const fields = ['contract_version', 'timezone', 'range', 'as_of', 'authority', 'cutover',
		'delivery', 'reason', 'sections']
	if (!exactObject(value, fields) || value.contract_version !== 1 ||
		value.timezone !== 'Asia/Jakarta' || !sameRange(value.range, admittedRange) ||
		!Array.isArray(value.sections) || value.sections.length > 2) return undefined
	if (value.authority === 'unresolved') {
		if (value.as_of !== null || value.cutover !== null || value.delivery !== 'unavailable' ||
			value.reason !== 'authority_unavailable' || value.sections.length !== 0) return undefined
		return {
			contract_version: 1, timezone: 'Asia/Jakarta', range: { ...admittedRange }, as_of: null,
			authority: 'unresolved', cutover: null, delivery: 'unavailable',
			reason: 'authority_unavailable', sections: [],
		}
	}
	if (value.authority !== 'verified' || typeof value.as_of !== 'string' ||
		canonicalTimestamp(value.as_of) === undefined ||
		(value.cutover !== null && (typeof value.cutover !== 'string' || !isJakartaMondayMidnight(value.cutover)))) {
		return undefined
	}
	if ((value.delivery !== 'snapshot' && value.delivery !== 'unavailable') ||
		(value.delivery === 'snapshot' ? value.reason !== 'refresh_required' : value.reason !== 'report_unavailable')) {
		return undefined
	}
	const expected = expectedSections(admittedRange, value.cutover as string | null)
	if (value.sections.length !== expected.length) return undefined
	const sections: Section[] = []
	let staleMetrics = 0
	for (let index = 0; index < expected.length; index++) {
		const specification = expected[index]!
		const section = readSection(value.sections[index], specification.authority, specification.range, value.as_of)
		if (!section) return undefined
		sections.push(section)
		staleMetrics += section.working_time.state === 'stale' ? 1 : 0
		if (section.authority === 'generic' && section.agent_runtime.state === 'stale') staleMetrics++
	}
	if ((value.delivery === 'snapshot') !== (staleMetrics > 0)) return undefined
	return {
		contract_version: 1, timezone: 'Asia/Jakarta', range: { ...admittedRange }, as_of: value.as_of,
		authority: 'verified', cutover: value.cutover as string | null,
		delivery: value.delivery, reason: value.reason as 'refresh_required' | 'report_unavailable', sections,
	}
}

function readSection(
	value: unknown,
	authority: 'legacy' | 'generic',
	range: AuthorityRange,
	asOf: string,
): Section | undefined {
	const fields = authority === 'legacy'
		? ['authority', 'range', 'working_time']
		: ['authority', 'range', 'working_time', 'agent_runtime', 'disclosures']
	if (!exactObject(value, fields) || value.authority !== authority || !sameRange(value.range, range)) {
		return undefined
	}
	const workingMetric = authority === 'legacy' ? 'legacy_working_time' : 'working_time_estimated'
	const working_time = readMetric(value.working_time, workingMetric, range, asOf)
	if (!working_time) return undefined
	if (authority === 'legacy') return { authority, range: { ...range }, working_time }
	const agent_runtime = readMetric(value.agent_runtime, 'agent_runtime', range, asOf)
	const disclosures = readDisclosures(value.disclosures, range, asOf)
	if (!agent_runtime || !disclosures) return undefined
	if (disclosures.state === 'unavailable' &&
		(working_time.state !== 'unavailable' || agent_runtime.state !== 'unavailable')) return undefined
	return { authority, range: { ...range }, working_time, agent_runtime, disclosures }
}

function readMetric(
	value: unknown,
	metric: Metric['metric'],
	range: AuthorityRange,
	asOf: string,
): Metric | undefined {
	if (!isObject(value) || value.metric !== metric) return undefined
	if (value.state === 'stale') {
		if (!exactObject(value, ['metric', 'state', 'reason', 'data']) ||
			value.reason !== 'refresh_required' || !exactObject(value.data, ['observed_minutes', 'target']) ||
			!nonnegativeSafeInteger(value.data.observed_minutes) || value.data.target !== 'none' ||
			canonicalTimestamp(range.start)! >= canonicalTimestamp(asOf)!) return undefined
		return { metric, state: 'stale', reason: 'refresh_required',
			data: { observed_minutes: value.data.observed_minutes, target: 'none' } }
	}
	if (value.state !== 'unavailable' || !exactObject(value, ['metric', 'state', 'reason']) ||
		(value.reason !== 'report_unavailable' && value.reason !== 'not_started') ||
		value.reason !== unavailableReason(range, asOf)) {
		return undefined
	}
	return { metric, state: 'unavailable', reason: value.reason }
}

function readDisclosures(value: unknown, range: AuthorityRange, asOf: string): Disclosures | undefined {
	if (!isObject(value)) return undefined
	if (value.state === 'unavailable') {
		if (!exactObject(value, ['state', 'reason']) ||
			(value.reason !== 'report_unavailable' && value.reason !== 'not_started') ||
			value.reason !== unavailableReason(range, asOf)) {
			return undefined
		}
		return { state: 'unavailable', reason: value.reason }
	}
	if (value.state !== 'stale' || !exactObject(value, ['state', 'reason', 'data']) ||
		value.reason !== 'refresh_required' || !exactObject(value.data, ['start', 'end', 'lanes'])) {
		return undefined
	}
	const elapsedEndMs = Math.min(canonicalTimestamp(range.end)!, canonicalTimestamp(asOf)!)
	if (elapsedEndMs <= canonicalTimestamp(range.start)! || value.data.start !== range.start ||
		value.data.end !== new Date(elapsedEndMs).toISOString() || !Array.isArray(value.data.lanes) ||
		value.data.lanes.length > 64) return undefined
	const lanes: DisclosureLane[] = []
	const labels = new Set<string>()
	const disclosureRange = { start: range.start, end: value.data.end as string }
	for (const candidate of value.data.lanes) {
		const lane = readLane(candidate, disclosureRange)
		if (!lane || labels.has(lane.label)) return undefined
		labels.add(lane.label)
		lanes.push(lane)
	}
	return { state: 'stale', reason: 'refresh_required',
		data: { start: range.start, end: disclosureRange.end, lanes } }
}

function readLane(value: unknown, range: AuthorityRange): DisclosureLane | undefined {
	if (!exactObject(value, ['label', 'capability_intervals', 'known_losses', 'pending_execution', 'synchronization']) ||
		typeof value.label !== 'string' || !validLabel(value.label) ||
		!Array.isArray(value.capability_intervals) || value.capability_intervals.length > 128 ||
		!Array.isArray(value.known_losses) || value.known_losses.length > 128 ||
		value.synchronization !== 'unknown') return undefined
	const capability_intervals: DisclosureLane['capability_intervals'] = []
	let nextStart = range.start
	let declarationSeen = false
	for (const candidate of value.capability_intervals) {
		if (!exactObject(candidate, ['start', 'end', 'working_time_v1', 'agent_runtime_v1']) ||
			typeof candidate.start !== 'string' || typeof candidate.end !== 'string' ||
			candidate.start !== nextStart || !intervalWithin(candidate.start, candidate.end, range)) return undefined
		const working_time_v1 = readAssessment(candidate.working_time_v1, workingCapabilities, workingRecoveryCapabilities)
		const agent_runtime_v1 = readAssessment(candidate.agent_runtime_v1, runtimeCapabilities, runtimeRecoveryCapabilities)
		if (!working_time_v1 || !agent_runtime_v1 ||
			(working_time_v1.status === 'unknown') !== (agent_runtime_v1.status === 'unknown')) return undefined
		if (working_time_v1.status === 'unknown') {
			if (declarationSeen) return undefined
		} else declarationSeen = true
		capability_intervals.push({ start: candidate.start, end: candidate.end,
			working_time_v1, agent_runtime_v1 })
		nextStart = candidate.end
	}
	if (capability_intervals.length === 0 || nextStart !== range.end) return undefined
	const known_losses: DisclosureLane['known_losses'] = []
	for (const candidate of value.known_losses) {
		if (!exactObject(candidate, ['start', 'end', 'capabilities', 'reason']) ||
			typeof candidate.start !== 'string' || typeof candidate.end !== 'string' ||
			!intervalWithin(candidate.start, candidate.end, range) ||
			!lossReasonSet.has(candidate.reason as string)) return undefined
		const capabilities = readCapabilities(candidate.capabilities, capabilitySet, true)
		if (!capabilities) return undefined
		known_losses.push({ start: candidate.start, end: candidate.end, capabilities,
			reason: candidate.reason as (typeof LOSS_REASONS)[number] })
	}
	const pending_execution = readPending(value.pending_execution, range)
	if (!pending_execution) return undefined
	return { label: value.label, capability_intervals, known_losses, pending_execution, synchronization: 'unknown' }
}

function readAssessment(
	value: unknown,
	base: ReadonlySet<string>,
	recovery: ReadonlySet<string>,
): Assessment | undefined {
	if (!isObject(value)) return undefined
	if (value.status === 'unknown') return exactObject(value, ['status']) ? { status: 'unknown' } : undefined
	if (value.status === 'declared_for_scope') {
		if (!exactObject(value, ['status', 'missing_recovery_capabilities'])) return undefined
		const missing = readCapabilities(value.missing_recovery_capabilities, recovery, false)
		return missing ? { status: 'declared_for_scope', missing_recovery_capabilities: missing } : undefined
	}
	if (value.status !== 'declared_limited' ||
		!exactObject(value, ['status', 'missing_capabilities', 'missing_recovery_capabilities'])) return undefined
	const missing = readCapabilities(value.missing_capabilities, base, true)
	const missingRecovery = readCapabilities(value.missing_recovery_capabilities, recovery, false)
	if (!missing || !missingRecovery) return undefined
	const missingRecoverySet = new Set<string>(missingRecovery)
	for (const capability of missing) {
		if (capability === 'execution.segments') {
			if ([...recovery].some((required) => !missingRecoverySet.has(required))) return undefined
		} else if (!missingRecoverySet.has(`recovery.${capability}`)) return undefined
	}
	return { status: 'declared_limited', missing_capabilities: missing,
		missing_recovery_capabilities: missingRecovery }
}

function readCapabilities(value: unknown, allowed: ReadonlySet<string>, nonempty: boolean): Capability[] | undefined {
	if (!Array.isArray(value) || value.length > 15 || (nonempty && value.length === 0)) return undefined
	const seen = new Set<string>()
	for (const capability of value) {
		if (typeof capability !== 'string' || !allowed.has(capability) || seen.has(capability)) return undefined
		seen.add(capability)
	}
	return [...value] as Capability[]
}

function readPending(value: unknown, range: AuthorityRange): DisclosureLane['pending_execution'] | undefined {
	if (!exactObject(value, ['status', 'started_at']) || !Array.isArray(value.started_at) ||
		value.started_at.length > 128 || (value.status !== 'none_pending' && value.status !== 'pending') ||
		(value.status === 'none_pending' ? value.started_at.length !== 0 : value.started_at.length === 0)) {
		return undefined
	}
	const startMs = canonicalTimestamp(range.start)!
	const endMs = canonicalTimestamp(range.end)!
	for (const startedAt of value.started_at) {
		if (typeof startedAt !== 'string') return undefined
		const time = canonicalTimestamp(startedAt)
		if (time === undefined || time < startMs || time >= endMs) return undefined
	}
	return { status: value.status, started_at: [...value.started_at] as string[] }
}

function expectedSections(range: AuthorityRange, cutover: string | null): Array<{
	authority: 'legacy' | 'generic'; range: AuthorityRange
}> {
	if (cutover === null) return [{ authority: 'legacy', range: { ...range } }]
	const start = canonicalTimestamp(range.start)!
	const end = canonicalTimestamp(range.end)!
	const boundary = canonicalTimestamp(cutover)!
	const sections: Array<{ authority: 'legacy' | 'generic'; range: AuthorityRange }> = []
	if (start < boundary) sections.push({ authority: 'legacy',
		range: { start: range.start, end: new Date(Math.min(end, boundary)).toISOString() } })
	if (end > boundary) sections.push({ authority: 'generic',
		range: { start: new Date(Math.max(start, boundary)).toISOString(), end: range.end } })
	return sections
}

function readRange(value: unknown, maxSpan = Number.POSITIVE_INFINITY): AuthorityRange | undefined {
	if (!exactObject(value, ['start', 'end']) || typeof value.start !== 'string' || typeof value.end !== 'string') {
		return undefined
	}
	const start = canonicalTimestamp(value.start)
	const end = canonicalTimestamp(value.end)
	return start !== undefined && end !== undefined && start < end && end - start <= maxSpan
		? { start: value.start, end: value.end }
		: undefined
}

function sameRange(value: unknown, expected: AuthorityRange): boolean {
	return exactObject(value, ['start', 'end']) && value.start === expected.start && value.end === expected.end
}

function intervalWithin(start: unknown, end: unknown, range: AuthorityRange): start is string {
	if (typeof start !== 'string' || typeof end !== 'string') return false
	const startMs = canonicalTimestamp(start)
	const endMs = canonicalTimestamp(end)
	return startMs !== undefined && endMs !== undefined && startMs < endMs &&
		startMs >= canonicalTimestamp(range.start)! && endMs <= canonicalTimestamp(range.end)!
}

function unavailableReason(range: AuthorityRange, asOf: string): 'not_started' | 'report_unavailable' {
	return canonicalTimestamp(range.start)! >= canonicalTimestamp(asOf)! ? 'not_started' : 'report_unavailable'
}

function canonicalTimestamp(value: string): number | undefined {
	if (!TIMESTAMP.test(value)) return undefined
	const time = Date.parse(value)
	return Number.isSafeInteger(time) && time >= 0 && time <= MAX_TIME &&
		new Date(time).toISOString() === value ? time : undefined
}

function isJakartaMondayMidnight(value: string): boolean {
	const time = canonicalTimestamp(value)
	if (time === undefined) return false
	const date = new Date(time)
	return date.getUTCDay() === 0 && date.getUTCHours() === 17 &&
		date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0
}

function validLabel(value: string): boolean {
	const bytes = textEncoder.encode(value).byteLength
	return bytes >= 1 && bytes <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(value) &&
		![...value].some((character) => {
			const codePoint = character.codePointAt(0)!
			return codePoint >= 0xd800 && codePoint <= 0xdfff
		})
}

function positiveSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 1
}

function nonnegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactObject(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
	if (!isObject(value)) return false
	const keys = Object.keys(value)
	return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field))
}

function parseStrictJson(bytes: Uint8Array): unknown | undefined {
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return undefined
	try {
		const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
		return new StrictJsonParser(text).parse()
	} catch {
		return undefined
	}
}

class StrictJsonParser {
	private index = 0
	constructor(private readonly text: string) {}

	parse(): unknown {
		this.whitespace()
		const value = this.value(0)
		this.whitespace()
		if (this.index !== this.text.length) throw new Error('trailing input')
		return value
	}

	private value(depth: number): unknown {
		const character = this.text[this.index]
		if (character === '{') return this.object(depth)
		if (character === '[') return this.array(depth)
		if (character === '"') return this.string(MAX_STRING_BYTES)
		if (character === 't' && this.literal('true')) return true
		if (character === 'f' && this.literal('false')) return false
		if (character === 'n' && this.literal('null')) return null
		if (character !== undefined && character >= '0' && character <= '9') return this.integer()
		throw new Error('invalid value')
	}

	private object(depth: number): Record<string, unknown> {
		if (depth >= MAX_DEPTH) throw new Error('nesting limit')
		this.index++
		this.whitespace()
		const output: Record<string, unknown> = Object.create(null)
		const keys = new Set<string>()
		if (this.take('}')) return output
		for (;;) {
			if (this.text[this.index] !== '"') throw new Error('invalid object key')
			const key = this.string(MAX_KEY_BYTES)
			if (keys.has(key)) throw new Error('duplicate key')
			keys.add(key)
			this.whitespace()
			if (!this.take(':')) throw new Error('missing colon')
			this.whitespace()
			output[key] = this.value(depth + 1)
			this.whitespace()
			if (this.take('}')) return output
			if (!this.take(',')) throw new Error('missing comma')
			this.whitespace()
		}
	}

	private array(depth: number): unknown[] {
		if (depth >= MAX_DEPTH) throw new Error('nesting limit')
		this.index++
		this.whitespace()
		const output: unknown[] = []
		if (this.take(']')) return output
		for (;;) {
			if (output.length >= MAX_ARRAY_LENGTH) throw new Error('array limit')
			output.push(this.value(depth + 1))
			this.whitespace()
			if (this.take(']')) return output
			if (!this.take(',')) throw new Error('missing comma')
			this.whitespace()
		}
	}

	private string(maxBytes: number): string {
		this.index++
		let output = ''
		for (;;) {
			if (this.index >= this.text.length) throw new Error('unterminated string')
			const code = this.text.charCodeAt(this.index++)
			if (code === 0x22) break
			if (code < 0x20) throw new Error('control in string')
			if (code === 0x5c) {
				const escape = this.text[this.index++]
				const simple: Record<string, string> = {
					'"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
				}
				if (escape === 'u') output += this.unicodeEscape()
				else if (escape !== undefined && Object.hasOwn(simple, escape)) output += simple[escape]
				else throw new Error('invalid escape')
			} else {
				if (code >= 0xd800 && code <= 0xdbff) {
					const second = this.text.charCodeAt(this.index)
					if (second < 0xdc00 || second > 0xdfff) throw new Error('unpaired surrogate')
					output += String.fromCharCode(code, second)
					this.index++
				} else {
					if (code >= 0xdc00 && code <= 0xdfff) throw new Error('unpaired surrogate')
					output += String.fromCharCode(code)
				}
			}
			if (textEncoder.encode(output).byteLength > maxBytes) throw new Error('string limit')
		}
		return output
	}

	private unicodeEscape(): string {
		const first = this.hexCodeUnit()
		if (first >= 0xdc00 && first <= 0xdfff) throw new Error('unpaired surrogate')
		if (first < 0xd800 || first > 0xdbff) return String.fromCharCode(first)
		if (this.text[this.index] !== '\\' || this.text[this.index + 1] !== 'u') {
			throw new Error('unpaired surrogate')
		}
		this.index += 2
		const second = this.hexCodeUnit()
		if (second < 0xdc00 || second > 0xdfff) throw new Error('unpaired surrogate')
		return String.fromCodePoint(0x10000 + ((first - 0xd800) << 10) + second - 0xdc00)
	}

	private hexCodeUnit(): number {
		const value = this.text.slice(this.index, this.index + 4)
		if (!/^[0-9a-fA-F]{4}$/.test(value)) throw new Error('invalid unicode escape')
		this.index += 4
		return Number.parseInt(value, 16)
	}

	private integer(): number {
		const start = this.index
		if (this.text[this.index] === '0') this.index++
		else {
			if (this.text[this.index]! < '1' || this.text[this.index]! > '9') throw new Error('invalid integer')
			while (this.text[this.index] !== undefined && this.text[this.index]! >= '0' && this.text[this.index]! <= '9') {
				this.index++
			}
		}
		const token = this.text.slice(start, this.index)
		const next = this.text[this.index]
		if (next === '.' || next === 'e' || next === 'E' || next === '-' || next === '+' ||
			(next !== undefined && !/[\s,}\]]/.test(next))) throw new Error('invalid integer')
		const value = Number(token)
		if (!Number.isSafeInteger(value)) throw new Error('unsafe integer')
		return value
	}

	private literal(value: string): boolean {
		if (!this.text.startsWith(value, this.index)) return false
		this.index += value.length
		return true
	}

	private take(character: string): boolean {
		if (this.text[this.index] !== character) return false
		this.index++
		return true
	}

	private whitespace(): void {
		while (this.index < this.text.length && /[\u0009\u000a\u000d\u0020]/.test(this.text[this.index]!)) {
			this.index++
		}
	}
}
