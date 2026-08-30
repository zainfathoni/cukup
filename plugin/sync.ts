import { TokenProviderError, type TokenProvider } from './auth.ts'
import {
	MAX_CLIENT_CLOCK_SKEW_MS,
	ServiceRequestError,
	type CukupServiceClient,
} from './protocol.ts'
import type { WorkHoursStore } from './store.ts'

export const OUTBOX_BATCH_SIZE = 50
export const RETRY_INITIAL_MS = 1_000
export const RETRY_MAX_MS = 5 * 60 * 1_000
export const RETRY_JITTER = 0.2

export type SyncCycleResult = {
	authoritativeSummary: boolean
	errorKind?: string
}

type Timer = ReturnType<typeof setTimeout>

export type SyncEngineOptions = {
	store: WorkHoursStore
	client?: CukupServiceClient
	tokenProvider?: TokenProvider
	now?: () => number
	random?: () => number
	setTimer?: (callback: () => void, delayMs: number) => Timer
	clearTimer?: (timer: Timer) => void
}

export class SyncEngine {
	readonly #store: WorkHoursStore
	readonly #client: CukupServiceClient | undefined
	readonly #tokenProvider: TokenProvider | undefined
	readonly #now: () => number
	readonly #random: () => number
	readonly #setTimer: (callback: () => void, delayMs: number) => Timer
	readonly #clearTimer: (timer: Timer) => void
	#timer: Timer | undefined
	#running: Promise<SyncCycleResult> | undefined
	#deferredDelayMs: number | undefined
	#disposed = false
	#trackingIncomplete: boolean

	constructor(options: SyncEngineOptions) {
		this.#store = options.store
		this.#client = options.client
		this.#tokenProvider = options.tokenProvider
		this.#now = options.now ?? Date.now
		this.#random = options.random ?? Math.random
		this.#setTimer = options.setTimer ?? setTimeout
		this.#clearTimer = options.clearTimer ?? clearTimeout
		this.#trackingIncomplete = this.#store.trackingIncomplete()
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

	markTrackingIncomplete(): void {
		this.#trackingIncomplete = true
		try {
			this.#store.markTrackingIncomplete()
		} catch {
			// The in-memory warning remains visible when SQLite cannot persist it.
		}
	}

	trackingIncomplete(): boolean {
		return this.#trackingIncomplete
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
		let token = ''
		try {
			token = await this.#tokenProvider!.getToken()
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
			if (kind === 'local-state') this.markTrackingIncomplete()
			this.#recordFailure(kind, kind !== 'local-state')
			return { authoritativeSummary: false, errorKind: kind }
		} finally {
			token = ''
		}
	}

	#recordFailure(kind: string, retryable: boolean): void {
		const nowMs = this.#now()
		try {
			const attempt = this.#store.syncState().attemptCount + 1
			const nextAttemptAtMs = retryable ? nowMs + retryDelay(attempt, this.#random()) : null
			this.#store.recordSyncFailure(kind, attempt, nextAttemptAtMs, nowMs)
			if (nextAttemptAtMs !== null) this.#schedule(nextAttemptAtMs - nowMs)
		} catch {
			this.#trackingIncomplete = true
			try {
				this.#store.markTrackingIncomplete()
			} catch {
				// The in-memory warning remains visible when SQLite cannot persist it.
			}
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

export function retryDelay(attempt: number, random: number): number {
	const exponent = Math.max(0, Math.min(30, attempt - 1))
	const base = Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** exponent)
	const boundedRandom = Math.max(0, Math.min(1, random))
	const jittered = base * (1 - RETRY_JITTER + 2 * RETRY_JITTER * boundedRandom)
	return Math.max(1, Math.min(RETRY_MAX_MS, Math.round(jittered)))
}
