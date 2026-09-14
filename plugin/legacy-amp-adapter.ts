import type { PluginAPI, Subscription, ThreadID, ThreadState } from '@ampcode/plugin'
import { randomUUID } from 'node:crypto'
import {
	ampProjectAttributionFromJSON,
	ampProjectAttributionFromStatusJSON,
	type AmpProjectAttribution,
} from './project.ts'
import type { WorkHoursStore } from './store.ts'
import type { SyncEngine } from './sync.ts'
import { turnKey } from './tracker.ts'

type StateObservation = { state: ThreadState; atMs: number; monotonicAt: number }

type LegacyAmpAdapterOptions = {
	amp: PluginAPI
	store: WorkHoursStore
	sync: SyncEngine
	now?: () => number
	monotonicNow?: () => number
}

/** Internal boundary for the deployed Amp-specific v1/v2 observation behavior. */
export function createLegacyAmpAdapter(options: LegacyAmpAdapterOptions) {
	const { amp, store, sync } = options
	const now = options.now ?? Date.now
	const monotonicNow = options.monotonicNow ?? (() => performance.now())
	const resolveProjectAttribution = createProjectAttributionResolver(amp)
	const monotonicStarts = new Map<string, number>()
	const activeTurns = new Map<string, { messageId: string; recovered: boolean }>()
	const stateSubscriptions = new Map<string, Subscription>()
	const stateTasks = new Set<Promise<void>>()
	const latestStateTask = new Map<string, Promise<void>>()
	let projectAttributionWarningShown = false
	let disposed = false

	const recordStart = async (
		threadId: string,
		messageId: string,
		startedAt: number,
		monotonicStartedAt: number,
	): Promise<boolean> => {
		const [, projectAttribution] = await Promise.all([
			sync.prepareNewTurn(),
			resolveProjectAttribution(),
		])
		const recorded = store.record(
			{
				threadId,
				messageId,
				kind: 'start',
				atMs: startedAt,
			},
			undefined,
			sync.attributionForNewTurn(projectAttribution?.slug ?? null),
		)
		if (recorded) monotonicStarts.set(turnKey({ threadId, messageId }), monotonicStartedAt)
		sync.kick()
		return projectAttribution !== undefined
	}

	const recordEnd = (
		threadId: string,
		messageId: string,
		status: 'done' | 'error' | 'cancelled',
		atMs = now(),
		monotonicAt = monotonicNow(),
	): void => {
		const eventKey = turnKey({ threadId, messageId })
		const startedAt = monotonicStarts.get(eventKey)
		try {
			const recorded = store.recordEndIfStarted(
				{
					threadId,
					messageId,
					kind: 'end',
					atMs,
					status,
				},
				startedAt === undefined ? undefined : Math.max(0, monotonicAt - startedAt),
			)
			if (recorded) sync.kick()
		} finally {
			monotonicStarts.delete(eventKey)
		}
	}

	const handleThreadState = async (
		threadId: string,
		observation: StateObservation,
	): Promise<void> => {
		if (disposed) return
		const active = activeTurns.get(threadId)
		if (observation.state === 'running' || observation.state === 'awaiting-approval') {
			if (active) return
			const messageId = `cukup-recovered-${randomUUID()}`
			activeTurns.set(threadId, { messageId, recovered: true })
			try {
				await recordStart(threadId, messageId, observation.atMs, observation.monotonicAt)
			} catch {
				if (activeTurns.get(threadId)?.messageId === messageId) activeTurns.delete(threadId)
				sync.markTrackingIncomplete('event-recording')
			}
			return
		}
		if (!active?.recovered) return
		try {
			recordEnd(
				threadId,
				active.messageId,
				observation.state === 'error' ? 'error' : 'done',
				observation.atMs,
				observation.monotonicAt,
			)
		} catch {
			sync.markTrackingIncomplete('event-recording')
		} finally {
			if (activeTurns.get(threadId) === active) activeTurns.delete(threadId)
		}
	}

	const runStateTask = (threadId: string, observation: StateObservation): void => {
		const task = (latestStateTask.get(threadId) ?? Promise.resolve())
			.catch(() => {})
			.then(() => handleThreadState(threadId, observation))
		latestStateTask.set(threadId, task)
		stateTasks.add(task)
		void task.finally(() => {
			stateTasks.delete(task)
			if (latestStateTask.get(threadId) === task) latestStateTask.delete(threadId)
		})
	}

	const observeThread = (threadId: string): void => {
		if (disposed || stateSubscriptions.has(threadId)) return
		try {
			const state = amp.threads.get(threadId as ThreadID).state
			let emitted = false
			stateSubscriptions.set(
				threadId,
				state.subscribe((value) => {
					emitted = true
					runStateTask(threadId, { state: value, atMs: now(), monotonicAt: monotonicNow() })
				}),
			)
			void Promise.resolve()
				.then(() => state.get())
				.then((value) => {
					if (!emitted && (value === 'running' || value === 'awaiting-approval')) {
						runStateTask(threadId, { state: value, atMs: now(), monotonicAt: monotonicNow() })
					}
				})
				.catch(() => sync.markTrackingIncomplete('thread-state-observation'))
		} catch {
			sync.markTrackingIncomplete('thread-state-observation')
		}
	}

	const activeThreadSubscription = amp.activeThread?.subscribe((thread) => {
		if (thread) observeThread(thread.id)
	})
	if (amp.activeThread?.current) observeThread(amp.activeThread.current.id)

	amp.on('session.start', (event) => {
		observeThread(event.thread.id)
	})

	amp.on('agent.start', async (event, ctx) => {
		const threadId = event.thread.id
		const messageId = String(event.id)
		const startedAt = now()
		const monotonicStartedAt = monotonicNow()
		await latestStateTask.get(threadId)?.catch(() => {})
		const active = activeTurns.get(threadId)
		if (active?.recovered) {
			try {
				recordEnd(
					threadId,
					active.messageId,
					'done',
					startedAt,
					monotonicStartedAt,
				)
			} catch {
				sync.markTrackingIncomplete('event-recording')
			}
		}
		activeTurns.set(threadId, { messageId, recovered: false })
		observeThread(threadId)
		try {
			const attributed = await recordStart(threadId, messageId, startedAt, monotonicStartedAt)
			if (!attributed && !projectAttributionWarningShown) {
				projectAttributionWarningShown = true
				void ctx.ui
					.notify('Cukup could not resolve this Amp Project. New attributed turns will be Unassigned.')
					.catch(() => {})
			}
		} catch {
			if (activeTurns.get(threadId)?.messageId === messageId) activeTurns.delete(threadId)
			sync.markTrackingIncomplete('event-recording')
			void ctx.ui
				.notify('UNKNOWN · TRACKING INCOMPLETE · Cukup could not record agent.start locally.')
				.catch(() => {})
		}
		return {}
	})

	amp.on('agent.end', async (event, ctx) => {
		const threadId = event.thread.id
		const messageId = String(event.id)
		const endedAt = now()
		const monotonicEndedAt = monotonicNow()
		await latestStateTask.get(threadId)?.catch(() => {})
		const active = activeTurns.get(threadId)
		try {
			recordEnd(
				threadId,
				active?.recovered ? active.messageId : messageId,
				event.status,
				endedAt,
				monotonicEndedAt,
			)
		} catch {
			sync.markTrackingIncomplete('event-recording')
			void ctx.ui
				.notify('UNKNOWN · TRACKING INCOMPLETE · Cukup could not record agent.end locally.')
				.catch(() => {})
		} finally {
			if (
				activeTurns.get(threadId) === active &&
				(active?.recovered || active?.messageId === messageId)
			) {
				activeTurns.delete(threadId)
			}
		}
	})

	amp.on('tool.result', (event) => {
		observeThread(event.thread.id)
	})

	return {
		resolveProjectAttribution,
		async dispose(): Promise<void> {
			disposed = true
			activeThreadSubscription?.unsubscribe()
			for (const subscription of stateSubscriptions.values()) subscription.unsubscribe()
			await Promise.all(stateTasks)
		},
	}
}

function createProjectAttributionResolver(
	amp: PluginAPI,
	projectID = process.env.AMP_PROJECT_ID?.trim(),
): () => Promise<AmpProjectAttribution | undefined> {
	let resolved: Promise<AmpProjectAttribution | undefined> | undefined
	return () => {
		if (!resolved) {
			const lookup = projectID
				? amp.$`amp projects get ${projectID} --json`
				: amp.system.workspaceRoot
					? amp.$`cd ${amp.helpers.filePathFromURI(amp.system.workspaceRoot)} && amp projects status --json`
					: undefined
			if (!lookup) return Promise.resolve(undefined)
			resolved = lookup
				.then((result) =>
					result.exitCode === 0
						? projectID
							? ampProjectAttributionFromJSON(result.stdout, projectID)
							: ampProjectAttributionFromStatusJSON(result.stdout)
						: undefined,
				)
				.catch(() => undefined)
				.then((projectAttribution) => {
					if (!projectAttribution) resolved = undefined
					return projectAttribution
				})
		}
		return resolved
	}
}
