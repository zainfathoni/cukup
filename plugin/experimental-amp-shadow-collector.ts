import type {
	AgentEndEvent,
	AgentStartEvent,
	PluginAPI,
	Subscription,
	ThreadID,
	ThreadState,
} from '@ampcode/plugin'
import { randomUUID } from 'node:crypto'
import {
	closeSync,
	constants,
	fchmodSync,
	fsyncSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	linkSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
	LocalHarnessEvidenceClient,
	type DrainResult,
	type EnqueueResult,
} from '../experimental/local-harness-evidence-client.ts'
import { createDiscoveredLocalHarnessEvidenceClient } from '../experimental/local-harness-evidence-runtime.ts'
import {
	LOCAL_PROTOCOL,
	LOCAL_PROTOCOL_VERSION,
	isUuidV4,
	type Evidence,
	type ProjectAttribution,
} from '../experimental/local-harness-evidence.ts'

export const EXPERIMENTAL_AMP_SHADOW_CAPABILITIES = ['execution.segments'] as const

export const EXPERIMENTAL_AMP_SHADOW_WARNING =
	'Cukup experimental Amp shadow collection is incomplete; Amp work and legacy tracking are unaffected.'

const COLLECTOR_ID_FILE = 'collector-instance-id'
const SPOOL_FILE = 'spool.sqlite'
const MAX_PENDING_OBSERVATIONS = 100

type EvidenceClient = Pick<LocalHarnessEvidenceClient, 'enqueue' | 'drainStep' | 'close'>

export type ExperimentalAmpShadowCollectorOptions = Readonly<{
	amp: PluginAPI
	runtimeStateDirectory: string
	collectorStateDirectory: string
	projectAttribution?: () => ProjectAttribution
	now?: () => number
	randomId?: () => string
	clientFactory?: (options: {
		runtimeStateDirectory: string
		spoolPath: string
	}) => Promise<EvidenceClient>
}>

export type ExperimentalAmpShadowCollector = Readonly<{
	dispose: () => Promise<void>
}>

type ActiveTurn = {
	messageId: string
	segment?: { id: string; queued: boolean; startedAt: number }
}

/**
 * Experimental Amp Harness Adapter collector.
 *
 * Supported Amp facts are deliberately narrow:
 * - `agent.start` identifies a new turn for process-local correlation, but does not establish human
 *   origin or execution by itself.
 * - `ThreadState.running` means inference or tool execution is in progress;
 *   `awaiting-approval` explicitly means execution is blocked on a human.
 * - `agent.end`, and live transitions away from `running`, bound an observed execution segment.
 *
 * Session/process liveness and bootstrap thread state are not evidence. The collector therefore
 * declares no recovery capabilities and never reconstructs or closes a segment after restart.
 */
