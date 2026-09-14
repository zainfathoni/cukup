import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { PluginAPI, PluginExecutorKind, ThreadState } from '@ampcode/plugin'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../service/app.ts'
import { ServiceLogger } from '../service/logger.ts'
import { ServiceStore } from '../service/store.ts'
import { createFileTokenProvider } from './auth.ts'
import { EXPERIMENTAL_AMP_SHADOW_WARNING } from './experimental-amp-shadow-collector.ts'
import { startExperimentalPhysicalAmpShadow } from './experimental-physical-amp-shadow.ts'
import workHoursPlugin from './index.ts'
import { createLegacyAmpAdapter } from './legacy-amp-adapter.ts'
import { CukupServiceClient } from './protocol.ts'
import { WorkHoursStore } from './store.ts'
import { SyncEngine } from './sync.ts'

const NOW = Date.parse('2026-09-14T12:00:00.000Z')
const HOST = 'private-host-sentinel'
const TOKEN = 'cukup_v1_private-token-sentinel-abcdefghijklmnopqrstuvwxyz'
const roots: string[] = []
const cleanups: Array<() => unknown | Promise<unknown>> = []

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function harness(kind: PluginExecutorKind = 'local') {
	const hooks = new Map<string, Set<(event: any, ctx?: any) => unknown>>()
	const observers = new Map<string, Set<(state: ThreadState) => void>>()
	const commands = new Map<string, (ctx: any) => Promise<void>>()
	const disposers: Array<() => Promise<void>> = []
	const logs: unknown[] = []
	let reads = 0
	let shellCalls = 0
	const amp = {
		system: { executor: { kind }, workspaceRoot: null, user: { workspace: null } },
		onDispose(handler: () => Promise<void>) { disposers.push(handler) },
		logger: { log: (value: unknown) => logs.push(value) },
		$: async () => { shellCalls++; throw new Error('OIDC shell must not be used') },
		on(name: string, handler: (event: any, ctx?: any) => unknown) {
			const set = hooks.get(name) ?? new Set()
			set.add(handler)
			hooks.set(name, set)
			return { unsubscribe() { set.delete(handler) } }
		},
		registerCommand(name: string, _options: unknown, handler: (ctx: any) => Promise<void>) {
			commands.set(name, handler)
			return { unsubscribe() { commands.delete(name) } }
		},
		threads: { get(id: string) { return { state: {
			get: async () => { reads++; return 'running' },
			subscribe(observer: (state: ThreadState) => void) {
				const set = observers.get(id) ?? new Set()
				set.add(observer)
				observers.set(id, set)
				return { unsubscribe() { set.delete(observer) } }
			},
		} } } },
	} as unknown as PluginAPI
	return {
		amp, logs, commands, disposers,
		reads: () => reads,
		shellCalls: () => shellCalls,
		subscriptions: () => [...hooks.values(), ...observers.values()].reduce((n, set) => n + set.size, 0),
		emit(name: string, id = 'private-message-sentinel') {
			const event = { thread: { id: 'private-thread-sentinel' }, id, status: 'done',
				message: 'private-prompt-sentinel', messages: ['private-output-sentinel'] }
			return [...(hooks.get(name) ?? [])].map((handler) => handler(event, { ui: { notify: async () => {} } }))
		},
		state(state: ThreadState) {
			for (const observer of observers.get('private-thread-sentinel') ?? []) observer(state)
		},
	}
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'cukup-stage5d-'))
	roots.push(root)
	const tokenFile = join(root, 'private-token-path')
	writeFileSync(tokenFile, TOKEN, { mode: 0o600 })
	const directory = join(root, 'amp-work-hours', 'experimental-physical-amp-shadow')
	const spool = join(directory, 'spool.sqlite')
	let now = NOW
	const options = {
		serviceURL: 'https://cukup.invalid',
		tokenProvider: createFileTokenProvider(tokenFile),
		executorProfile: { kind: 'local' as const, hostname: HOST },
		env: { CUKUP_EXPERIMENTAL_PHYSICAL_AMP_SHADOW: '1', XDG_STATE_HOME: root },
		now: () => now,
		fetch: async (_url: string, _init: RequestInit): Promise<Response> => { throw new Error('private-outage-sentinel') },
	}
	return { root, tokenFile, directory, spool, options, advance: (ms: number) => { now += ms } }
}

function start(h: ReturnType<typeof harness>, f: ReturnType<typeof fixture>) {
	const value = startExperimentalPhysicalAmpShadow(h.amp, f.options)!
	expect(value).toBeDefined()
	cleanups.push(() => value.dispose())
	return value
}

