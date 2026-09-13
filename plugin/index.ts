import type {
	PluginAPI,
	PluginExecutorKind,
	ThreadID,
} from '@ampcode/plugin'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import {
	createFileTokenProvider,
	createOidcTokenProvider,
	TokenProviderError,
	unavailableTokenProvider,
	type TokenProvider,
} from './auth.ts'
import {
	createExperimentalAmpShadowCollector,
	EXPERIMENTAL_AMP_SHADOW_WARNING,
	type ExperimentalAmpShadowCollector,
} from './experimental-amp-shadow-collector.ts'
import { createLegacyAmpAdapter } from './legacy-amp-adapter.ts'
import { CukupServiceClient, isTargetOverrideDate, ServiceRequestError } from './protocol.ts'
import { formatStatusDisplay } from './status.ts'
import { WorkHoursStore } from './store.ts'
import { REMOTE_EXECUTOR_LABEL, SyncEngine, type ExecutorProfile } from './sync.ts'
import {
	classifyWork,
	formatMinutes,
	formatStatus,
	jakartaDateString,
	jakartaDayBounds,
	latestUnmatchedStarts,
	parseDailyTarget,
	turnKey,
	workedMilliseconds,
} from './tracker.ts'

export const description =
	'Tracks work inferred from Amp turns and reports authoritative daily and weekly Cukup status.'

export default function (amp: PluginAPI) {
	const store = new WorkHoursStore()
	const now = Date.now
	const serviceURL = process.env.CUKUP_SERVICE_URL?.trim() || 'https://api.cukup.dev'
	const client = createClient(serviceURL, now)
	const tokenProvider = selectTokenProvider(amp)
	const sync = new SyncEngine({
		store,
		client,
		tokenProvider,
		now,
		executorProfile: executorProfileFor(amp.system.executor.kind),
	})
	const legacyAmpAdapter = createLegacyAmpAdapter({ amp, store, sync, now })
	const { resolveProjectAttribution } = legacyAmpAdapter
	const experimentalAmpShadowCollector = startExperimentalAmpShadowCollector(amp)

	amp.registerCommand(
		'work-hours-status',
		{
			title: 'Status',
			category: 'cukup',
			description: 'Show authoritative daily and Monday–Sunday weekly Cukup status.',
		},
		async (ctx) => {
			let message: string
			try {
				const result = await sync.runNow()
				const nowMs = now()
				const cache = store.cachedSummary()
				message = formatStatusDisplay({
					cache,
					authoritative: result.authoritativeSummary,
					trackingIncomplete: sync.trackingIncomplete(),
					counts: store.outboxCounts(),
					syncState: store.syncState(),
					nowMs,
					localFallback: cache ? undefined : await calculateLocalFallback(amp, store, nowMs),
					transientErrorKind: result.errorKind,
				})
			} catch {
				sync.markTrackingIncomplete()
				message = 'UNKNOWN · TRACKING INCOMPLETE · Cukup local state is unavailable.'
			}
			await ctx.ui.select({
				title: 'Cukup status',
				message,
				options: ['Close'],
			})
		},
	)

	amp.registerCommand(
		'project-slug-set',
		{
			title: 'Project attribution',
			category: 'cukup',
			description: 'Show the automatically resolved Amp Project attribution for future turns.',
		},
		async (ctx) => {
			const projectAttribution = await resolveProjectAttribution()
			await ctx.ui.select({
				title: 'Cukup project attribution',
				message: projectAttribution
					? `Amp Project: **${projectAttribution.name}**\n\nProject Slug: **${projectAttribution.slug}**\n\nThis is resolved from the immutable Amp Project ID and applies across its machines and orbs. No repository setting is used.`
					: 'No valid Amp Project could be resolved. Future attributed turns will be **Unassigned** rather than guessed from a checkout path or package name.',
				options: ['Close'],
			})
		},
	)

	amp.registerCommand(
		'day-off-set',
		{
			title: 'Set day off or half day',
			category: 'cukup',
			description: 'Set or clear an authoritative full- or half-day target override.',
		},
		async (ctx) => {
			const today = jakartaDateString(now())
			const dateChoice = await ctx.ui.select({
				title: 'Set day off or half day',
				message: `Today in Asia/Jakarta: **${today}**\n\nChoose **Today**, or enter another YYYY-MM-DD date in **Other**.`,
				options: ['Today'],
				allowOther: true,
			})
			if (dateChoice === undefined) return
			const date = dateChoice === 'Today' ? today : dateChoice
			if (!isTargetOverrideDate(date)) {
				await ctx.ui.notify('Enter a real date in exact YYYY-MM-DD format.')
				return
			}
			const action = await ctx.ui.select({
				title: 'Set day off',
				message: `Asia/Jakarta date: **${date}**`,
				options: ['Full day off (0m)', 'Half day (4h)', 'Clear / undo'],
			})
			const targetMinutes =
				action === 'Full day off (0m)' ? 0 : action === 'Half day (4h)' ? 240 : undefined
			const clearing = action === 'Clear / undo'
			if (targetMinutes === undefined && !clearing) return
			const targetLabel = targetMinutes === 0 ? '0m' : '240m (4h)'
			const confirmed = await ctx.ui.confirm({
				title: clearing
					? `Clear day off for ${date}?`
					: targetMinutes === 0
						? `Set full day off for ${date}?`
						: `Set half day for ${date}?`,
				message: clearing
					? 'The authoritative target will return to the default for that weekday. Work-time evidence remains unchanged.'
					: `The authoritative target will be **${targetLabel}**. Work-time evidence remains unchanged.`,
				confirmButtonText: clearing
					? 'Clear / undo'
					: targetMinutes === 0
						? 'Set full day off'
						: 'Set half day',
			})
			if (!confirmed) return
			if (!client) {
				await ctx.ui.notify('Authoritative day-off update failed. The Cukup service is unavailable.')
				return
			}
			try {
				const token = await tokenProvider.getToken()
				if (targetMinutes === undefined) await client.clearTargetOverride(token, date)
				else await client.putTargetOverride(token, date, targetMinutes)
			} catch (error) {
				const detail =
					error instanceof TokenProviderError || error instanceof ServiceRequestError
						? ` ${error.message}`
						: ''
				await ctx.ui.notify(`Authoritative day-off update failed.${detail}`)
				return
			}
			await ctx.ui.notify(
				targetMinutes === undefined
					? `Authoritative day-off override for ${date} is cleared.`
					: `Authoritative target for ${date} is now ${targetLabel}.`,
			)
		},
	)

	amp.registerCommand(
		'work-hours-set-target',
		{
			title: 'Set local fallback target',
			category: 'cukup',
			description: 'Set the non-authoritative local fallback target in H:MM format.',
		},
		async (ctx) => {
			const input = await ctx.ui.select({
				title: 'Set local fallback weekday target',
				message: 'Choose the authoritative default, or enter another H:MM value in **Other**.',
				options: ['8:00'],
				allowOther: true,
			})
			if (input === undefined) return
			const minutes = parseDailyTarget(input)
			if (minutes === undefined) {
				await ctx.ui.notify('Enter a target from 0:00 to 24:00 in H:MM format.')
				return
			}
			store.setWeekdayTargetMinutes(minutes)
			await ctx.ui.notify(`Weekday target set to ${formatMinutes(minutes)}.`)
		},
	)

	sync.start()
	amp.onDispose(async () => {
		const shadowDisposal = experimentalAmpShadowCollector?.dispose()
		const legacyDisposal = (async () => {
			await legacyAmpAdapter.dispose()
			await sync.dispose()
			store.close()
		})()
		const [legacyResult] = await Promise.allSettled([legacyDisposal, shadowDisposal])
		if (legacyResult.status === 'rejected') throw legacyResult.reason
	})
}