export function createExperimentalAmpShadowCollector(
	options: ExperimentalAmpShadowCollectorOptions,
): ExperimentalAmpShadowCollector {
	const { amp } = options
	const now = options.now ?? Date.now
	const randomId = options.randomId ?? randomUUID
	const collectorInstanceId = loadOrCreateCollectorInstanceId(
		options.collectorStateDirectory,
		randomId,
	)
	const clientPromise = (options.clientFactory ?? defaultClientFactory)({
		runtimeStateDirectory: options.runtimeStateDirectory,
		spoolPath: join(options.collectorStateDirectory, SPOOL_FILE),
	})
	const activeTurns = new Map<string, ActiveTurn>()
	const observedTurns = new Set<string>()
	const stateSubscriptions = new Map<string, Subscription>()
	const hookSubscriptions: Subscription[] = []
	let observations = Promise.resolve()
	let pendingObservations = 0
	let drain: Promise<void> | undefined
	let drainRequested = false
	let disposed = false
	let warningShown = false

	const warn = (): void => {
		if (warningShown) return
		warningShown = true
		amp.logger.log(EXPERIMENTAL_AMP_SHADOW_WARNING)
	}

	const kickDrain = (client: EvidenceClient): void => {
		if (disposed) return
		if (drain !== undefined) {
			drainRequested = true
			return
		}
		drain = client
			.drainStep()
			.then((result) => {
				if (isDrainFailure(result)) warn()
			})
			.catch(warn)
			.finally(() => {
				drain = undefined
				if (drainRequested) {
					drainRequested = false
					kickDrain(client)
				}
			})
	}

	const enqueue = (
		createRecords: () => Evidence[],
		onResult?: (result: EnqueueResult) => void,
	): boolean => {
		if (pendingObservations >= MAX_PENDING_OBSERVATIONS) {
			warn()
			return false
		}
		pendingObservations += 1
		observations = observations
			.then(async () => {
				const records = createRecords()
				if (records.length === 0) return
				const client = await clientPromise
				const result = client.enqueue({
					protocol: LOCAL_PROTOCOL,
					protocol_version: LOCAL_PROTOCOL_VERSION,
					collector_instance_id: collectorInstanceId,
					capabilities: [...EXPERIMENTAL_AMP_SHADOW_CAPABILITIES],
					evidence: records,
				})
				onResult?.(result)
				if (isEnqueueFailure(result)) warn()
				kickDrain(client)
			})
			.catch(warn)
			.finally(() => {
				pendingObservations -= 1
			})
		return true
	}

	const attribution = (): ProjectAttribution => {
		try {
			const value = options.projectAttribution?.()
			return value ? structuredClone(value) : { kind: 'unassigned', reason: 'absent' }
		} catch {
			warn()
			return { kind: 'unassigned', reason: 'absent' }
		}
	}

	const startSegment = (threadId: string, observedAt: number): void => {
		const turn = activeTurns.get(threadId)
		if (!turn || turn.segment) return
		const segmentId = checkedRandomId(randomId)
		const evidenceId = checkedRandomId(randomId)
		const segment = { id: segmentId, queued: false, startedAt: observedAt }
		turn.segment = segment
		const projectAttribution = attribution()
		const accepted = enqueue(
			() => [
				{
					family: 'execution_start',
					evidence_id: evidenceId,
					segment_id: segmentId,
					recovered: false,
					timing: observationTiming(observedAt),
					project_attribution: projectAttribution,
				},
			],
			(result) => {
				segment.queued = result.status === 'queued'
			},
		)
		if (!accepted) delete turn.segment
	}

	const endSegment = (threadId: string, observedAt: number): void => {
		const turn = activeTurns.get(threadId)
		if (!turn?.segment) return
		const segment = turn.segment
		delete turn.segment
		if (observedAt < segment.startedAt) {
			warn()
			return
		}
		enqueue(() =>
			segment.queued
				? [
					{
						family: 'execution_end',
						evidence_id: checkedRandomId(randomId),
						segment_id: segment.id,
						recovered: false,
						timing: observationTiming(observedAt),
					},
				]
				: [],
		)
	}

	const observeState = (threadId: string, state: ThreadState, observedAt: number): void => {
		if (disposed || !activeTurns.has(threadId)) return
		if (state === 'running') startSegment(threadId, observedAt)
		else endSegment(threadId, observedAt)
	}

	const observeThread = (threadId: string): void => {
		if (disposed || stateSubscriptions.has(threadId)) return
		try {
			const state = amp.threads.get(threadId as ThreadID).state
			stateSubscriptions.set(
				threadId,
				state.subscribe((value) => {
					try {
						observeState(threadId, value, now())
					} catch {
						warn()
					}
				}),
			)
		} catch {
			warn()
		}
	}

	const onAgentStart = (event: AgentStartEvent): void => {
		if (disposed) return
		const threadId = event.thread.id as string
		const messageId = String(event.id)
		const turnKey = `${threadId}\0${messageId}`
		if (observedTurns.has(turnKey)) return
		observedTurns.add(turnKey)
		activeTurns.set(threadId, { messageId })
		observeThread(threadId)
	}

	const onAgentEnd = (event: AgentEndEvent): void => {
		if (disposed) return
		const threadId = event.thread.id as string
		const active = activeTurns.get(threadId)
		if (!active || active.messageId !== String(event.id)) return
		endSegment(threadId, now())
		activeTurns.delete(threadId)
		stateSubscriptions.get(threadId)?.unsubscribe()
		stateSubscriptions.delete(threadId)
	}

	hookSubscriptions.push(
		amp.on('agent.start', (event) => {
			try {
				onAgentStart(event)
			} catch {
				warn()
			}
			return {}
		}),
	)
	hookSubscriptions.push(
		amp.on('agent.end', (event) => {
			try {
				onAgentEnd(event)
			} catch {
				warn()
			}
		}),
	)
	void clientPromise.then(kickDrain).catch(warn)

	return {
		async dispose(): Promise<void> {
			if (disposed) return
			disposed = true
			for (const subscription of hookSubscriptions) subscription.unsubscribe()
			for (const subscription of stateSubscriptions.values()) subscription.unsubscribe()
			await observations
			await drain
			try {
				const client = await clientPromise
				client.close()
			} catch {
				warn()
			}
		},
	}
}

