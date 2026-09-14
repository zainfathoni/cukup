import { TokenProviderError, type TokenProvider } from './auth.ts'
import {
	EVENT_SCHEMA_VERSION_V1,
	EVENT_SCHEMA_VERSION_V2,
	MAX_CLIENT_CLOCK_SKEW_MS,
	ServiceRequestError,
	type CukupServiceClient,
	type ServiceCapabilities,
} from './protocol.ts'
import {
	UNASSIGNED_V1_ATTRIBUTION,
	type EventAttribution,
	type TrackingGap,
	type TrackingGapReason,
	type WorkHoursStore,
} from './store.ts'

export const OUTBOX_BATCH_SIZE = 50
export const RETRY_INITIAL_MS = 1_000
export const RETRY_MAX_MS = 5 * 60 * 1_000
export const RETRY_JITTER = 0.2
export const REMOTE_EXECUTOR_LABEL = 'amp-orb' as const

export type SyncCycleResult = {
	authoritativeSummary: boolean
	errorKind?: string
}

export type ExecutorProfile =
	| { kind: 'local'; hostname: string }
	| { kind: 'remote'; executorLabel: typeof REMOTE_EXECUTOR_LABEL }

type Timer = ReturnType<typeof setTimeout>

export type SyncEngineOptions = {
	store: WorkHoursStore
	client?: CukupServiceClient
	tokenProvider?: TokenProvider
	now?: () => number
	random?: () => number
	setTimer?: (callback: () => void, delayMs: number) => Timer
	clearTimer?: (timer: Timer) => void
	executorProfile?: ExecutorProfile
}

export class SyncEngine {
	readonly #store: WorkHoursStore
	readonly #client: CukupServiceClient | undefined
	readonly #tokenProvider: TokenProvider | undefined
	readonly #now: () => number
	readonly #random: () => number
	readonly #setTimer: (callback: () => void, delayMs: number) => Timer
	readonly #clearTimer: (timer: Timer) => void
	readonly #executorProfile: ExecutorProfile | undefined
	#timer: Timer | undefined
	#running: Promise<SyncCycleResult> | undefined
	#deferredDelayMs: number | undefined
	#disposed = false
	#trackingGap: TrackingGap | undefined
	#preferredNewEventSchemaVersion: 1 | 2 = EVENT_SCHEMA_VERSION_V1
	#attributionConfigured = false
	#attributionReady: Promise<void> | undefined
	#executorProfileBound = false

	constructor(options: SyncEngineOptions) {
		this.#store = options.store
		this.#client = options.client
		this.#tokenProvider = options.tokenProvider
		this.#now = options.now ?? Date.now
		this.#random = options.random ?? Math.random
		this.#setTimer = options.setTimer ?? setTimeout
		this.#clearTimer = options.clearTimer ?? clearTimeout
		this.#executorProfile = options.executorProfile
		this.#trackingGap = this.#store.trackingGap()
	}

