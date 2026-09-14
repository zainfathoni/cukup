import type { PluginAPI } from '@ampcode/plugin'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PhysicalShadowEvidenceOutbox } from '../experimental/physical-shadow-evidence-outbox.ts'
import type { EnqueueResult } from '../experimental/local-harness-evidence-client.ts'
import type { TokenProvider } from './auth.ts'
import {
	createExperimentalAmpShadowCollector,
	EXPERIMENTAL_AMP_SHADOW_CAPABILITIES,
	EXPERIMENTAL_AMP_SHADOW_WARNING,
	type ExperimentalAmpShadowCollector,
} from './experimental-amp-shadow-collector.ts'
import type { ExecutorProfile } from './sync.ts'

const COMPLETION_TIMEOUT_MS = 2_500

/** Physical-only transport for the existing Amp observations, not another fact source. */
export function startExperimentalPhysicalAmpShadow(
	amp: PluginAPI,
	options: {
		serviceURL: string
		tokenProvider: TokenProvider
		executorProfile: ExecutorProfile | undefined
		env?: NodeJS.ProcessEnv
		fetch?: (input: string, init: RequestInit) => Promise<Response>
		now?: () => number
		monotonicNow?: () => number
	},
) {
	const env = options.env ?? process.env
	if (env.CUKUP_EXPERIMENTAL_PHYSICAL_AMP_SHADOW !== '1') return undefined
	let warningShown = false
	const warn = () => {
		if (warningShown) return
		warningShown = true
		amp.logger.log(EXPERIMENTAL_AMP_SHADOW_WARNING)
	}
	if (amp.system.executor.kind !== 'local' || options.executorProfile?.kind !== 'local') {
		warn()
		return undefined
	}
	let outbox: PhysicalShadowEvidenceOutbox
	let collector: ExperimentalAmpShadowCollector | undefined
	let pendingDrain: ReturnType<PhysicalShadowEvidenceOutbox['drainStep']> | undefined
	let pendingSynchronization: ReturnType<PhysicalShadowEvidenceOutbox['synchronizationStep']> | undefined
	const requestDrain = () => (pendingDrain = outbox.drainStep())
	const requestSynchronization = () => (pendingSynchronization = outbox.synchronizationStep())
	const cleanup = async () => {
		try {
			await collector?.dispose()
		} finally {
			await Promise.allSettled([pendingDrain, pendingSynchronization])
			outbox.close()
		}
	}
	try {
		const stateHome = env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state')
		const directory = join(stateHome, 'amp-work-hours', 'experimental-physical-amp-shadow')
		outbox = new PhysicalShadowEvidenceOutbox({
			serviceURL: options.serviceURL,
			tokenProvider: options.tokenProvider,
			executorHostname: options.executorProfile.hostname,
			capabilities: EXPERIMENTAL_AMP_SHADOW_CAPABILITIES,
			spoolPath: join(directory, 'spool.sqlite'),
			fetch: options.fetch,
			now: options.now,
			monotonicNow: options.monotonicNow,
			requestTimeoutMs: 1_000,
		})
		const declaration = outbox.enqueueCapabilityDeclaration()
		if (declaration.status !== 'queued') throw new Error('Physical capability declaration unavailable')
		collector = createExperimentalAmpShadowCollector({
			amp,
			collectorStateDirectory: directory,
			// Discovery is unused: the client seam routes only to the physical spool.
			runtimeStateDirectory: directory,
			now: options.now,
			clientFactory: async () => ({
				enqueue(value): EnqueueResult {
					const evidence = (value as { evidence: unknown[] }).evidence
					if (evidence.length !== 1) return { status: 'rejected', reason: 'invalid_evidence' }
					const result = outbox.enqueue(evidence[0])
					return result.status === 'rejected'
						? { status: 'rejected', reason: 'invalid_evidence' }
						: result
				},
				async drainStep() {
					const result = await requestDrain()
					return { ...result, blocked: result.status === 'blocked' ? 1 : 0 }
				},
				// This owner also waits for explicit command drains before closing the outbox.
				close() {},
			}),
		})
		let disposal: Promise<void> | undefined
		let stopped = false
		const status = () => {
			try {
				return outbox.status()
			} catch {
				warn()
				return { status: 'unavailable' as const }
			}
		}
		const drainStep = async () => {
			if (stopped) return { status: 'unavailable' as const }
			return bounded(requestDrain(), warn)
		}
		const synchronizationStep = async () => {
			if (stopped) return { status: 'unavailable' as const }
			return bounded(requestSynchronization(), warn)
		}
		const command = amp.registerCommand(
			'experimental-physical-shadow',
			{
				title: 'Experimental physical shadow',
				category: 'cukup',
				description: 'Inspect aggregate shadow spool status, drain one record, or synchronize status.',
			},
			async (ctx) => {
				const choice = await ctx.ui.select({
					title: 'Experimental physical Amp shadow',
					message: JSON.stringify(status()),
					options: ['Drain one record', 'Synchronize status', 'Close'],
				})
				if (choice === 'Drain one record') {
					const result = await drainStep()
					await ctx.ui.notify(JSON.stringify({ drain: result.status, spool: status() }))
				} else if (choice === 'Synchronize status') {
					const result = await synchronizationStep()
					await ctx.ui.notify(JSON.stringify({
						synchronization: typeof result === 'string' ? result : result.status,
						spool: status(),
					}))
				}
			},
		)
		return {
			status,
			drainStep,
			dispose(): Promise<void> {
				if (disposal) return disposal
				stopped = true
				command.unsubscribe()
				// Collector unsubscribes first, flushes pending local observations, then awaits its
				// drain before close. Explicit transport steps must also settle before releasing ownership.
				disposal = bounded(cleanup(), warn).then(() => {})
				return disposal
			},
		}
	} catch {
		// Initialization failures cannot prevent legacy hooks or sync from starting.
		void cleanup().catch(warn)
		warn()
		return undefined
	}
}

/** A broken transport must not hold Amp disposal/commands indefinitely. Ownership stays with
 * the original pending drain until it settles; no overlapping replacement owner is enabled. */
async function bounded<T>(work: Promise<T>, warn: () => void): Promise<T | { status: 'unavailable' }> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			work,
			new Promise<{ status: 'unavailable' }>((resolve) => {
				timer = setTimeout(() => { warn(); resolve({ status: 'unavailable' }) }, COMPLETION_TIMEOUT_MS)
			}),
		])
	} catch {
		warn()
		return { status: 'unavailable' }
	} finally {
		clearTimeout(timer)
	}
}