async function defaultClientFactory(options: {
	runtimeStateDirectory: string
	spoolPath: string
}): Promise<EvidenceClient> {
	return createDiscoveredLocalHarnessEvidenceClient({
		stateDirectory: options.runtimeStateDirectory,
		spoolPath: options.spoolPath,
		requestTimeoutMs: 1_000,
	})
}

function observationTiming(wallTimeMs: number) {
	return {
		wall_time: new Date(wallTimeMs).toISOString(),
		provenance: 'collector_observation' as const,
		precision_ms: 1,
	}
}

function checkedRandomId(randomId: () => string): string {
	const value = randomId()
	if (!isUuidV4(value)) throw new Error('Experimental collector identity generation failed')
	return value
}

function isEnqueueFailure(result: EnqueueResult): boolean {
	return result.status !== 'queued'
}

function isDrainFailure(result: DrainResult): boolean {
	return result.status !== 'idle' && result.status !== 'delivered'
}

function loadOrCreateCollectorInstanceId(directory: string, randomId: () => string): string {
	try {
		return loadOrCreateCollectorInstanceIdUnsafe(directory, randomId)
	} catch {
		throw new Error('Experimental collector state is unavailable')
	}
}

function loadOrCreateCollectorInstanceIdUnsafe(directory: string, randomId: () => string): string {
	validateStateDirectory(directory)
	const path = join(directory, COLLECTOR_ID_FILE)
	try {
		return readCollectorInstanceId(path)
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
			throw error
		}
	}

	const value = checkedRandomId(randomId)
	const temporaryPath = `${path}.${checkedRandomId(randomId)}.tmp`
	let descriptor: number | undefined
	try {
		descriptor = openSync(
			temporaryPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		)
		writeFileSync(descriptor, value)
		fchmodSync(descriptor, 0o600)
		fsyncSync(descriptor)
		closeSync(descriptor)
		descriptor = undefined
		try {
			linkSync(temporaryPath, path)
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
			rmSync(temporaryPath, { force: true })
			return readCollectorInstanceId(path)
		}
		rmSync(temporaryPath)
		const directoryDescriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY)
		try {
			fsyncSync(directoryDescriptor)
		} finally {
			closeSync(directoryDescriptor)
		}
		return value
	} catch {
		if (descriptor !== undefined) closeSync(descriptor)
		try {
			rmSync(temporaryPath, { force: true })
		} catch {}
		throw new Error()
	}
}

function readCollectorInstanceId(path: string): string {
	const stat = lstatSync(path)
	const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
	if (!stat.isFile() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) throw new Error()
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
	try {
		if ((fstatSync(descriptor).mode & 0o777) !== 0o600) throw new Error()
		const value = readFileSync(descriptor, 'utf8')
		if (!isUuidV4(value)) throw new Error()
		return value
	} finally {
		closeSync(descriptor)
	}
}

function validateStateDirectory(path: string): void {
	if (!isAbsolute(path) || path !== path.trim() || resolve(path) !== path || path === '/') {
		throw new Error('Experimental collector state is unavailable')
	}
	const parent = dirname(path)
	if (realpathSync(parent) !== parent) throw new Error('Experimental collector state is unavailable')
	try {
		mkdirSync(path, { mode: 0o700 })
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
			throw new Error('Experimental collector state is unavailable')
		}
	}
	const stat = lstatSync(path)
	const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		realpathSync(path) !== path ||
		(uid !== undefined && stat.uid !== uid)
	) {
		throw new Error('Experimental collector state is unavailable')
	}
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
	try {
		fchmodSync(descriptor, 0o700)
	} finally {
		closeSync(descriptor)
	}
}
