import type { Interval } from './aggregation.ts'
import type { Capability, CoverageFact } from './harness-evidence-protocol.ts'
import type { ShadowCoverageRecord, ShadowRecord } from './shadow-evidence.ts'

const working: readonly Capability[] = [
	'engagement.composition', 'engagement.submission', 'engagement.follow_up',
	'engagement.approval', 'engagement.takeover',
]
const runtime: readonly Capability[] = ['execution.segments']
const workingRecovery: readonly Capability[] = [
	'recovery.engagement.composition', 'recovery.engagement.submission', 'recovery.engagement.follow_up',
	'recovery.engagement.approval', 'recovery.engagement.takeover',
]
const runtimeRecovery: readonly Capability[] = [
	'recovery.execution_start.native', 'recovery.execution_start.current_observation', 'recovery.execution_end.native',
]

type Assessment =
	| { status: 'unknown' }
	| { status: 'declared_for_scope'; missingRecoveryCapabilities: Capability[] }
	| { status: 'declared_limited'; missingCapabilities: Capability[]; missingRecoveryCapabilities: Capability[] }
export type ShadowDisclosureLane = Interval & {
	collectorId: string
	executionSiteId: string
	capabilityIntervals: (Interval & {
		workingTimeV1: Assessment
		agentRuntimeV1: Assessment
	})[]
	collectionIntegrity: {
		otherwise: 'unknown'
		losses: (Interval & {
			status: 'known_loss'
			factId: string
			capabilities: Capability[]
			reason: Extract<CoverageFact, { family: 'irreversible_loss' }>['reason']
		})[]
	}
	executionClosure: {
		status: 'none_pending' | 'pending'
		starts: { evidenceId: string; segmentId: string; startMs: number }[]
	}
	synchronization: 'unknown'
}

function assess(capabilities: readonly Capability[] | undefined, required: readonly Capability[], recovery: readonly Capability[]): Assessment {
	if (!capabilities) return { status: 'unknown' }
	const missingCapabilities = required.filter((capability) => !capabilities.includes(capability))
	const missingRecoveryCapabilities = recovery.filter((capability) => !capabilities.includes(capability))
	return missingCapabilities.length
		? { status: 'declared_limited', missingCapabilities, missingRecoveryCapabilities }
		: { status: 'declared_for_scope', missingRecoveryCapabilities }
}

/** Pure current reconstruction from complete accepted snapshots, not wire input or a receipt-time audit.
 * Bounds are occurrence instants, already civil/as-of bounded by the caller. An optional caller-approved
 * Stage 5F cutover only clips the lower bound; this function does not select or activate a cutover.
 * Empty lanes/starts/losses mean no accepted matching disclosure facts, never completeness or no work.
 * Availability belongs to the consumer. No durations, project attribution, or synchronization inference.
 */
export function projectShadowDisclosures(
	records: readonly ShadowRecord[],
	coverage: readonly ShadowCoverageRecord[],
	report: Interval & { cutoverMs?: number },
): ShadowDisclosureLane[] {
	const startMs = Math.max(report.startMs, report.cutoverMs ?? Number.NEGATIVE_INFINITY)
	const endMs = report.endMs
	if (startMs >= endMs) return []
	const sources = new Map<string, string>()
	for (const row of [...records, ...coverage]) sources.set(row.collectorId, row.executionSiteId)
	return [...sources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([collectorId, executionSiteId]) => {
		const facts = coverage.filter((row) => row.collectorId === collectorId)
		// Equal-effective declarations have equal capability sets by the accepted-store contract.
		const declarations = new Map<number, Capability[]>()
		for (const row of facts) {
			if (row.fact.family === 'capability_declaration') {
				declarations.set(Date.parse(row.fact.effective_at), JSON.parse(row.capabilitiesJson) as Capability[])
			}
		}
		const ordered = [...declarations].sort(([a], [b]) => a - b)
		const boundaries = [startMs, ...ordered.map(([time]) => time).filter((time) => time > startMs && time < endMs), endMs]
		let declarationIndex = 0
		let capabilities: Capability[] | undefined
		const capabilityIntervals = boundaries.slice(0, -1).map((start, index) => {
			while (declarationIndex < ordered.length && ordered[declarationIndex]![0] <= start) {
				capabilities = ordered[declarationIndex++]![1]
			}
			return {
				startMs: start, endMs: boundaries[index + 1]!,
				workingTimeV1: assess(capabilities, working, workingRecovery),
				agentRuntimeV1: assess(capabilities, runtime, runtimeRecovery),
			}
		})
		const losses: ShadowDisclosureLane['collectionIntegrity']['losses'] = []
		for (const row of facts) {
			if (row.fact.family !== 'irreversible_loss') continue
			const start = Math.max(startMs, Date.parse(row.fact.start))
			const end = Math.min(endMs, Date.parse(row.fact.end))
			if (start < end) losses.push({
				status: 'known_loss', factId: row.factId, startMs: start, endMs: end,
				capabilities: JSON.parse(row.capabilitiesJson) as Capability[], reason: row.fact.reason,
			})
		}
		losses.sort((a, b) => a.startMs - b.startMs || a.factId.localeCompare(b.factId))
		const evidence = records.filter((row) => row.collectorId === collectorId)
		const closed = new Set(evidence.flatMap((row) => row.evidence.family === 'execution_end' ? [row.evidence.segment_id] : []))
		const starts = evidence.flatMap((row) => {
			if (row.evidence.family !== 'execution_start' || closed.has(row.evidence.segment_id)) return []
			const start = Date.parse(row.evidence.timing.wall_time)
			return start >= startMs && start < endMs
				? [{ evidenceId: row.evidenceId, segmentId: row.evidence.segment_id, startMs: start }] : []
		}).sort((a, b) => a.startMs - b.startMs || a.evidenceId.localeCompare(b.evidenceId))
		return {
			collectorId, executionSiteId, startMs, endMs, capabilityIntervals,
			collectionIntegrity: { otherwise: 'unknown', losses },
			executionClosure: { status: starts.length ? 'pending' : 'none_pending', starts },
			synchronization: 'unknown',
		}
	})
}