function startExperimentalAmpShadowCollector(amp: PluginAPI): ExperimentalAmpShadowCollector | undefined {
	if (process.env.CUKUP_EXPERIMENTAL_AMP_SHADOW !== '1') return undefined
	const runtimeStateDirectory = process.env.CUKUP_EXPERIMENTAL_RUNTIME_STATE_DIR?.trim()
	if (!runtimeStateDirectory) {
		amp.logger.log(EXPERIMENTAL_AMP_SHADOW_WARNING)
		return undefined
	}
	const stateHome = process.env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state')
	const collectorStateDirectory =
		process.env.CUKUP_EXPERIMENTAL_AMP_SHADOW_STATE_DIR?.trim() ||
		join(stateHome, 'amp-work-hours', 'experimental-amp-shadow')
	try {
		return createExperimentalAmpShadowCollector({
			amp,
			runtimeStateDirectory,
			collectorStateDirectory,
		})
	} catch {
		amp.logger.log(EXPERIMENTAL_AMP_SHADOW_WARNING)
		return undefined
	}
}

export function executorProfileFor(
	kind: PluginExecutorKind,
	getHostname: () => string = hostname,
): ExecutorProfile | undefined {
	if (kind === 'local') return { kind: 'local', hostname: getHostname() }
	if (kind === 'remote') return { kind: 'remote', executorLabel: REMOTE_EXECUTOR_LABEL }
	return undefined
}

function createClient(serviceURL: string | undefined, now: () => number): CukupServiceClient | undefined {
	if (!serviceURL) return undefined
	try {
		return new CukupServiceClient(serviceURL, fetch, now)
	} catch {
		return undefined
	}
}

function selectTokenProvider(amp: PluginAPI): TokenProvider {
	if (amp.system.executor.kind === 'remote') return createOidcTokenProvider(amp.$)
	if (amp.system.executor.kind === 'local') {
		return createFileTokenProvider(
			process.env.CUKUP_TOKEN_FILE?.trim() || join(homedir(), '.config', 'cukup', 'token'),
		)
	}
	return unavailableTokenProvider()
}

async function calculateLocalFallback(
	amp: PluginAPI,
	store: WorkHoursStore,
	nowMs: number,
): Promise<string> {
	const events = store.events()
	const activeTurnKeys = new Set<string>()
	for (const start of latestUnmatchedStarts(events)) {
		try {
			const state = await amp.threads.get(start.threadId as ThreadID).state.get()
			if (state === 'running' || state === 'awaiting-approval') activeTurnKeys.add(turnKey(start))
		} catch {
			// If thread state is unavailable, use the conservative idle-grace cap.
		}
	}

	const day = jakartaDayBounds(nowMs)
	const targetMinutes = day.weekend ? 0 : store.weekdayTargetMinutes()
	return formatStatus(
		classifyWork(
			workedMilliseconds(events, nowMs, day.startMs, day.endMs, activeTurnKeys),
			targetMinutes,
		),
	)
}
