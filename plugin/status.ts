import type { TokenProvider } from './auth.ts'
import { TokenProviderError } from './auth.ts'
import { ServiceRequestError, type CukupServiceClient } from './protocol.ts'
import { MAX_CLIENT_CLOCK_SKEW_MS, type SummaryPeriod, type LimitPeriod, type Track, type TrackSummary } from './protocol.ts'
import type { CachedSummary, OutboxCounts, PersistedSyncState, TrackingGap, WorkHoursStore } from './store.ts'
import { formatMinutes, jakartaDateString, jakartaDayBounds } from './tracker.ts'

/** Read metrics without running synchronization or changing local state. */
export async function readWorkHoursStatus(input: {
	client?: Pick<CukupServiceClient, 'fetchTrackSummary'>
	track?: Track
	tokenProvider: TokenProvider
	store: Pick<WorkHoursStore, 'cachedSummary' | 'outboxCounts' | 'syncState'>
	trackingGap: () => TrackingGap | undefined
	now: () => number
}): Promise<string> {
	const track = input.track ?? 'work'
	let summary: TrackSummary | undefined
	let cache: CachedSummary | undefined
	let transientErrorKind: string | undefined
	try {
		if (input.client) {
			const token = await input.tokenProvider.getToken()
			summary = await input.client.fetchTrackSummary(token, track)
		} else {
			transientErrorKind = 'configuration'
		}
	} catch (error) {
		transientErrorKind = error instanceof TokenProviderError
			? `authentication-${error.kind}`
			: error instanceof ServiceRequestError ? error.kind : 'service'
	}

	let display: string
	try {
		const counts = input.store.outboxCounts()
		const syncState = input.store.syncState()
		const trackingGap = input.trackingGap()
		if (summary) {
			display = [
				`AUTHORITATIVE${trackingGap ? ' · HISTORICAL TRACKING GAP' : ''} · ${summaryMetadata({ summary }, input.now())} · ${formatDiagnostics(counts, syncState)}`,
				...(trackingGap ? [formatTrackingGap(trackingGap)] : []),
				formatTrackPeriod('Today', summary.daily),
				formatTrackPeriod('Week', summary.weekly),
			].join('\n')
		} else {
			cache = input.store.cachedSummary()
			display = [
				`UNKNOWN · ${track} status unavailable. A legacy global summary cannot establish this track's status.`,
				...(cache ? [
					`STALE · LEGACY GLOBAL ACTIVITY ONLY${trackingGap ? ' · HISTORICAL TRACKING GAP' : ''} · ${summaryMetadata(cache, input.now())} · ${formatDiagnostics(counts, syncState, transientErrorKind)}`,
					...(trackingGap ? [formatTrackingGap(trackingGap)] : []),
					`Cached global daily activity: ${formatMinutes(cache.summary.daily.worked_minutes)}`,
					`Cached global weekly activity: ${formatMinutes(cache.summary.weekly.worked_minutes)}`,
					'Work/Play split unavailable. No goal or limit comparison is reported for cached activity.',
				] : [formatStatusDisplay({ authoritative: false, counts, syncState, trackingGap, nowMs: input.now(), transientErrorKind })]),
			].join('\n')
		}
	} catch {
		return 'UNKNOWN · local diagnostics are unavailable. No complete status can be reported. No local state was changed.'
	}

	const scope = [`${summary ? 'Track' : 'Requested track'}: ${track}. Work = bta and bta-notes; Play = every other project, including Unassigned; All = global union.`, 'Scope: Asia/Jakarta; daily calendar day; weekly Monday–Sunday.']
	const asOf = summary?.as_of ?? cache?.summary.as_of
	if (asOf) {
		const asOfMs = Date.parse(asOf)
		const date = jakartaDateString(asOfMs)
		const day = jakartaDayBounds(asOfMs)
		const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
		const mondayMs = day.startMs - ((weekday + 6) % 7) * 86_400_000
		scope.push(`${summary ? 'Today/Week refer to the as_of snapshot' : 'Cached global snapshot scope'}: daily ${date}; weekly ${jakartaDateString(mondayMs)} through ${jakartaDateString(mondayMs + 6 * 86_400_000)}.`)
	}
	return [
		display,
		...scope,
		'Legacy Working Time · turn-based; not measured human attention. Only Work counts toward the BTA Work goal. Play and All have limits, not goals to reach. Work + Play can exceed All because of overlap; do not add track, machine, or project totals.',
		'Pending events are not uploaded by this read. Conflicts, rejections, and tracking gaps can limit coverage. No local estimate is added. A cached global summary is STALE and does not provide track status.',
		'Diagnostics cover this executor only. They do not prove complete coverage on other executors. Existing tracking and background synchronization remain independent of this read.',
	].join('\n')
}

function formatTrackPeriod(label: string, period: SummaryPeriod | LimitPeriod): string {
	if ('upper_limit_minutes' in period) {
		const boundary = period.status === 'EXCEEDED' ? 'upper' : 'soft'
		const direction = period.status === 'WITHIN' ? 'below' : 'above'
		return `${label}: ${period.status} · ${formatMinutes(period.worked_minutes)} · soft limit ${formatMinutes(period.target_minutes)} · upper limit ${formatMinutes(period.upper_limit_minutes)} · ${formatMinutes(period.difference_minutes)} ${direction} ${boundary} limit`
	}
	if (period.target_minutes === 0) return `${label}: NO SCHEDULED GOAL · ${formatMinutes(period.worked_minutes)} unplanned Work`
	if (period.status === 'UNDER') return formatPeriod(label, period)
	return `${label}: GOAL MET · ${formatMinutes(period.worked_minutes)} / ${formatMinutes(period.target_minutes)}`
}

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

function summaryMetadata(cache: { summary: { as_of: string } } | undefined, nowMs: number): string {
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
			return 'NOT CONFIGURED: set CUKUP_SERVICE_URL to your Cukup API origin'
		default:
			return kind.toUpperCase()
	}
}
