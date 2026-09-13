import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { PluginAPI, ThreadState } from '@ampcode/plugin'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalHarnessEvidenceClient } from '../experimental/local-harness-evidence-client.ts'
import { startLocalHarnessEvidenceRuntime } from '../experimental/local-harness-evidence-runtime.ts'
import {
	LOCAL_PROTOCOL,
	LOCAL_PROTOCOL_VERSION,
	type Evidence,
	type ProjectAttribution,
} from '../experimental/local-harness-evidence.ts'
import {
	createExperimentalAmpShadowCollector,
	EXPERIMENTAL_AMP_SHADOW_CAPABILITIES,
	EXPERIMENTAL_AMP_SHADOW_WARNING,
} from './experimental-amp-shadow-collector.ts'
import { createLegacyAmpAdapter } from './legacy-amp-adapter.ts'

const PROJECT = '10000000-0000-4000-8000-000000000001'
const directories: string[] = []

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function root(): string {
	const value = mkdtempSync(join(tmpdir(), 'cukup-amp-shadow-'))
	directories.push(value)
	return value
}

function ids() {
	let next = 1
	return () => `30000000-0000-4000-8000-${String(next++).padStart(12, '0')}`
}

function fakeAmp(bootstrap: ThreadState = 'idle') {
	const handlers = new Map<string, Array<(event: any, context?: any) => unknown>>()
	const observers = new Map<string, Set<(state: ThreadState) => void>>()
	const warnings: unknown[][] = []
	let unsubscribed = 0
	const amp = {
		logger: { log: (...values: unknown[]) => warnings.push(values) },
		system: { workspaceRoot: null },
		$: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
		on(name: string, handler: (event: any, context?: any) => unknown) {
			const registered = handlers.get(name) ?? []
			registered.push(handler)
			handlers.set(name, registered)
			return { unsubscribe: () => { unsubscribed += 1 } }
		},
		threads: {
			get(threadId: string) {
				return {
					state: {
						get: async () => bootstrap,
						subscribe(observer: (state: ThreadState) => void) {
							const registered = observers.get(threadId) ?? new Set()
							registered.add(observer)
							observers.set(threadId, registered)
							return { unsubscribe: () => { registered.delete(observer); unsubscribed += 1 } }
						},
					},
				}
			},
		},
	} as unknown as PluginAPI
	return {
		amp,
		warnings,
		unsubscribed: () => unsubscribed,
		emit(name: string, event: unknown, context?: unknown) {
			return (handlers.get(name) ?? []).map((handler) => handler(event, context))
		},
		state(threadId: string, state: ThreadState) {
			for (const observer of observers.get(threadId) ?? []) observer(state)
		},
	}
}

function event(thread: string, id: string) {
	return { thread: { id: thread }, id, message: 'private-prompt-sentinel' }
}

function records(envelopes: unknown[]): Evidence[] {
	return envelopes.flatMap((value) => (value as { evidence: Evidence[] }).evidence)
}

function recordingClient(envelopes: unknown[], enqueueStatuses: string[] = []) {
	return {
		enqueue(value: unknown) {
			envelopes.push(value)
			const status = enqueueStatuses.shift()
			return status === 'tracking_failed'
				? { status: 'tracking_failed' as const }
				: { status: 'queued' as const, records: 1 }
		},
		async drainStep() { return { status: 'idle' as const, attempted: 0, delivered: 0, blocked: 0 } },
		close() {},
	}
}