function rows(path: string) {
	const db = new Database(path, { readonly: true })
	try {
		return db.query<{ sequence: number; envelope: string }, []>(
			'SELECT source_sequence AS sequence, envelope_json AS envelope FROM physical_shadow_outbox ORDER BY source_sequence',
		).all()
	} finally { db.close() }
}

// Let the collector's bounded observation queue and in-process response promises settle.
async function settle() { await Bun.sleep(20) }

test('plugin entrypoint activates only the exact physical flag and keeps legacy commands/status independent', async () => {
	const savedFetch = globalThis.fetch
	const keys = ['XDG_STATE_HOME', 'CUKUP_TOKEN_FILE', 'CUKUP_SERVICE_URL',
		'CUKUP_EXPERIMENTAL_PHYSICAL_AMP_SHADOW', 'CUKUP_EXPERIMENTAL_AMP_SHADOW']
	const previous = keys.map((key) => process.env[key])
	try {
		for (const flag of [undefined, 'true', '1']) {
			const f = fixture()
			const h = harness()
			const requests: string[] = []
			globalThis.fetch = (async (input: string | URL | Request) => {
				requests.push(String(input))
				return Response.json({}, { status: 503 })
			}) as typeof fetch
			process.env.XDG_STATE_HOME = f.root
			process.env.CUKUP_TOKEN_FILE = f.tokenFile
			process.env.CUKUP_SERVICE_URL = 'https://cukup.invalid'
			delete process.env.CUKUP_EXPERIMENTAL_AMP_SHADOW
			if (flag === undefined) delete process.env.CUKUP_EXPERIMENTAL_PHYSICAL_AMP_SHADOW
			else process.env.CUKUP_EXPERIMENTAL_PHYSICAL_AMP_SHADOW = flag
			workHoursPlugin(h.amp)
			try {
				expect(h.commands.has('experimental-physical-shadow')).toBe(flag === '1')
				expect(h.commands.has('work-hours-status')).toBeTrue()
				await Promise.all(h.emit('agent.start')); h.state('running')
				await Promise.all(h.emit('agent.end'))
				await settle()
				const messages: string[] = []
				await h.commands.get('work-hours-status')!({ ui: {
					select: async (dialog: { message: string }) => { messages.push(dialog.message); return 'Close' },
				} })
				expect(messages).toHaveLength(1)
				expect(messages[0]).not.toContain('shadow')
				expect(requests.some((url) => url.endsWith('/v1/executor-profile'))).toBe(flag === '1')
				if (flag === '1') expect(rows(f.spool)).toHaveLength(3)
				else expect(readdirSync(join(f.root, 'amp-work-hours'))).not.toContain('experimental-physical-amp-shadow')
			} finally {
				for (const dispose of h.disposers) await dispose()
			}
		}
	} finally {
		globalThis.fetch = savedFetch
		keys.forEach((key, i) => {
			if (previous[i] === undefined) delete process.env[key]
			else process.env[key] = previous[i]
		})
	}
})

test('exact physical opt-in only; default, near matches, remote/OIDC/orb and unknown create no state or hooks', async () => {
	for (const optIn of [undefined, '', 'true', '01', ' 1', '1 ', '0']) {
		const f = fixture()
		const h = harness()
		const env = { ...f.options.env, CUKUP_EXPERIMENTAL_PHYSICAL_AMP_SHADOW: optIn,
			CUKUP_EXPERIMENTAL_AMP_SHADOW: '1' }
		expect(startExperimentalPhysicalAmpShadow(h.amp, { ...f.options, env })).toBeUndefined()
		expect(readdirSync(f.root)).toEqual(['private-token-path'])
		expect(h.subscriptions()).toBe(0)
		expect(h.commands.size).toBe(0)
		expect(h.logs).toEqual([])
	}
	for (const kind of ['remote', 'unknown'] as const) {
		const f = fixture()
		const h = harness(kind)
		let tokenCalls = 0
		f.options.tokenProvider = { getToken: async () => { tokenCalls++; return TOKEN } }
		expect(startExperimentalPhysicalAmpShadow(h.amp, f.options)).toBeUndefined()
		await settle()
		expect(tokenCalls).toBe(0)
		expect(h.shellCalls()).toBe(0)
		expect(readdirSync(f.root)).toEqual(['private-token-path'])
		expect(h.subscriptions()).toBe(0)
		expect(h.logs).toEqual([EXPERIMENTAL_AMP_SHADOW_WARNING])
	}
	const f = fixture()
	const h = harness()
	expect(startExperimentalPhysicalAmpShadow(h.amp, { ...f.options, serviceURL: 'http://cukup.invalid' })).toBeUndefined()
	expect(h.subscriptions()).toBe(0)
	expect(h.logs).toEqual([EXPERIMENTAL_AMP_SHADOW_WARNING])
})

