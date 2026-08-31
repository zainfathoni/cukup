import type { PluginAPI, ThreadID } from '@ampcode/plugin'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
	createFileTokenProvider,
	createOidcTokenProvider,
	unavailableTokenProvider,
	type TokenProvider,
} from './auth.ts'
import { CukupServiceClient } from './protocol.ts'
import { formatStatusDisplay } from './status.ts'
import { WorkHoursStore } from './store.ts'
import { SyncEngine } from './sync.ts'
import {
	classifyWork,
	formatMinutes,
	formatStatus,
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
	const sync = new SyncEngine({ store, client, tokenProvider, now })
	const monotonicStarts = new Map<string, number>()

	amp.on('agent.start', (event, ctx) => {
		const eventKey = turnKey({ threadId: event.thread.id, messageId: String(event.id) })
		const startedAt = monotonicNow()
		try {
			const recorded = store.record({
				threadId: event.thread.id,
				messageId: String(event.id),
				kind: 'start',
				atMs: now(),
			})
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
			await ctx.ui.notify(message)
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
			const input = await ctx.ui.input({
				title: 'Set local fallback weekday target',
				helpText: 'The authoritative service remains fixed at 8:00 Mon–Fri and 0:00 weekends.',
				initialValue: formatTargetInput(store.weekdayTargetMinutes()),
				submitButtonText: 'Save fallback target',
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

function formatTargetInput(minutes: number): string {
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}