describe('experimental Amp shadow collector', () => {
	test('emits only live execution segments and excludes the explicit approval wait', async () => {
		const directory = root()
		const harness = fakeAmp()
		const envelopes: unknown[] = []
		let now = Date.parse('2026-09-10T01:00:00.000Z')
		let attribution: ProjectAttribution = { kind: 'unassigned', reason: 'absent' }
		const collector = createExperimentalAmpShadowCollector({
			amp: harness.amp,
			runtimeStateDirectory: join(directory, 'runtime'),
			collectorStateDirectory: join(directory, 'collector'),
			projectAttribution: () => attribution,
			now: () => now,
			randomId: ids(),
			clientFactory: async () => recordingClient(envelopes),
		})
		const turn = event('thread-one', 'message-one')
		harness.emit('agent.start', turn)
		expect(envelopes).toEqual([])
		attribution = { kind: 'cukup_project', project_id: PROJECT, basis: 'approved_mapping' }
		now += 1_000
		harness.state('thread-one', 'running')
		harness.state('thread-one', 'running')
		now += 2_000
		harness.state('thread-one', 'awaiting-approval')
		now += 10_000
		attribution = { kind: 'unassigned', reason: 'ambiguous' }
		harness.state('thread-one', 'running')
		now += 3_000
		harness.emit('agent.end', { ...turn, status: 'done', messages: [] })
		await collector.dispose()

		const evidence = records(envelopes)
		expect(evidence.map((item) => [item.family, item.timing.wall_time])).toEqual([
			['execution_start', '2026-09-10T01:00:01.000Z'],
			['execution_end', '2026-09-10T01:00:03.000Z'],
			['execution_start', '2026-09-10T01:00:13.000Z'],
			['execution_end', '2026-09-10T01:00:16.000Z'],
		])
		expect((evidence[0] as any).project_attribution).toEqual({
			kind: 'cukup_project', project_id: PROJECT, basis: 'approved_mapping',
		})
		expect((evidence[2] as any).project_attribution).toEqual({ kind: 'unassigned', reason: 'ambiguous' })
		expect((evidence[1] as any).segment_id).toBe((evidence[0] as any).segment_id)
		expect((evidence[3] as any).segment_id).toBe((evidence[2] as any).segment_id)
		expect((envelopes[0] as any).capabilities).toEqual(EXPERIMENTAL_AMP_SHADOW_CAPABILITIES)
		expect(JSON.stringify(envelopes)).not.toContain('private-prompt-sentinel')
		expect(evidence.every((item) => item.recovered === false)).toBeTrue()
	})

	test('deduplicates live hooks, isolates identical message IDs by thread, and omits bootstrap state', async () => {
		const directory = root()
		const harness = fakeAmp('running')
		const envelopes: unknown[] = []
		const collector = createExperimentalAmpShadowCollector({
			amp: harness.amp,
			runtimeStateDirectory: join(directory, 'runtime'),
			collectorStateDirectory: join(directory, 'collector'),
			randomId: ids(),
			clientFactory: async () => recordingClient(envelopes),
		})
		await Bun.sleep(0)
		expect(envelopes).toEqual([])
		const one = event('one', 'same')
		const two = event('two', 'same')
		harness.emit('agent.start', one)
		harness.emit('agent.start', one)
		harness.emit('agent.start', two)
		harness.state('one', 'running')
		harness.state('one', 'running')
		harness.emit('agent.end', { ...one, status: 'done', messages: [] })
		harness.emit('agent.end', { ...one, status: 'done', messages: [] })
		expect(harness.unsubscribed()).toBe(1)
		const next = event('one', 'next')
		harness.emit('agent.start', next)
		harness.state('one', 'running')
		harness.emit('agent.end', { ...next, status: 'done', messages: [] })
		harness.state('two', 'awaiting-approval')
		await collector.dispose()
		expect(records(envelopes).map((item) => item.family)).toEqual([
			'execution_start',
			'execution_end',
			'execution_start',
			'execution_end',
		])
	})

	test('omits an end when its start was not durably queued, avoiding a FIFO blocker', async () => {
		const directory = root()
		const harness = fakeAmp()
		const envelopes: unknown[] = []
		const collector = createExperimentalAmpShadowCollector({
			amp: harness.amp,
			runtimeStateDirectory: join(directory, 'runtime'),
			collectorStateDirectory: join(directory, 'collector'),
			randomId: ids(),
			clientFactory: async () => recordingClient(envelopes, ['tracking_failed']),
		})
		const turn = event('thread', 'message')
		harness.emit('agent.start', turn)
		harness.state('thread', 'running')
		harness.emit('agent.end', { ...turn, status: 'done', messages: [] })
		await collector.dispose()
		expect(records(envelopes).map((item) => item.family)).toEqual(['execution_start'])
		expect(harness.warnings).toEqual([[EXPERIMENTAL_AMP_SHADOW_WARNING]])
	})

	test('drains existing evidence when a new start is rejected by a full real spool', async () => {
		const directory = root()
		const harness = fakeAmp()
		let now = Date.parse('2026-09-10T01:00:00.000Z')
		let available = false
		const client = new LocalHarnessEvidenceClient({
			origin: 'http://127.0.0.1:49151',
			tokenProvider: () => randomBytes(32).toString('base64url'),
			spoolPath: join(directory, 'spool.sqlite'),
			now: () => now,
			maxQueuedRecords: 1,
			fetch: async (input, init) => {
				if (!available) throw new Error('synthetic outage')
				const body = JSON.parse(String(init?.body)) as { evidence?: Array<{ evidence_id: string }> }
				return String(input).endsWith('/negotiate')
					? Response.json({ protocol: LOCAL_PROTOCOL, selected_version: LOCAL_PROTOCOL_VERSION })
					: Response.json({
						outcomes: body.evidence!.map(({ evidence_id }) => ({ evidence_id, status: 'accepted' })),
					})
			},
		})
		const collector = createExperimentalAmpShadowCollector({
			amp: harness.amp,
			runtimeStateDirectory: join(directory, 'runtime'),
			collectorStateDirectory: join(directory, 'collector'),
			now: () => now,
			randomId: ids(),
			clientFactory: async () => client,
		})
		const first = event('first', 'first')
		harness.emit('agent.start', first)
		harness.state('first', 'running')
		await Bun.sleep(20)
		expect(client.status().queued).toBe(1)

		now += 1_000
		available = true
		const second = event('second', 'second')
		harness.emit('agent.start', second)
		harness.state('second', 'running')
		await Bun.sleep(50)
		expect(client.status().queued).toBe(0)
		await collector.dispose()
		expect(harness.warnings).toEqual([[EXPERIMENTAL_AMP_SHADOW_WARNING]])
	})

	test('omits a regressed-clock end and leaves later valid evidence deliverable', async () => {
		const directory = root()
		const runtimePath = join(directory, 'runtime-clock')
		const runtime = startLocalHarnessEvidenceRuntime({ stateDirectory: runtimePath })
		const harness = fakeAmp()
		let now = Date.parse('2026-09-10T01:00:10.000Z')
		const collector = createExperimentalAmpShadowCollector({
			amp: harness.amp,
			runtimeStateDirectory: runtimePath,
			collectorStateDirectory: join(directory, 'collector-clock'),
			now: () => now,
		})
		const first = event('clock', 'first')
		harness.emit('agent.start', first)
		harness.state('clock', 'running')
		now -= 1_000
		harness.emit('agent.end', { ...first, status: 'done', messages: [] })
		now += 5_000
		const second = event('clock', 'second')
		harness.emit('agent.start', second)
		harness.state('clock', 'running')
		now += 1_000
		harness.emit('agent.end', { ...second, status: 'done', messages: [] })
		await Bun.sleep(100)
		await collector.dispose()

		const database = new Database(join(runtimePath, 'receiver.sqlite'), { readonly: true, strict: true })
		expect(database.query<{ count: number }, []>('SELECT count(*) AS count FROM execution_segments').get()!.count).toBe(2)
		expect(database.query<{ count: number }, []>('SELECT count(*) AS count FROM execution_segments WHERE end_at IS NULL').get()!.count).toBe(1)
		database.close()
		expect(harness.warnings).toEqual([[EXPERIMENTAL_AMP_SHADOW_WARNING]])
		await runtime.stop()
	})

	test('keeps a restart-lost end pending and replays a durable spool after receiver and plugin restart', async () => {
		const directory = root()
		const runtimePath = join(directory, 'runtime')
		const collectorPath = join(directory, 'collector')
		let runtime = startLocalHarnessEvidenceRuntime({ stateDirectory: runtimePath })
		const firstHarness = fakeAmp('running')
		const first = createExperimentalAmpShadowCollector({
			amp: firstHarness.amp, runtimeStateDirectory: runtimePath, collectorStateDirectory: collectorPath,
		})
		const firstTurn = event('pending', 'pending')
		firstHarness.emit('agent.start', firstTurn)
		firstHarness.state('pending', 'running')
		await Bun.sleep(30)
		await first.dispose()

		const offlineHarness = fakeAmp()
		const offline = createExperimentalAmpShadowCollector({
			amp: offlineHarness.amp, runtimeStateDirectory: runtimePath, collectorStateDirectory: collectorPath,
		})
		await Bun.sleep(30)
		await runtime.stop()
		const offlineTurn = event('offline', 'offline')
		offlineHarness.emit('agent.start', offlineTurn)
		offlineHarness.state('offline', 'running')
		await offline.dispose()

		const collectorId = readFileSync(join(collectorPath, 'collector-instance-id'), 'utf8')
		runtime = startLocalHarnessEvidenceRuntime({ stateDirectory: runtimePath })
		const restartedHarness = fakeAmp('running')
		const restarted = createExperimentalAmpShadowCollector({
			amp: restartedHarness.amp, runtimeStateDirectory: runtimePath, collectorStateDirectory: collectorPath,
		})
		await Bun.sleep(1_100)
		const liveTurn = event('live', 'live')
		restartedHarness.emit('agent.start', liveTurn)
		restartedHarness.state('live', 'running')
		await Bun.sleep(100)
		await restarted.dispose()
		expect(readFileSync(join(collectorPath, 'collector-instance-id'), 'utf8')).toBe(collectorId)

		const database = new Database(join(runtimePath, 'receiver.sqlite'), { readonly: true, strict: true })
		expect(database.query<{ count: number }, []>('SELECT count(*) AS count FROM collectors').get()!.count).toBe(1)
		expect(database.query<{ count: number }, []>('SELECT count(*) AS count FROM execution_segments').get()!.count).toBe(3)
		expect(database.query<{ count: number }, []>('SELECT count(*) AS count FROM execution_segments WHERE end_at IS NULL').get()!.count).toBe(3)
		database.close()
		await runtime.stop()
	})

	test('unsubscribes before close and leaves legacy recording/sync independent from generic failure', async () => {
		const directory = root()
		const harness = fakeAmp()
		const legacyRecords: string[] = []
		let kicks = 0
		const legacy = createLegacyAmpAdapter({
			amp: harness.amp,
			store: {
				record(value: { kind: string }) { legacyRecords.push(value.kind); return {} },
				recordEndIfStarted(value: { kind: string }) { legacyRecords.push(value.kind); return {} },
			} as never,
			sync: {
				async prepareNewTurn() {}, attributionForNewTurn() { return { schemaVersion: 1, projectSlug: null } },
				kick() { kicks += 1 }, markTrackingIncomplete() {},
			} as never,
		})
		const shadow = createExperimentalAmpShadowCollector({
			amp: harness.amp,
			runtimeStateDirectory: join(directory, 'runtime'),
			collectorStateDirectory: join(directory, 'collector'),
			randomId: ids(),
			clientFactory: async () => ({
				enqueue() { return { status: 'tracking_failed' } },
				async drainStep() { return { status: 'idle', attempted: 0, delivered: 0, blocked: 0 } },
				close() { expect(harness.unsubscribed()).toBe(3) },
			}),
		})
		const turn = event('thread', 'message')
		const context = { ui: { notify: async () => {} } }
		await Promise.all(harness.emit('agent.start', turn, context))
		harness.state('thread', 'running')
		await Promise.all(harness.emit('agent.end', { ...turn, status: 'done', messages: [] }, context))
		await shadow.dispose()
		await legacy.dispose()
		expect(legacyRecords).toEqual(['start', 'end'])
		expect(kicks).toBe(2)
		expect(harness.warnings).toEqual([[EXPERIMENTAL_AMP_SHADOW_WARNING]])
	})
})