	start(): void {
		if (!this.#client || !this.#tokenProvider) return
		const state = this.#store.syncState()
		const delay = Math.max(0, (state.nextAttemptAtMs ?? this.#now()) - this.#now())
		this.#schedule(delay)
	}

	kick(): void {
		if (!this.#client || !this.#tokenProvider) return
		this.#schedule(0)
	}

	markTrackingIncomplete(reason: TrackingGapReason): void {
		const atMs = this.#now()
		try {
			this.#store.markTrackingIncomplete(reason, atMs)
			this.#trackingGap = this.#store.trackingGap()
		} catch {
			this.#trackingGap = mergeTrackingGap(this.#trackingGap, reason, atMs)
		}
	}

	trackingGap(): TrackingGap | undefined {
		return this.#trackingGap
	}

	acknowledgeTrackingGap(): void {
		this.#store.acknowledgeTrackingGap()
		this.#trackingGap = undefined
	}

	async prepareNewTurn(): Promise<void> {
		if (this.#attributionConfigured) return
		let ready = this.#attributionReady
		if (!ready) {
			void this.runNow()
			ready = this.#attributionReady
		}
		await ready
	}

	attributionForNewTurn(projectSlug: string | null): EventAttribution {
		return this.#preferredNewEventSchemaVersion === EVENT_SCHEMA_VERSION_V2
			? { schemaVersion: EVENT_SCHEMA_VERSION_V2, projectSlug }
			: UNASSIGNED_V1_ATTRIBUTION
	}

	async runNow(): Promise<SyncCycleResult> {
		if (this.#disposed) return { authoritativeSummary: false, errorKind: 'disposed' }
		if (!this.#client || !this.#tokenProvider) {
			return { authoritativeSummary: false, errorKind: 'configuration' }
		}
		if (this.#timer) {
			this.#clearTimer(this.#timer)
			this.#timer = undefined
		}
		if (this.#running) return this.#running
		this.#running = this.#runCycle().finally(() => {
			this.#running = undefined
			if (this.#deferredDelayMs !== undefined) {
				const delay = this.#deferredDelayMs
				this.#deferredDelayMs = undefined
				this.#schedule(delay)
			}
		})
		return this.#running
	}

	async dispose(): Promise<void> {
		this.#disposed = true
		if (this.#timer) {
			this.#clearTimer(this.#timer)
			this.#timer = undefined
		}
		await this.#running
	}

	async #runCycle(): Promise<SyncCycleResult> {
		let markAttributionReady = () => {}
		const attributionReady = new Promise<void>((resolve) => {
			markAttributionReady = resolve
		})
		this.#attributionReady = attributionReady
		let token = ''
		try {
			token = await this.#tokenProvider!.getToken()
			await this.#configureAttribution(token)
			this.#attributionConfigured = true
			markAttributionReady()
			const clock = await this.#client!.sampleTime(token)
			this.#store.recordClockSample(clock)

			if (Math.abs(clock.offsetMs) > MAX_CLIENT_CLOCK_SKEW_MS) {
				const summary = await this.#client!.fetchSummary(token)
				this.#store.cacheSummary(summary, this.#now())
				this.#recordFailure('clock-skew', true)
				return { authoritativeSummary: true, errorKind: 'clock-skew' }
			}

			for (let batchNumber = 0; batchNumber < 10; batchNumber += 1) {
				const events = this.#store.pendingEvents(OUTBOX_BATCH_SIZE)
				if (events.length === 0) break
				const results = await this.#client!.uploadBatch(token, events)
				this.#store.applyDeliveryResults(results)
				if (results.length !== events.length) {
					this.#recordFailure('partial-response', true)
					return { authoritativeSummary: false, errorKind: 'partial-response' }
				}
			}

			const summary = await this.#client!.fetchSummary(token)
			this.#store.cacheSummary(summary, this.#now())
			this.#store.recordSyncSuccess()
			if (this.#store.outboxCounts().pending > 0) this.#schedule(0)
			return { authoritativeSummary: true }
		} catch (error) {
			if (error instanceof ServiceRequestError) {
				this.#recordFailure(error.kind, error.retryable)
				return { authoritativeSummary: false, errorKind: error.kind }
			}
			const kind =
				error instanceof TokenProviderError ? `authentication-${error.kind}` : 'local-state'
			if (kind === 'local-state') this.markTrackingIncomplete('sync-local-state')
			this.#recordFailure(kind, kind !== 'local-state')
			return { authoritativeSummary: false, errorKind: kind }
		} finally {
			markAttributionReady()
			if (this.#attributionReady === attributionReady) this.#attributionReady = undefined
			token = ''
		}
	}

	async #configureAttribution(token: string): Promise<void> {
		if (!this.#executorProfile) return
		const capabilities = await this.#client!.fetchCapabilities(token)
		const hasPendingV2 = this.#store.hasPendingEventSchema(EVENT_SCHEMA_VERSION_V2)
		if (!capabilities) {
			if (hasPendingV2) throw new ServiceRequestError('protocol', false)
			this.#preferredNewEventSchemaVersion = EVENT_SCHEMA_VERSION_V1
			return
		}

		const acceptsV2 = supportsEventSchema(capabilities, EVENT_SCHEMA_VERSION_V2)
		const prefersV2 = capabilities.preferredNewEventSchemaVersion === EVENT_SCHEMA_VERSION_V2
		const requiresV2 = hasPendingV2 || prefersV2
		if (requiresV2 && !acceptsV2) throw new ServiceRequestError('protocol', false)

		if (requiresV2 && this.#executorProfile.kind === 'local') {
			if (!this.#executorProfileBound) {
				await this.#client!.bindExecutorProfile(token, this.#executorProfile.hostname)
				this.#executorProfileBound = true
			}
		}

		this.#preferredNewEventSchemaVersion =
			prefersV2 && acceptsV2 ? EVENT_SCHEMA_VERSION_V2 : EVENT_SCHEMA_VERSION_V1
	}

	#recordFailure(kind: string, retryable: boolean): void {
		const nowMs = this.#now()
		try {
			const attempt = this.#store.syncState().attemptCount + 1
			const nextAttemptAtMs = retryable ? nowMs + retryDelay(attempt, this.#random()) : null
			this.#store.recordSyncFailure(kind, attempt, nextAttemptAtMs, nowMs)
			if (nextAttemptAtMs !== null) this.#schedule(nextAttemptAtMs - nowMs)
		} catch {
			this.markTrackingIncomplete('sync-state-persistence')
		}
	}

	#schedule(delayMs: number): void {
		if (this.#disposed || this.#timer) return
		if (this.#running) {
			this.#deferredDelayMs = Math.min(this.#deferredDelayMs ?? Number.POSITIVE_INFINITY, delayMs)
			return
		}
		this.#timer = this.#setTimer(() => {
			this.#timer = undefined
			void this.runNow()
		}, Math.max(0, delayMs))
		this.#timer.unref?.()
	}
}

function mergeTrackingGap(
	existing: TrackingGap | undefined,
	reason: TrackingGapReason,
	atMs: number,
): TrackingGap {
	return {
		firstObservedAtMs:
			existing?.firstObservedAtMs === null
				? null
				: Math.min(existing?.firstObservedAtMs ?? atMs, atMs),
		lastObservedAtMs: Math.max(existing?.lastObservedAtMs ?? atMs, atMs),
		reasons: [...new Set([...(existing?.reasons ?? []), reason])],
	}
}

function supportsEventSchema(capabilities: ServiceCapabilities, version: 1 | 2): boolean {
	return capabilities.acceptedEventSchemaVersions.includes(version)
}

export function retryDelay(attempt: number, random: number): number {
	const exponent = Math.max(0, Math.min(30, attempt - 1))
	const base = Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** exponent)
	const boundedRandom = Math.max(0, Math.min(1, random))
	const jittered = base * (1 - RETRY_JITTER + 2 * RETRY_JITTER * boundedRandom)
	return Math.max(1, Math.min(RETRY_MAX_MS, Math.round(jittered)))
}