test('real supported hooks persist only defensible execution facts, with private spool and byte-isolated legacy state', async () => {
	const f = fixture()
	const legacyPath = join(f.root, 'amp-work-hours', 'state.sqlite')
	const legacy = new WorkHoursStore(legacyPath)
	legacy.record({ threadId: 'legacy', messageId: 'one', kind: 'start', atMs: NOW })
	legacy.record({ threadId: 'legacy', messageId: 'two', kind: 'start', atMs: NOW + 1 }, undefined,
		{ schemaVersion: 2, projectSlug: 'legacy-project' })
	legacy.close()
	const legacyBytes = readFileSync(legacyPath)
	const h = harness()
	let calls = 0
	const durableAtRequest: Array<ReturnType<typeof rows>> = []
	f.options.fetch = async () => {
		calls++
		// A separate reader must see the committed record before even the profile request.
		durableAtRequest.push(rows(f.spool))
		throw new Error('private-outage-sentinel')
	}
	const value = start(h, f)
	await settle()
	expect(calls).toBe(1)
	expect(h.reads()).toBe(0)
	expect(h.emit('agent.start')).toEqual([{}])
	h.emit('agent.start')
	expect(rows(f.spool)).toHaveLength(1)
	f.advance(1_000); h.state('running'); h.state('running')
	f.advance(2_000); h.state('awaiting-approval')
	f.advance(10_000); h.state('running')
	f.advance(3_000); h.emit('agent.end'); h.emit('agent.end')
	await settle()
	expect(calls).toBe(2)
	expect(durableAtRequest[0]?.[0]?.sequence).toBe(1)
	const envelopes = rows(f.spool).map((r) => JSON.parse(r.envelope))
	const declaration = envelopes[0].fact
	expect(declaration).toMatchObject({ family: 'capability_declaration', effective_at: new Date(NOW).toISOString() })
	expect(envelopes[0].capabilities).toEqual(['execution.segments'])
	const evidence = envelopes.slice(1).map((envelope) => envelope.evidence[0])
	expect(evidence.map((e) => [e.family, Date.parse(e.timing.wall_time) - NOW])).toEqual([
		['execution_start', 1_000], ['execution_end', 3_000],
		['execution_start', 13_000], ['execution_end', 16_000],
	])
	expect(evidence[0].segment_id).toBe(evidence[1].segment_id)
	expect(evidence[2].segment_id).toBe(evidence[3].segment_id)
	expect(evidence[0].segment_id).not.toBe(evidence[2].segment_id)
	expect(evidence[0].project_attribution).toEqual({ kind: 'unassigned', reason: 'absent' })
	expect(evidence.every((e) => e.recovered === false && e.timing.provenance === 'collector_observation')).toBeTrue()
	const dialogs: unknown[] = []
	await h.commands.get('experimental-physical-shadow')!({ ui: {
		select: async (dialog: unknown) => { dialogs.push(dialog); return 'Close' },
	} })
	expect(calls).toBe(2)
	expect(value.status()).toMatchObject({ queued: 5, blocked: 0, retrying: 1 })
	await value.dispose()
	expect(h.subscriptions()).toBe(0)
	expect(h.commands.size).toBe(0)
	expect(readFileSync(legacyPath)).toEqual(legacyBytes)
	expect(statSync(f.directory).mode & 0o777).toBe(0o700)
	const persisted = readdirSync(f.directory).map((name) => {
		expect(statSync(join(f.directory, name)).mode & 0o777).toBe(0o600)
		return readFileSync(join(f.directory, name)).toString()
	}).join('')
	for (const secret of ['private-thread-sentinel', 'private-message-sentinel', 'private-prompt-sentinel',
		'private-output-sentinel', 'private-outage-sentinel', HOST, TOKEN, f.root, f.tokenFile]) {
		expect(persisted + JSON.stringify([dialogs, h.logs])).not.toContain(secret)
	}
})

