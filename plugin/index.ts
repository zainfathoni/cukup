import type { PluginAPI, PluginExecutorKind, ThreadID } from '@ampcode/plugin'
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, join } from 'node:path'
import {
	createFileTokenProvider,
	createOidcTokenProvider,
	TokenProviderError,
	unavailableTokenProvider,
	type TokenProvider,
} from './auth.ts'
import { CukupServiceClient, isTargetOverrideDate, ServiceRequestError } from './protocol.ts'
import {
	PROJECT_SLUG_CONFIG_KEY,
	normalizeProjectSlug,
	projectSlugFromConfiguration,
} from './project.ts'
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
	const monotonicNow = () => performance.now()
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
	const monotonicStarts = new Map<string, number>()

	amp.on('agent.start', async (event, ctx) => {
		const eventKey = turnKey({ threadId: event.thread.id, messageId: String(event.id) })
		const startedAt = monotonicNow()
		try {
			const projectSlug = await configuredProjectSlug(amp)
			const recorded = store.record(
				{
					threadId: event.thread.id,
					messageId: String(event.id),
					kind: 'start',
					atMs: now(),
				},
				undefined,
				sync.attributionForNewTurn(projectSlug),
			)
			if (recorded) monotonicStarts.set(eventKey, startedAt)
			sync.kick()
		} catch {
			sync.markTrackingIncomplete()
			void ctx.ui
				.notify('UNKNOWN · TRACKING INCOMPLETE · Cukup could not record agent.start locally.')
				.catch(() => {})
		}
		return {}
	})

	amp.on('agent.end', (event, ctx) => {
		const eventKey = turnKey({ threadId: event.thread.id, messageId: String(event.id) })
		const startedAt = monotonicStarts.get(eventKey)
		const endedAt = monotonicNow()
		try {
			store.record(
				{
					threadId: event.thread.id,
					messageId: String(event.id),
					kind: 'end',
					atMs: now(),
					status: event.status,
				},
				startedAt === undefined ? undefined : Math.max(0, endedAt - startedAt),
			)
			monotonicStarts.delete(eventKey)
			sync.kick()
		} catch {
			sync.markTrackingIncomplete()
			void ctx.ui
				.notify('UNKNOWN · TRACKING INCOMPLETE · Cukup could not record agent.end locally.')
				.catch(() => {})
		}
	})

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
			title: 'Set project slug',
			category: 'cukup',
			description: 'Set or clear the explicit Project Slug for future turns in this workspace.',
			availability: hasAmpWorkspace(amp) ? { type: 'enabled' } : { type: 'hidden' },
		},
		async (ctx) => {
			if (!hasAmpWorkspace(amp)) return
			const current = await configuredProjectSlug(amp)
			const suggestions = projectSlugSuggestions(amp)
			const selection = await ctx.ui.select({
				title: 'Set project slug',
				message: `Current Project Slug: **${current ?? 'Unassigned'}**\n\nChoose a detected name, or enter a custom value in **Other**. Custom values normalize to lowercase kebab-case.`,
				options: [...suggestions.keys(), 'Clear / undo'],
				allowOther: true,
			})
			if (selection === 'Clear / undo') {
				const confirmed = await ctx.ui.confirm({
					title: 'Clear project slug?',
					message: 'Future turns in this workspace will be **Unassigned**. Existing turns are unchanged.',
					confirmButtonText: 'Clear',
				})
				if (!confirmed) return
				await amp.configuration.delete(PROJECT_SLUG_CONFIG_KEY, 'workspace')
				await ctx.ui.notify('Project Slug cleared. Future turns will be Unassigned.')
				return
			}
			if (selection === undefined) return
			const normalized = normalizeProjectSlug(suggestions.get(selection) ?? selection)
			if (!normalized) {
				await ctx.ui.notify(
					'Project Slug must normalize to lowercase kebab-case, use no punctuation, and be at most 64 characters.',
				)
				return
			}
			const confirmed = await ctx.ui.confirm({
				title: 'Save project slug?',
				message: `Normalized Project Slug: **${normalized}**\n\nOnly future turns are affected.`,
				confirmButtonText: 'Save',
			})
			if (!confirmed) return
			await amp.configuration.update({ [PROJECT_SLUG_CONFIG_KEY]: normalized }, 'workspace')
			await ctx.ui.notify(`Project Slug set to ${normalized}.`)
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
		await sync.dispose()
		store.close()
	})
}

export function executorProfileFor(
	kind: PluginExecutorKind,
	getHostname: () => string = hostname,
): ExecutorProfile | undefined {
	if (kind === 'local') return { kind: 'local', hostname: getHostname() }
	if (kind === 'remote') return { kind: 'remote', executorLabel: REMOTE_EXECUTOR_LABEL }
	return undefined
}

function hasAmpWorkspace(amp: PluginAPI): boolean {
	return amp.system.workspaceRoot != null
}

function projectSlugSuggestions(amp: PluginAPI): Map<string, string> {
	const suggestions = new Map<string, string>()
	const workspaceRoot = amp.system.workspaceRoot
	if (workspaceRoot == null) return suggestions
	try {
		const workspacePath = amp.helpers.filePathFromURI(workspaceRoot)
		try {
			const parsed = JSON.parse(readFileSync(join(workspacePath, 'package.json'), 'utf8')) as unknown
			if (parsed && typeof parsed === 'object' && 'name' in parsed && typeof parsed.name === 'string') {
				const projectName = parsed.name.split('/').at(-1)
				const projectSlug = projectName && normalizeProjectSlug(projectName)
				if (projectSlug) suggestions.set(`Use project name (${projectSlug})`, projectSlug)
			}
		} catch {
			// Not every workspace has a package.json.
		}
		const workspaceSlug = normalizeProjectSlug(basename(workspacePath))
		if (workspaceSlug && workspaceSlug !== 'repo' && ![...suggestions.values()].includes(workspaceSlug)) {
			suggestions.set(`Use workspace name (${workspaceSlug})`, workspaceSlug)
		}
	} catch {
		// Leave custom entry available when the workspace path cannot be interpreted.
	}
	return suggestions
}

async function configuredProjectSlug(amp: PluginAPI): Promise<string | null> {
	if (!hasAmpWorkspace(amp)) return null
	try {
		return projectSlugFromConfiguration(await amp.configuration.get())
	} catch {
		return null
	}
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
