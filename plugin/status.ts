import { MAX_CLIENT_CLOCK_SKEW_MS, type SummaryPeriod } from './protocol.ts'
import type { CachedSummary, OutboxCounts, PersistedSyncState, TrackingGap } from './store.ts'
import { formatMinutes } from './tracker.ts'

export type StatusDisplayInput = {
	cache?: CachedSummary
	authoritative: boolean
	trackingGap?: TrackingGap
	counts: OutboxCounts
	syncState: PersistedSyncState
	nowMs: number
	localFallback?: string
	transientErrorKind?: string
}

export function formatStatusDisplay(input: StatusDisplayInput): string {
	const diagnostics = formatDiagnostics(input.counts, input.syncState, input.transientErrorKind)
	if (input.trackingGap) {
		const currentFailure = input.transientErrorKind === 'local-state'
		const freshness = input.cache ? (input.authoritative ? 'AUTHORITATIVE' : 'STALE') : 'UNKNOWN'
		const classification = currentFailure ? 'TRACKING INCOMPLETE' : 'HISTORICAL TRACKING GAP'
		return [
			`${currentFailure ? 'UNKNOWN' : freshness} · ${classification} · ${summaryMetadata(input.cache, input.nowMs)} · ${diagnostics}`,
			formatTrackingGap(input.trackingGap),
			...(input.cache ? formatPeriods(input.cache) : []),
			...(input.localFallback ? [`Local fallback (non-authoritative): ${input.localFallback}`] : []),
		].join('\n')
	}

	if (!input.cache) {
		return [
			`UNKNOWN · no authoritative summary · ${diagnostics}`,
			...(input.localFallback ? [`Local fallback (non-authoritative): ${input.localFallback}`] : []),
		].join('\n')
	}

	const freshness = input.authoritative ? 'AUTHORITATIVE' : 'STALE'
	return [
		`${freshness} · ${summaryMetadata(input.cache, input.nowMs)} · ${diagnostics}`,
		...formatPeriods(input.cache),
	].join('\n')
}

function formatTrackingGap(gap: TrackingGap): string {
	const firstObserved =
		gap.firstObservedAtMs === null
			? 'before diagnostic metadata was available'
			: new Date(gap.firstObservedAtMs).toISOString()
	const reasons = gap.reasons.map(trackingGapReasonLabel).join(', ')
	return `Tracking gap first observed ${firstObserved} · reason ${reasons} · use “Acknowledge tracking gap” to dismiss this warning; missing evidence will not be recovered.`
}

function trackingGapReasonLabel(reason: TrackingGap['reasons'][number]): string {
	switch (reason) {
		case 'event-recording': return 'event recording'
		case 'thread-state-observation': return 'thread state observation'
		case 'sync-local-state': return 'local synchronization state'
		case 'sync-state-persistence': return 'sync state persistence'
		case 'status-local-state': return 'status local state'
		case 'legacy-unknown': return 'unknown legacy cause'
	}
}

function formatPeriods(cache: CachedSummary): string[] {
	return [
		formatPeriod('Today', cache.summary.daily),
		formatPeriod('Week', cache.summary.weekly),
	]
}

function formatPeriod(label: string, period: SummaryPeriod): string {
	const progress = `${formatMinutes(period.worked_minutes)} / ${formatMinutes(period.target_minutes)}`
	if (period.status === 'COMPLETE') return `${label}: COMPLETE · ${progress}`
	const suffix = period.status === 'UNDER' ? 'remaining' : 'over'
	return `${label}: ${period.status} · ${progress} · ${formatMinutes(period.difference_minutes)} ${suffix}`
}

function summaryMetadata(cache: CachedSummary | undefined, nowMs: number): string {
	if (!cache) return 'no authoritative summary'
	const asOfMs = Date.parse(cache.summary.as_of)
	return `as_of ${cache.summary.as_of} · age ${formatAge(Math.max(0, nowMs - asOfMs))}`
}

function formatDiagnostics(
	counts: OutboxCounts,
	syncState: PersistedSyncState,
	transientErrorKind?: string,
): string {
	const parts = [`pending ${counts.pending}`]
	if (counts.conflict > 0) parts.push(`CONFLICTS ${counts.conflict}`)
	if (counts.rejected > 0) parts.push(`REJECTIONS ${counts.rejected}`)
	const errorKind = transientErrorKind ?? syncState.lastErrorKind
	if (errorKind) parts.push(`sync ${errorLabel(errorKind)}`)
	if (syncState.clock && Math.abs(syncState.clock.offsetMs) > MAX_CLIENT_CLOCK_SKEW_MS) {
		parts.push(`CLOCK SKEW ${formatSignedDuration(syncState.clock.offsetMs)}`)
	}
	return parts.join(' · ')
}

function formatAge(ageMs: number): string {
	const minutes = Math.floor(ageMs / 60_000)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
	const days = Math.floor(hours / 24)
	return `${days}d ${String(hours % 24).padStart(2, '0')}h`
}

function formatSignedDuration(offsetMs: number): string {
	const sign = offsetMs < 0 ? '-' : '+'
	return `${sign}${Math.round(Math.abs(offsetMs) / 60_000)}m`
}

function errorLabel(kind: string): string {
	switch (kind) {
		case 'authentication':
			return 'AUTHENTICATION REJECTED'
		case 'authentication-missing':
			return 'CREDENTIAL FILE MISSING'
		case 'authentication-unsafe':
			return 'CREDENTIAL FILE PERMISSIONS UNSAFE'
		case 'authentication-mint-failed':
			return 'WORKLOAD IDENTITY MINT FAILED'
		case 'network':
			return 'OFFLINE'
		case 'service':
			return 'SERVICE UNAVAILABLE'
		case 'protocol':
			return 'PROTOCOL ERROR'
		case 'partial-response':
			return 'PARTIAL RESPONSE'
		case 'clock-skew':
			return 'CLOCK SKEW'
		case 'local-state':
			return 'LOCAL STATE ERROR'
		case 'configuration':
			return 'NOT CONFIGURED'
		default:
			return kind.toUpperCase()
	}
}
