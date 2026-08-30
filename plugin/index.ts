import type { PluginAPI, ThreadID } from '@ampcode/plugin'
import { WorkHoursStore } from './store.ts'
import {
	classifyWork,
	formatMinutes,
	formatStatus,
	latestUnmatchedStarts,
	localDayBounds,
	parseDailyTarget,
	turnKey,
	workedMilliseconds,
} from './tracker.ts'

export const description =
	'Tracks work inferred from Amp turns and reports whether today is under, complete, or over target.'

export default function (amp: PluginAPI) {
	const store = new WorkHoursStore()

	amp.on('agent.start', (event) => {
		store.record({
			threadId: event.thread.id,
			messageId: String(event.id),
			kind: 'start',
			atMs: Date.now(),
		})
		return {}
	})

	amp.on('agent.end', (event) => {
		store.record({
			threadId: event.thread.id,
			messageId: String(event.id),
			kind: 'end',
			atMs: Date.now(),
			status: event.status,
		})
	})

	amp.registerCommand(
		'work-hours-status',
		{
			title: 'Status',
			category: 'work hours',
			description: 'Show Amp-backed work time against today’s target.',
		},
		async (ctx) => {
			try {
				const nowMs = Date.now()
				const events = store.events()
				const activeTurnKeys = new Set<string>()
				for (const start of latestUnmatchedStarts(events)) {
					try {
						const state = await amp.threads.get(start.threadId as ThreadID).state.get()
						if (state === 'running' || state === 'awaiting-approval') {
							activeTurnKeys.add(turnKey(start))
						}
					} catch {
						// If thread state is unavailable, use the conservative idle-grace cap.
					}
				}

				const day = localDayBounds(nowMs)
				const targetMinutes = day.weekend ? 0 : store.weekdayTargetMinutes()
				const workedMs = workedMilliseconds(
					events,
					nowMs,
					day.startMs,
					day.endMs,
					activeTurnKeys,
				)
				await ctx.ui.notify(formatStatus(classifyWork(workedMs, targetMinutes)))
			} catch (error) {
				await ctx.ui.notify(errorMessage(error))
			}
		},
	)

	amp.registerCommand(
		'work-hours-set-target',
		{
			title: 'Set daily target',
			category: 'work hours',
			description: 'Set the Monday–Friday work target in H:MM format.',
		},
		async (ctx) => {
			const input = await ctx.ui.input({
				title: 'Set weekday work target',
				helpText: 'Use H:MM, for example 8:00. Weekends have no hours due.',
				initialValue: formatTargetInput(store.weekdayTargetMinutes()),
				submitButtonText: 'Save target',
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

	amp.onDispose(() => store.close())
}

function formatTargetInput(minutes: number): string {
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? `Work hours failed: ${error.message}` : 'Work hours failed.'
}