test('outage/restart, response loss/duplicate and bearer-file rotation replay exact durable identity and order', async () => {
	const f = fixture()
	const store = new ServiceStore(join(f.root, 'service.sqlite'))
	cleanups.push(() => store.close())
	const first = store.issueBearer(NOW)
	writeFileSync(f.tokenFile, first.token)
	const logs: string[] = []
	const app = createApp({ store, now: f.options.now, apiHostname: 'cukup.invalid', fleetHostnames: new Set([HOST]),
		oidcVerifier: { verify: async () => false }, logger: new ServiceLogger((line) => logs.push(line)) })
	const h = harness()
	const offline = start(h, f)
	h.emit('agent.start'); h.state('running'); f.advance(2_000); h.emit('agent.end')
	await settle()
	const exact = rows(f.spool)
	expect(exact.map((r) => r.sequence)).toEqual([1, 2, 3])
	await offline.dispose()
	f.advance(1_000)
	let loseResponse = true
	const bodies: string[] = []
	const bearers: string[] = []
	f.options.fetch = async (url, init) => {
		bearers.push(String((init.headers as Record<string, string>).authorization))
		const response = await app.fetch(new Request(url, init))
		if (url.endsWith('/v1/shadow-evidence')) {
			bodies.push(String(init.body))
			if (loseResponse) { loseResponse = false; throw new Error('private-response-loss') }
		}
		return response
	}
	const restarted = start(harness(), f)
	await settle()
	expect(store.shadow.coverageRecords()).toHaveLength(1)
	expect(store.shadow.records()).toHaveLength(0)
	expect(rows(f.spool).map((row) => row.sequence)).toEqual([2, 3])
	expect(await restarted.drainStep()).toMatchObject({ status: 'retryable' })
	expect(await restarted.drainStep()).toMatchObject({ status: 'backoff' })
	const replacement = store.rotateBearer(first.tokenId, NOW + 1)
	writeFileSync(f.tokenFile, replacement.token)
	f.advance(5_000)
	expect(await restarted.drainStep()).toMatchObject({ status: 'delivered', delivered: 1 })
	expect(bodies[0]).toBe(bodies[1])
	expect(store.shadow.records()).toHaveLength(1)
	expect(bearers.slice(-2)).toEqual([`Bearer ${replacement.token}`, `Bearer ${replacement.token}`])
	expect(rows(f.spool).map((r) => r.sequence)).toEqual([3])
	// A single explicit step did not loop through the remainder.
	await settle()
	expect(rows(f.spool)).toHaveLength(1)
	expect(await restarted.drainStep()).toMatchObject({ status: 'delivered' })
	expect(store.shadow.records()).toHaveLength(2)
	expect(restarted.status()).toMatchObject({ queued: 0, blocked: 0 })
	expect(JSON.stringify(logs)).not.toContain(replacement.token)
})

test('blocked shadow FIFO does not break actual legacy hook recording or sync', async () => {
	const f = fixture()
	const h = harness()
	const store = new WorkHoursStore(join(f.root, 'legacy.sqlite'))
	const uploaded: unknown[] = []
	const client = new CukupServiceClient('https://cukup.invalid', async (url, init) => {
		if (url.endsWith('/v1/capabilities')) return Response.json({ schema_version: 1,
			accepted_event_schema_versions: [1, 2], preferred_new_event_schema_version: 2 })
		if (url.endsWith('/v1/executor-profile')) return Response.json({ executor_label: HOST })
		if (url.endsWith('/v1/time')) return Response.json({ server_time: new Date(NOW).toISOString() })
		if (url.endsWith('/v1/events:batch')) {
			const events = JSON.parse(String(init.body)).events
			uploaded.push(...events)
			return Response.json({ results: events.map((e: any) => ({ event_id: e.event_id, status: 'accepted' })) })
		}
		return Response.json({ schema_version: 1, as_of: new Date(NOW).toISOString(),
			daily: { status: 'UNDER', worked_minutes: 0, target_minutes: 480, difference_minutes: 480 },
			weekly: { status: 'UNDER', worked_minutes: 0, target_minutes: 2400, difference_minutes: 2400 } })
	}, () => NOW)
	const sync = new SyncEngine({ store, client, tokenProvider: f.options.tokenProvider,
		executorProfile: f.options.executorProfile, now: () => NOW })
	const legacy = createLegacyAmpAdapter({ amp: h.amp, store, sync, now: f.options.now })
	cleanups.push(async () => { await legacy.dispose(); await sync.dispose(); store.close() })
	f.options.fetch = async (url) => url.endsWith('/v1/executor-profile')
		? Response.json({ executor_label: HOST })
		: Response.json({ status: 'rejected', reason: 'invalid_record' })
	const value = start(h, f)
	await Promise.all(h.emit('agent.start')); h.state('running')
	f.advance(1_000)
	await Promise.all(h.emit('agent.end'))
	await settle()
	expect(value.status()).toMatchObject({ blocked: 1, queued: 2, blockedReasons: { invalidRecord: 1 } })
	await sync.runNow()
	expect(uploaded).toHaveLength(2)
	expect(store.outboxCounts()).toEqual({ pending: 0, conflict: 0, rejected: 0 })
	expect(store.events().map((e) => e.kind)).toEqual(['start', 'end'])
	expect(sync.trackingGap()).toBeUndefined()
	expect(await value.drainStep()).toMatchObject({ status: 'blocked', attempted: 0 })
	const notifications: string[] = []
	await h.commands.get('experimental-physical-shadow')!({ ui: {
		select: async () => 'Drain one record',
		notify: async (message: string) => { notifications.push(message) },
	} })
	expect(notifications.map((message) => JSON.parse(message))).toMatchObject([
		{ drain: 'blocked', spool: { blocked: 1, queued: 2 } },
	])
})

test('disposal flushes local endpoints without synthesizing a lost end; startup drains only one old fact', async () => {
	const f = fixture()
	const h = harness()
	const value = start(h, f)
	h.emit('agent.start'); h.state('running')
	await value.dispose()
	expect(rows(f.spool)).toHaveLength(2)
	expect(rows(f.spool).map((row) => row.envelope).join('')).not.toContain('irreversible_loss')
	f.options.fetch = async (url) => Response.json(url.endsWith('/v1/executor-profile')
		? { executor_label: HOST } : { status: 'accepted' })
	const restart = harness()
	const next = start(restart, f)
	await settle()
	expect(rows(f.spool)).toHaveLength(1)
	restart.emit('agent.end'); restart.state('idle')
	await next.dispose()
	expect(rows(f.spool)).toHaveLength(1)
	expect(rows(f.spool)[0]!.envelope).not.toContain('irreversible_loss')
	expect(restart.reads()).toBe(0)
})

test('rejected drain disposal releases ownership after malformed durable JSON, without leaking its content', async () => {
	const f = fixture()
	const h = harness()
	const first = start(h, f)
	h.emit('agent.start'); h.state('running')
	await first.dispose()
	const db = new Database(f.spool)
	db.query('UPDATE physical_shadow_outbox SET envelope_json = ?').run('private-malformed-json-sentinel')
	db.close()
	f.options.fetch = async () => Response.json({ executor_label: HOST })
	const live = harness()
	const broken = start(live, f)
	await settle()
	expect(await broken.drainStep()).toEqual({ status: 'unavailable' })
	await broken.dispose()
	expect(live.subscriptions()).toBe(0)
	expect(live.logs.length).toBeGreaterThan(0)
	expect(live.logs.every((line) => line === EXPERIMENTAL_AMP_SHADOW_WARNING)).toBeTrue()
	const replacement = start(harness(), f)
	await replacement.dispose()
})

test('stalled explicit drain bounds command and disposal, unsubscribes first, retains ownership until settled', async () => {
	const f = fixture()
	const h = harness()
	const first = start(h, f)
	h.emit('agent.start'); h.state('running'); h.emit('agent.end')
	await first.dispose()
	let release!: (value: Response) => void
	let entered!: () => void
	const ready = new Promise<void>((resolve) => { entered = resolve })
	let stalled = false
	f.options.fetch = async () => {
		if (!stalled) return Response.json({}, { status: 503 })
		entered()
		return new Promise<Response>((resolve) => { release = resolve })
	}
	const live = harness()
	const value = start(live, f)
	await settle()
	stalled = true
	f.advance(1_000)
	const drain = value.drainStep()
	await ready
	const started = performance.now()
	const disposal = value.dispose()
	expect(live.subscriptions()).toBe(0)
	expect(live.commands.size).toBe(0)
	expect(value.dispose()).toBe(disposal)
	expect(await drain).toEqual({ status: 'unavailable' })
	await disposal
	expect(performance.now() - started).toBeLessThan(3_500)
	expect(startExperimentalPhysicalAmpShadow(harness().amp, f.options)).toBeUndefined()
	release(Response.json({}, { status: 503 }))
	await settle()
	const replacement = start(harness(), f)
	await replacement.dispose()
	expect(live.logs.length).toBeGreaterThan(0)
	expect(live.logs.every((line) => line === EXPERIMENTAL_AMP_SHADOW_WARNING)).toBeTrue()
}, 8_000)
