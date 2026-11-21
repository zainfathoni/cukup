import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { PluginToolDefinition } from '@ampcode/plugin'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLocalHarnessEvidenceRuntime } from '../experimental/local-harness-evidence-runtime.ts'
import workHoursPlugin, { executorProfileFor } from './index.ts'
import { jakartaDateString } from './tracker.ts'

const temporaryDirectories: string[] = []
let previousTokenFile: string | undefined
let previousServiceURL: string | undefined
let previousProjectID: string | undefined
let previousExperimentalShadow: string | undefined
let previousExperimentalRuntimeState: string | undefined
let previousExperimentalCollectorState: string | undefined

function idleThread() {
	return {
		state: {
			get: async () => 'idle',
			subscribe: () => ({ unsubscribe() {} }),
		},
	}
}

beforeEach(() => {
	previousTokenFile = process.env.CUKUP_TOKEN_FILE
	previousServiceURL = process.env.CUKUP_SERVICE_URL
	previousProjectID = process.env.AMP_PROJECT_ID
	previousExperimentalShadow = process.env.CUKUP_EXPERIMENTAL_AMP_SHADOW
	previousExperimentalRuntimeState = process.env.CUKUP_EXPERIMENTAL_RUNTIME_STATE_DIR
	previousExperimentalCollectorState = process.env.CUKUP_EXPERIMENTAL_AMP_SHADOW_STATE_DIR
	process.env.CUKUP_TOKEN_FILE = '/nonexistent/cukup-plugin-test-token'
	process.env.CUKUP_SERVICE_URL = 'https://api.cukup.dev'
	process.env.AMP_PROJECT_ID = 'project-test'
	delete process.env.CUKUP_EXPERIMENTAL_AMP_SHADOW
	delete process.env.CUKUP_EXPERIMENTAL_RUNTIME_STATE_DIR
	delete process.env.CUKUP_EXPERIMENTAL_AMP_SHADOW_STATE_DIR
})

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
	if (previousTokenFile === undefined) delete process.env.CUKUP_TOKEN_FILE
	else process.env.CUKUP_TOKEN_FILE = previousTokenFile
	if (previousServiceURL === undefined) delete process.env.CUKUP_SERVICE_URL
	else process.env.CUKUP_SERVICE_URL = previousServiceURL
	if (previousProjectID === undefined) delete process.env.AMP_PROJECT_ID
	else process.env.AMP_PROJECT_ID = previousProjectID
	if (previousExperimentalShadow === undefined) delete process.env.CUKUP_EXPERIMENTAL_AMP_SHADOW
	else process.env.CUKUP_EXPERIMENTAL_AMP_SHADOW = previousExperimentalShadow
	if (previousExperimentalRuntimeState === undefined) delete process.env.CUKUP_EXPERIMENTAL_RUNTIME_STATE_DIR
	else process.env.CUKUP_EXPERIMENTAL_RUNTIME_STATE_DIR = previousExperimentalRuntimeState
	if (previousExperimentalCollectorState === undefined) delete process.env.CUKUP_EXPERIMENTAL_AMP_SHADOW_STATE_DIR
	else process.env.CUKUP_EXPERIMENTAL_AMP_SHADOW_STATE_DIR = previousExperimentalCollectorState
})

describe('work-hours plugin', () => {
	test.each([
		['local', undefined], ['local', ' \t '],
		['remote', undefined], ['remote', ' \t '],
	] as const)('does not send credentials when the %s destination is %j', async (kind, destination) => {
		const stateHome = mkdtempSync(join(tmpdir(), 'amp-work-hours-plugin-disabled-'))
		temporaryDirectories.push(stateHome)
		const previousStateHome = process.env.XDG_STATE_HOME
		const previousFetch = globalThis.fetch
		process.env.XDG_STATE_HOME = stateHome
		process.env.CUKUP_TOKEN_FILE = join(stateHome, 'token')
		const token = `cukup_v1_${'a'.repeat(43)}`
		writeFileSync(process.env.CUKUP_TOKEN_FILE, token, { mode: 0o600 })
		if (destination === undefined) delete process.env.CUKUP_SERVICE_URL
		else process.env.CUKUP_SERVICE_URL = destination
		const requests: string[] = []
		let mintCalls = 0
		let tool!: PluginToolDefinition
		let showStatus!: (ctx: { ui: { select: () => Promise<'Close'> } }) => Promise<void>
		let dispose = async () => {}
		globalThis.fetch = (async (input: string | URL | Request) => {
			requests.push(String(input))
			return new Response(null, { status: 401 })
		}) as typeof fetch
		try {
			workHoursPlugin({
				system: { executor: { kind } },
				registerTool(value: PluginToolDefinition) { tool = value },
				registerCommand(id: string, _options: unknown, handler: typeof showStatus) {
					if (id === 'work-hours-status') showStatus = handler
				},
				on() { return { unsubscribe() {} } },
				onDispose(callback: typeof dispose) { dispose = callback },
				$: async () => {
					mintCalls++
					return { exitCode: 0, stdout: token, stderr: '' }
				},
			} as never)
			await tool.execute({}, {} as never)
			await showStatus({ ui: { select: async () => 'Close' } })
			expect(requests).toEqual([])
			expect(mintCalls).toBe(0)
		} finally {
			await dispose()
			globalThis.fetch = previousFetch
			if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = previousStateHome
		}
	})

	test('registers hooks and commands and completes the status loop', async () => {
		const stateHome = mkdtempSync(join(tmpdir(), 'amp-work-hours-plugin-test-'))
		temporaryDirectories.push(stateHome)
		const previousStateHome = process.env.XDG_STATE_HOME
		process.env.XDG_STATE_HOME = stateHome

		const handlers = new Map<string, (event: any, context?: any) => unknown>()
		const commands = new Map<string, (context: any) => unknown>()
		const commandCategories = new Map<string, string>()
		const commandTitles = new Map<string, string>()
		const disposers: Array<() => unknown> = []
		const notifications: string[] = []
		const statusDialogs: Array<{ title: string; message?: string; options: string[] }> = []
		const commandAvailability = new Map<string, unknown>()
		const tools: PluginToolDefinition[] = []
		const amp = {
			registerTool(tool: PluginToolDefinition) { tools.push(tool); return { unsubscribe() {} } },
			on(name: string, handler: (event: any, context?: any) => unknown) {
				handlers.set(name, handler)
				return { unsubscribe() {} }
			},
			registerCommand(
				id: string,
				options: { category: string; title: string; availability?: unknown },
				handler: (context: any) => unknown,
			) {
				commands.set(id, handler)
				commandCategories.set(id, options.category)
				commandTitles.set(id, options.title)
				commandAvailability.set(id, options.availability)
				return { unsubscribe() {}, setAvailability() {} }
			},
			onDispose(callback: () => unknown) {
				disposers.push(callback)
				return { unsubscribe() {} }
			},
			threads: {
				get() {
					return idleThread()
				},
			},
			configuration: {
				get: async () => ({}),
				update: async () => {},
				delete: async () => {},
			},
			system: { executor: { kind: 'local' }, user: { workspace: null }, workspaceRoot: {} },
			helpers: { filePathFromURI: () => '/workspaces/cukup-plugin' },
			$: async () => ({
				exitCode: 0,
				stdout: JSON.stringify({ id: 'project-test', name: 'Cukup Plugin' }),
				stderr: '',
			}),
		}
		const context = {
			ui: {
				notify: async (message: string) => notifications.push(message),
				confirm: async () => true,
				select: async (options: { title: string; message?: string; options: string[] }) => {
					statusDialogs.push(options)
					return options.title === 'Set local fallback weekday target' ? '0:01' : 'Close'
				},
			},
		}

		try {
			workHoursPlugin(amp as never)
			expect(tools.map((tool) => tool.name)).toEqual(['work_hours_status'])
			expect(tools[0]!.inputSchema).toEqual({ type: 'object', properties: { track: { type: 'string', enum: ['work', 'play', 'all'], default: 'work' } }, additionalProperties: false })
			const toolResult = await tools[0]!.execute({}, {} as never)
			expect(toolResult).toBeString()
			expect(toolResult as string).toStartWith('UNKNOWN · work status unavailable')
			const playResult = await tools[0]!.execute({ track: 'play' }, {} as never)
			expect(playResult as string).toStartWith('UNKNOWN · play status unavailable')
			expect(statusDialogs).toHaveLength(0)
			expect(notifications).toHaveLength(0)
			expect([...handlers.keys()]).toEqual([
				'session.start',
				'agent.start',
				'agent.end',
				'tool.result',
			])
			expect([...commands.keys()]).toEqual([
				'work-hours-status',
				'tracking-gap-acknowledge',
				'project-slug-set',
				'day-off-set',
				'work-hours-set-target',
			])
			expect([...commandCategories.values()]).toEqual(['cukup', 'cukup', 'cukup', 'cukup', 'cukup'])
			expect(commandTitles.get('tracking-gap-acknowledge')).toBe('Acknowledge tracking gap')
			expect(commandTitles.get('day-off-set')).toBe('Set day off or half day')
			expect(commandTitles.get('project-slug-set')).toBe('Project attribution')
			expect(commandAvailability.get('project-slug-set')).toBeUndefined()

			const event = {
				thread: { id: 'T-smoke' },
				id: 'message-1',
				message: 'smoke',
			}
			await handlers.get('agent.start')?.(event, context)
			await handlers.get('agent.end')?.({ ...event, status: 'done', messages: [] }, context)
			await commands.get('work-hours-status')?.(context)
			expect(statusDialogs.at(-1)).toMatchObject({
				title: 'Cukup status',
				options: ['Close'],
			})
			expect(statusDialogs.at(-1)?.message).toStartWith('UNKNOWN · no authoritative summary')
			expect(statusDialogs.at(-1)?.message).toContain('Local fallback (non-authoritative):')

			await commands.get('work-hours-set-target')?.(context)
			expect(notifications.at(-1)).toBe('Weekday target set to 1m.')
		} finally {
			await Promise.all(disposers.map((dispose) => dispose()))
			if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = previousStateHome
		}
	})

	test('keeps completed and unmatched turns stable across duplicate hooks and plugin restart', async () => {
		const stateHome = mkdtempSync(join(tmpdir(), 'amp-work-hours-plugin-test-'))
		temporaryDirectories.push(stateHome)
		const previousStateHome = process.env.XDG_STATE_HOME
		process.env.XDG_STATE_HOME = stateHome
		const context = { ui: { notify: async () => {} } }

		const startPlugin = () => {
			const handlers = new Map<string, (event: any, context?: any) => unknown>()
			let dispose = async () => {}
			const amp = {
				registerTool() { return { unsubscribe() {} } },
				on(name: string, handler: (event: any, context?: any) => unknown) {
					handlers.set(name, handler)
					return { unsubscribe() {} }
				},
				registerCommand() {
					return { unsubscribe() {}, setAvailability() {} }
				},
				onDispose(callback: () => unknown) {
					dispose = async () => { await callback() }
					return { unsubscribe() {} }
				},
				threads: { get: () => idleThread() },
				configuration: {
					get: async () => ({}),
					update: async () => {},
					delete: async () => {},
				},
				system: { executor: { kind: 'local' }, user: { workspace: null } },
				$: async () => ({
					exitCode: 0,
					stdout: JSON.stringify({ id: 'project-test', name: 'Cukup Plugin' }),
					stderr: '',
				}),
			}
			workHoursPlugin(amp as never)
			return { handlers, dispose }
		}

		const completed = { thread: { id: 'T-duplicates' }, id: 'completed-turn' }
		const unmatchedEnd = { thread: { id: 'T-duplicates' }, id: 'end-without-start' }
		const unmatchedStart = { thread: { id: 'T-duplicates' }, id: 'start-without-end' }

		try {
			const first = startPlugin()
			await first.handlers.get('agent.start')?.(completed, context)
			await first.handlers.get('agent.start')?.(completed, context)
			await first.handlers.get('agent.end')?.({ ...completed, status: 'done' }, context)
			await first.handlers.get('agent.end')?.({ ...completed, status: 'done' }, context)
			await first.handlers.get('agent.end')?.({ ...unmatchedEnd, status: 'error' }, context)
			await first.handlers.get('agent.start')?.(unmatchedStart, context)
			await first.handlers.get('agent.start')?.(unmatchedStart, context)
			await first.dispose()

			const restarted = startPlugin()
			await restarted.handlers.get('agent.start')?.(completed, context)
			await restarted.handlers.get('agent.end')?.({ ...completed, status: 'done' }, context)
			await restarted.handlers.get('agent.end')?.({ ...unmatchedEnd, status: 'cancelled' }, context)
			await restarted.dispose()

			const database = new Database(join(stateHome, 'amp-work-hours', 'state.sqlite'))
			const events = database
				.query<
					{ messageId: string; kind: string; status: string | null },
					[]
				>(
					`SELECT message_id AS messageId, kind, status FROM events
					 WHERE thread_id = 'T-duplicates' ORDER BY rowid`,
				)
				.all()
			const outbox = database
				.query<{ sequence: number; sessionId: string; kind: string }, []>(
					`SELECT source_sequence AS sequence, session_id AS sessionId, kind
					 FROM outbox ORDER BY source_sequence`,
				)
				.all()
			database.close()

			expect(events).toEqual([
				{ messageId: 'completed-turn', kind: 'start', status: null },
				{ messageId: 'completed-turn', kind: 'end', status: 'done' },
				{ messageId: 'start-without-end', kind: 'start', status: null },
			])
			expect(outbox.map(({ sequence, kind }) => ({ sequence, kind }))).toEqual([
				{ sequence: 1, kind: 'agent.start' },
				{ sequence: 2, kind: 'agent.end' },
				{ sequence: 3, kind: 'agent.start' },
			])
			expect(outbox[1]?.sessionId).toBe(outbox[0]?.sessionId)
			expect(outbox[2]?.sessionId).not.toBe(outbox[0]?.sessionId)
		} finally {
			if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = previousStateHome
		}
	})

	test('recovers running work at startup and after a retry without agent.start', async () => {
		const stateHome = mkdtempSync(join(tmpdir(), 'amp-work-hours-plugin-test-'))
		temporaryDirectories.push(stateHome)
		const previousStateHome = process.env.XDG_STATE_HOME
		process.env.XDG_STATE_HOME = stateHome
		const handlers = new Map<string, (event: any, context?: any) => unknown>()
		const disposers: Array<() => unknown> = []
		const stateObservers = new Set<(state: 'running' | 'idle') => void>()
		let state: 'running' | 'idle' = 'running'
		let resolveProject!: (result: { exitCode: number; stdout: string; stderr: string }) => void
		const project = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
			resolveProject = resolve
		})
		const amp = {
			registerTool() { return { unsubscribe() {} } },
			on(name: string, handler: (event: any, context?: any) => unknown) {
				handlers.set(name, handler)
				return { unsubscribe() {} }
			},
			registerCommand() {
				return { unsubscribe() {}, setAvailability() {} }
			},
			onDispose(callback: () => unknown) {
				disposers.push(callback)
				return { unsubscribe() {} }
			},
			threads: {
				get: () => ({
					state: {
						get: async () => state,
						subscribe(observer: (value: 'running' | 'idle') => void) {
							stateObservers.add(observer)
							return { unsubscribe: () => stateObservers.delete(observer) }
						},
					},
				}),
			},
			configuration: {
				get: async () => ({}),
				update: async () => {},
				delete: async () => {},
			},
			system: { executor: { kind: 'local' }, user: { workspace: null } },
			$: () => project,
		}

		try {
			workHoursPlugin(amp as never)
			handlers.get('session.start')?.({ thread: { id: 'T-recovered' } })
			await Bun.sleep(0)
			state = 'idle'
			for (const observer of stateObservers) observer(state)
			state = 'running'
			for (const observer of stateObservers) observer(state)
			const context = { ui: { notify: async () => {} } }
			const event = {
				thread: { id: 'T-recovered' },
				id: 'message-with-retry',
				message: 'retry this turn',
			}
			const normalStart = handlers.get('agent.start')?.(event, context)
			await Bun.sleep(10)
			resolveProject({
				exitCode: 0,
				stdout: JSON.stringify({ id: 'project-test', name: 'Cukup Plugin' }),
				stderr: '',
			})
			await normalStart
			for (const observer of stateObservers) observer('idle')
			await Bun.sleep(20)
			await handlers.get('agent.end')?.({ ...event, status: 'error', messages: [] }, context)
			state = 'running'
			for (const observer of stateObservers) observer(state)
			await Bun.sleep(20)
			await handlers.get('agent.end')?.(
				{
					thread: { id: 'T-recovered' },
					id: 'unknown-original-message',
					message: 'turn began before plugin load',
					status: 'cancelled',
					messages: [],
				},
				context,
			)

			const database = new Database(join(stateHome, 'amp-work-hours', 'state.sqlite'))
			const events = database
				.query<{ messageId: string; kind: string; atMs: number; status: string | null }, []>(
					`SELECT message_id AS messageId, kind, at_ms AS atMs, status FROM events
					 WHERE thread_id = 'T-recovered' ORDER BY rowid`,
				)
				.all()
			database.close()
			expect(events).toHaveLength(8)
			expect(events[0]?.messageId).toStartWith('cukup-recovered-')
			expect(events[1]?.messageId).toBe(events[0]?.messageId)
			expect(events[2]?.messageId).toStartWith('cukup-recovered-')
			expect(events[3]?.messageId).toBe(events[2]?.messageId)
			expect(events[4]?.messageId).toBe('message-with-retry')
			expect(events[5]?.messageId).toBe('message-with-retry')
			expect(events[6]?.messageId).toStartWith('cukup-recovered-')
			expect(events[7]?.messageId).toBe(events[6]?.messageId)
			expect(events[3]?.atMs).toBe(events[4]?.atMs)
			expect(events.map(({ kind, status }) => ({ kind, status }))).toEqual([
				{ kind: 'start', status: null },
				{ kind: 'end', status: 'done' },
				{ kind: 'start', status: null },
				{ kind: 'end', status: 'done' },
				{ kind: 'start', status: null },
				{ kind: 'end', status: 'error' },
				{ kind: 'start', status: null },
				{ kind: 'end', status: 'cancelled' },
			])
		} finally {
			await Promise.all(disposers.map((dispose) => dispose()))
			if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = previousStateHome
		}
	})

	test('ignores a stale running bootstrap after a newer idle state emission', async () => {
		const stateHome = mkdtempSync(join(tmpdir(), 'amp-work-hours-plugin-test-'))
		temporaryDirectories.push(stateHome)
		const previousStateHome = process.env.XDG_STATE_HOME
		process.env.XDG_STATE_HOME = stateHome
		const handlers = new Map<string, (event: any) => unknown>()
		const disposers: Array<() => unknown> = []
		let resolveBootstrap!: (state: 'running') => void
		const bootstrap = new Promise<'running'>((resolve) => {
			resolveBootstrap = resolve
		})
		let stateObserver: ((state: 'idle') => void) | undefined
		const amp = {
			registerTool() { return { unsubscribe() {} } },
			on(name: string, handler: (event: any) => unknown) {
				handlers.set(name, handler)
				return { unsubscribe() {} }
			},
			registerCommand() {
				return { unsubscribe() {}, setAvailability() {} }
			},
			onDispose(callback: () => unknown) {
				disposers.push(callback)
				return { unsubscribe() {} }
			},
			threads: {
				get: () => ({
					state: {
						get: () => bootstrap,
						subscribe(observer: (state: 'idle') => void) {
							stateObserver = observer
							return { unsubscribe() { stateObserver = undefined } }
						},
					},
				}),
			},
			configuration: {
				get: async () => ({}),
				update: async () => {},
				delete: async () => {},
			},
			system: { executor: { kind: 'local' }, user: { workspace: null } },
			$: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
		}

		try {
			workHoursPlugin(amp as never)
			handlers.get('session.start')?.({ thread: { id: 'T-stale-bootstrap' } })
			stateObserver?.('idle')
			resolveBootstrap('running')
			await Bun.sleep(20)

			const database = new Database(join(stateHome, 'amp-work-hours', 'state.sqlite'))
			const count = database
				.query<{ count: number }, []>(
					`SELECT count(*) AS count FROM events WHERE thread_id = 'T-stale-bootstrap'`,
				)
				.get()?.count
			database.close()
			expect(count).toBe(0)
		} finally {
			await Promise.all(disposers.map((dispose) => dispose()))
			if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = previousStateHome
		}
	})

	test('keeps normal tracking independent from thread-state observation failures', async () => {
		const stateHome = mkdtempSync(join(tmpdir(), 'amp-work-hours-plugin-test-'))
		temporaryDirectories.push(stateHome)
		const previousStateHome = process.env.XDG_STATE_HOME
		process.env.XDG_STATE_HOME = stateHome
		const handlers = new Map<string, (event: any, context?: any) => unknown>()
		const disposers: Array<() => unknown> = []
		const amp = {
			registerTool() { return { unsubscribe() {} } },
			on(name: string, handler: (event: any, context?: any) => unknown) {
				handlers.set(name, handler)
				return { unsubscribe() {} }
			},
			registerCommand() {
				return { unsubscribe() {}, setAvailability() {} }
			},
			onDispose(callback: () => unknown) {
				disposers.push(callback)
				return { unsubscribe() {} }
			},
			threads: {
				get() {
					throw new Error('thread disappeared')
				},
			},
			configuration: {
				get: async () => ({}),
				update: async () => {},
				delete: async () => {},
			},
			system: { executor: { kind: 'local' }, user: { workspace: null } },
			$: async () => ({
				exitCode: 0,
				stdout: JSON.stringify({ id: 'project-test', name: 'Cukup Plugin' }),
				stderr: '',
			}),
		}
		const context = { ui: { notify: async () => {} } }
		const event = {
			thread: { id: 'T-observation-failure' },
			id: 'message-1',
			message: 'still record this turn',
		}

		try {
			workHoursPlugin(amp as never)
			await handlers.get('agent.start')?.(event, context)
			await handlers.get('agent.end')?.({ ...event, status: 'done', messages: [] }, context)

			const database = new Database(join(stateHome, 'amp-work-hours', 'state.sqlite'))
			const events = database
				.query<{ kind: string; status: string | null }, []>(
					`SELECT kind, status FROM events
					 WHERE thread_id = 'T-observation-failure' ORDER BY rowid`,
				)
				.all()
			database.close()
			expect(events).toEqual([
				{ kind: 'start', status: null },
				{ kind: 'end', status: 'done' },
			])
		} finally {
			await Promise.all(disposers.map((dispose) => dispose()))
			if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = previousStateHome
		}
	})

	test('starts fresh recovery after a recovered end write fails', async () => {
		const stateHome = mkdtempSync(join(tmpdir(), 'amp-work-hours-plugin-test-'))
		temporaryDirectories.push(stateHome)
		const previousStateHome = process.env.XDG_STATE_HOME
		process.env.XDG_STATE_HOME = stateHome
		const handlers = new Map<string, (event: any) => unknown>()
		const disposers: Array<() => unknown> = []
		const stateObservers = new Set<(state: 'running' | 'idle') => void>()
		let state: 'running' | 'idle' = 'running'
		const amp = {
			registerTool() { return { unsubscribe() {} } },
			on(name: string, handler: (event: any) => unknown) {
				handlers.set(name, handler)
				return { unsubscribe() {} }
			},
			registerCommand() {
				return { unsubscribe() {}, setAvailability() {} }
			},
			onDispose(callback: () => unknown) {
				disposers.push(callback)
				return { unsubscribe() {} }
			},
			threads: {
				get: () => ({
					state: {
						get: async () => state,
						subscribe(observer: (value: 'running' | 'idle') => void) {
							stateObservers.add(observer)
							return { unsubscribe: () => stateObservers.delete(observer) }
						},
					},
				}),
			},
			configuration: {
				get: async () => ({}),
				update: async () => {},
				delete: async () => {},
			},
			system: { executor: { kind: 'local' }, user: { workspace: null } },
			$: async () => ({
				exitCode: 0,
				stdout: JSON.stringify({ id: 'project-test', name: 'Cukup Plugin' }),
				stderr: '',
			}),
		}

		try {
			workHoursPlugin(amp as never)
			handlers.get('session.start')?.({ thread: { id: 'T-end-failure' } })
			await Bun.sleep(20)

			const database = new Database(join(stateHome, 'amp-work-hours', 'state.sqlite'))
			database.exec(`
				CREATE TRIGGER reject_recovered_end BEFORE INSERT ON events
				WHEN NEW.kind = 'end'
				BEGIN SELECT RAISE(ABORT, 'injected recovered-end failure'); END;
			`)
			state = 'idle'
			for (const observer of stateObservers) observer(state)
			await Bun.sleep(20)
			database.exec('DROP TRIGGER reject_recovered_end')

			state = 'running'
			for (const observer of stateObservers) observer(state)
			await Bun.sleep(20)
			const starts = database
				.query<{ messageId: string }, []>(
					`SELECT message_id AS messageId FROM events
					 WHERE thread_id = 'T-end-failure' AND kind = 'start' ORDER BY rowid`,
				)
				.all()
			database.close()
			expect(starts).toHaveLength(2)
			expect(starts[0]?.messageId).toStartWith('cukup-recovered-')
			expect(starts[1]?.messageId).toStartWith('cukup-recovered-')
			expect(starts[1]?.messageId).not.toBe(starts[0]?.messageId)
		} finally {
			await Promise.all(disposers.map((dispose) => dispose()))
			if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = previousStateHome
		}
	})

	test('validates, previews, confirms, marks, and explicitly clears an authoritative Jakarta day off', async () => {
		const stateHome = mkdtempSync(join(tmpdir(), 'amp-work-hours-plugin-test-'))
		temporaryDirectories.push(stateHome)
		const token = `cukup_v1_${'a'.repeat(43)}`
		const tokenFile = join(stateHome, 'token')
		writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
		chmodSync(tokenFile, 0o600)
		const previousStateHome = process.env.XDG_STATE_HOME
		const previousTokenFile = process.env.CUKUP_TOKEN_FILE
		const previousServiceURL = process.env.CUKUP_SERVICE_URL
		const previousFetch = globalThis.fetch
		process.env.XDG_STATE_HOME = stateHome
		process.env.CUKUP_TOKEN_FILE = tokenFile
		process.env.CUKUP_SERVICE_URL = 'https://api.cukup.dev'
		const today = jakartaDateString(Date.now())

		const mutations: Array<{ url: string; init: RequestInit }> = []
		const order: string[] = []
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
			if (url.endsWith('/v1/capabilities')) {
				return Response.json({
					schema_version: 1,
					accepted_event_schema_versions: [1, 2],
					preferred_new_event_schema_version: 1,
				})
			}
			if (url.endsWith('/v1/time')) {
				return Response.json({ server_time: new Date().toISOString() })
			}
			if (url.endsWith('/v1/summary')) {
				return Response.json({
					schema_version: 1,
					as_of: new Date().toISOString(),
					daily: { status: 'UNDER', worked_minutes: 0, target_minutes: 480, difference_minutes: 480 },
					weekly: { status: 'UNDER', worked_minutes: 0, target_minutes: 2_400, difference_minutes: 2_400 },
				})
			}
			if (url.includes('/v1/target-overrides/')) {
				const request = { url, init: init ?? {} }
				mutations.push(request)
				order.push(String(init?.method))
				if (init?.method !== 'PUT') return new Response(null, { status: 204 })
				const target_minutes = JSON.parse(String(init.body)).target_minutes
				return Response.json({ date: url.slice(url.lastIndexOf('/') + 1), target_minutes })
			}
			return new Response(null, { status: 404 })
		}) as typeof fetch

		const commands = new Map<string, (context: any) => unknown>()
		const disposers: Array<() => unknown> = []
		const amp = {
			registerTool() { return { unsubscribe() {} } },
			on() { return { unsubscribe() {} } },
			registerCommand(id: string, _options: unknown, handler: (context: any) => unknown) {
				commands.set(id, handler)
				return { unsubscribe() {}, setAvailability() {} }
			},
			onDispose(callback: () => unknown) { disposers.push(callback); return { unsubscribe() {} } },
			threads: { get: () => idleThread() },
			configuration: {
				get: async () => ({}),
				update: async () => {},
				delete: async () => {},
			},
			system: { executor: { kind: 'local' }, user: { workspace: {} } },
			$: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
		}
		const selections = [
			'Today',
			'Full day off (0m)',
			'2026-09-01',
			'Half day (4h)',
			'2026-09-01',
			'Clear / undo',
			'2026-02-29',
		]
		const selectionDialogs: Array<{ options: string[]; allowOther?: boolean }> = []
		const confirmations: Array<{ title: string; message?: string }> = []
		const notifications: string[] = []
		const context = {
			ui: {
				select: async (options: { options: string[]; allowOther?: boolean }) => {
					selectionDialogs.push(options)
					return selections.shift()
				},
				confirm: async (options: { title: string; message?: string }) => {
					confirmations.push(options)
					order.push('confirm')
					return true
				},
				notify: async (message: string) => { notifications.push(message) },
			},
		}

		try {
			workHoursPlugin(amp as never)
			await commands.get('day-off-set')?.(context)
			await commands.get('day-off-set')?.(context)
			await commands.get('day-off-set')?.(context)
			await commands.get('day-off-set')?.(context)
			expect(selectionDialogs.map(({ options }) => options)).toEqual([
				['Today'],
				['Full day off (0m)', 'Half day (4h)', 'Clear / undo'],
				['Today'],
				['Full day off (0m)', 'Half day (4h)', 'Clear / undo'],
				['Today'],
				['Full day off (0m)', 'Half day (4h)', 'Clear / undo'],
				['Today'],
			])
			expect(
				selectionDialogs
					.filter(({ options }) => options[0] === 'Today')
					.every(({ allowOther }) => allowOther),
			).toBeTrue()
			expect(confirmations.map((confirmation) => confirmation.title)).toEqual([
				`Set full day off for ${today}?`,
				'Set half day for 2026-09-01?',
				'Clear day off for 2026-09-01?',
			])
			expect(confirmations.every((confirmation) => confirmation.message?.includes('evidence remains unchanged'))).toBeTrue()
			expect(confirmations[0]?.message).toContain('**0m**')
			expect(confirmations[1]?.message).toContain('**240m (4h)**')
			expect(order).toEqual(['confirm', 'PUT', 'confirm', 'PUT', 'confirm', 'DELETE'])
			expect(mutations.map(({ url, init }) => [url, init.method])).toEqual([
				[`https://api.cukup.dev/v1/target-overrides/${today}`, 'PUT'],
				['https://api.cukup.dev/v1/target-overrides/2026-09-01', 'PUT'],
				['https://api.cukup.dev/v1/target-overrides/2026-09-01', 'DELETE'],
			])
			expect(JSON.parse(String(mutations[0]?.init.body))).toEqual({ target_minutes: 0 })
			expect(JSON.parse(String(mutations[1]?.init.body))).toEqual({ target_minutes: 240 })
			expect(notifications).toEqual([
				`Authoritative target for ${today} is now 0m.`,
				'Authoritative target for 2026-09-01 is now 240m (4h).',
				'Authoritative day-off override for 2026-09-01 is cleared.',
				'Enter a real date in exact YYYY-MM-DD format.',
			])
			expect(notifications.join('\n')).not.toContain(token)
		} finally {
			await Promise.all(disposers.map((dispose) => dispose()))
			globalThis.fetch = previousFetch
			if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = previousStateHome
			if (previousTokenFile === undefined) delete process.env.CUKUP_TOKEN_FILE
			else process.env.CUKUP_TOKEN_FILE = previousTokenFile
			if (previousServiceURL === undefined) delete process.env.CUKUP_SERVICE_URL
			else process.env.CUKUP_SERVICE_URL = previousServiceURL
		}
	})

	test.each(['work-hours-status', 'tracking-gap-acknowledge'])('acknowledges a tracking gap through %s without changing evidence', async (command) => {
		const stateHome = mkdtempSync(join(tmpdir(), 'amp-work-hours-plugin-test-'))
		temporaryDirectories.push(stateHome)
		const previousStateHome = process.env.XDG_STATE_HOME
		process.env.XDG_STATE_HOME = stateHome
		const handlers = new Map<string, (event: any, context: any) => unknown>()
		const commands = new Map<string, (context: any) => unknown>()
		const disposers: Array<() => unknown> = []
		const notifications: string[] = []
		const dialogs: Array<{ title: string; message?: string; options: string[] }> = []
		const confirmations: Array<{ title: string; message?: string; confirmButtonText?: string }> = []
		let selection: string | undefined = 'Close'
		let confirmed = false
		const amp = {
			registerTool() { return { unsubscribe() {} } },
			on(name: string, handler: (event: any, context: any) => unknown) {
				handlers.set(name, handler)
				return { unsubscribe() {} }
			},
			registerCommand(id: string, _options: unknown, handler: (context: any) => unknown) {
				commands.set(id, handler)
				return { unsubscribe() {}, setAvailability() {} }
			},
			onDispose(callback: () => unknown) {
				disposers.push(callback)
				return { unsubscribe() {} }
			},
			threads: { get: () => idleThread() },
			configuration: {
				get: async () => ({}),
				update: async () => {},
				delete: async () => {},
			},
			system: { executor: { kind: 'local' }, user: { workspace: {} } },
			$: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
		}
		const context = {
			ui: {
				notify: async (message: string) => { notifications.push(message) },
				select: async (options: { title: string; message?: string; options: string[] }) => {
					dialogs.push(options)
					return selection
				},
				confirm: async (options: { title: string; message?: string; confirmButtonText?: string }) => {
					confirmations.push(options)
					return confirmed
				},
			},
		}

		try {
			workHoursPlugin(amp as never)
			await handlers.get('agent.start')?.(
				{ thread: { id: 'T-recorded' }, id: 'message-1', message: 'private prompt' },
				context,
			)
			const database = new Database(join(stateHome, 'amp-work-hours', 'state.sqlite'))
			const evidence = database.query('SELECT * FROM events').all()
			const outbox = database.query('SELECT * FROM outbox').all()
			expect(evidence).toHaveLength(1)
			expect(outbox).toHaveLength(1)
			database.exec(`
				CREATE TRIGGER reject_outbox BEFORE INSERT ON outbox
				BEGIN SELECT RAISE(ABORT, 'injected local failure'); END;
			`)
			await handlers.get('agent.start')?.(
				{ thread: { id: 'T-failure' }, id: 'message-1', message: 'private prompt' },
				context,
			)
			expect(notifications.at(-1)).toBe(
				'UNKNOWN · TRACKING INCOMPLETE · Cukup could not record agent.start locally.',
			)
			notifications.length = 0
			for (selection of ['Close', undefined]) {
				await commands.get('work-hours-status')?.(context)
				expect(dialogs.at(-1)?.options).toEqual(['Acknowledge tracking gap', 'Close'])
				expect(dialogs.at(-1)?.message).toContain('HISTORICAL TRACKING GAP')
			}
			expect(confirmations).toHaveLength(0)
			selection = 'Acknowledge tracking gap'
			await commands.get(command)?.(context)
			expect(confirmations.at(-1)).toEqual({
				title: 'Acknowledge historical tracking gap?',
				message: 'This dismisses the warning only. Missing evidence will not be recovered or added to your totals.',
				confirmButtonText: 'Acknowledge gap',
			})
			selection = 'Close'
			await commands.get('work-hours-status')?.(context)
			expect(dialogs.at(-1)?.message).toContain('HISTORICAL TRACKING GAP')
			expect(notifications).toHaveLength(0)

			selection = 'Acknowledge tracking gap'
			confirmed = true
			await commands.get(command)?.(context)
			expect(notifications.at(-1)).toBe(
				'Historical tracking-gap warning acknowledged. Recorded evidence is unchanged.',
			)
			expect(
				database
					.query<{ value: string }, []>(
						"SELECT value FROM settings WHERE key = 'tracking-incomplete'",
					)
					.get()?.value,
			).toBe('false')
			expect(database.query('SELECT * FROM events').all()).toEqual(evidence)
			expect(database.query('SELECT * FROM outbox').all()).toEqual(outbox)
			selection = 'Close'
			await commands.get('work-hours-status')?.(context)
			expect(dialogs.at(-1)?.options).toEqual(['Close'])
			expect(dialogs.at(-1)?.message).not.toContain('HISTORICAL TRACKING GAP')

			database.exec('DROP TABLE events')
			await commands.get('work-hours-status')?.(context)
			expect(dialogs.at(-1)?.options).toEqual(['Close'])
			expect(dialogs.at(-1)?.message).toContain('UNKNOWN · TRACKING INCOMPLETE')
			database.close()
		} finally {
			await Promise.all(disposers.map((dispose) => dispose()))
			if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = previousStateHome
		}
	})

	test('retries failed resolution, then verifies and caches the exact Amp Project without workspace configuration', async () => {
		const stateHome = mkdtempSync(join(tmpdir(), 'amp-work-hours-plugin-test-'))
		temporaryDirectories.push(stateHome)
		const previousStateHome = process.env.XDG_STATE_HOME
		process.env.XDG_STATE_HOME = stateHome
		const commands = new Map<string, (context: any) => unknown>()
		const disposers: Array<() => unknown> = []
		let projectLookups = 0
		const amp = {
			registerTool() { return { unsubscribe() {} } },
			on() { return { unsubscribe() {} } },
			registerCommand(id: string, _options: unknown, handler: (context: any) => unknown) {
				commands.set(id, handler)
				return { unsubscribe() {}, setAvailability() {} }
			},
			onDispose(callback: () => unknown) { disposers.push(callback); return { unsubscribe() {} } },
			threads: { get: () => idleThread() },
			configuration: {
				get: async () => { throw new Error('configuration must not be read') },
				update: async () => { throw new Error('configuration must not be written') },
				delete: async () => { throw new Error('configuration must not be written') },
			},
			system: {
				executor: { kind: 'local' },
				user: { workspace: null },
				workspaceRoot: {},
			},
			$: async (_strings: TemplateStringsArray, projectID: string) => {
				projectLookups += 1
				if (projectLookups === 1) return { exitCode: 1, stdout: '', stderr: 'temporary failure' }
				return {
					exitCode: 0,
					stdout: JSON.stringify({ id: projectID, name: 'Cukup Lead' }),
					stderr: '',
				}
			},
		}
		const selectionDialogs: Array<{ title: string; options: string[]; message?: string }> = []
		const context = {
			ui: {
				select: async (options: { title: string; options: string[]; message?: string }) => {
					selectionDialogs.push(options)
					return 'Close'
				},
			},
		}

		try {
			workHoursPlugin(amp as never)
			await commands.get('project-slug-set')?.(context)
			await commands.get('project-slug-set')?.(context)
			await commands.get('project-slug-set')?.(context)
			expect(projectLookups).toBe(2)
			expect(selectionDialogs).toHaveLength(3)
			expect(selectionDialogs[0]?.message).toContain('No valid Amp Project could be resolved.')
			expect(selectionDialogs[1]).toMatchObject({
				title: 'Cukup project attribution',
				options: ['Close'],
			})
			expect(selectionDialogs[1]?.message).toContain('Amp Project: **Cukup Lead**')
			expect(selectionDialogs[1]?.message).toContain('Project Slug: **cukup-lead**')
			expect(selectionDialogs[1]?.message).toContain('No repository setting is used.')
			expect(selectionDialogs[2]?.message).toBe(selectionDialogs[1]?.message)
		} finally {
			await Promise.all(disposers.map((dispose) => dispose()))
			if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = previousStateHome
		}
	})

	test('resolves and caches the exact Amp Project matched to a physical workspace', async () => {
		delete process.env.AMP_PROJECT_ID
		const commands = new Map<string, (context: any) => unknown>()
		let projectLookups = 0
		const project = { id: 'project-bta', name: 'BookThatApp React' }
		const amp = {
			registerTool() { return { unsubscribe() {} } },
			on() { return { unsubscribe() {} } },
			registerCommand(id: string, _options: unknown, handler: (context: any) => unknown) {
				commands.set(id, handler)
				return { unsubscribe() {}, setAvailability() {} }
			},
			onDispose() { return { unsubscribe() {} } },
			threads: { get: () => idleThread() },
			configuration: {
				get: async () => { throw new Error('configuration must not be read') },
				update: async () => { throw new Error('configuration must not be written') },
				delete: async () => { throw new Error('configuration must not be written') },
			},
			system: { executor: { kind: 'local' }, user: { workspace: null }, workspaceRoot: {} },
			helpers: { filePathFromURI: () => '/workspaces/bookthatapp' },
			$: async (strings: TemplateStringsArray, workspaceRoot: string) => {
				projectLookups += 1
				expect([...strings]).toEqual(['cd ', ' && amp projects status --json'])
				expect(workspaceRoot).toBe('/workspaces/bookthatapp')
				return {
					exitCode: 0,
					stdout: JSON.stringify({ status: 'matched', matches: [project], project }),
					stderr: '',
				}
			},
		}
		const messages: string[] = []
		const context = {
			ui: {
				select: async (options: { message: string }) => {
					messages.push(options.message)
					return 'Close'
				},
			},
		}

		workHoursPlugin(amp as never)
		await commands.get('project-slug-set')?.(context)
		await commands.get('project-slug-set')?.(context)
		expect(projectLookups).toBe(1)
		expect(messages).toHaveLength(2)
		expect(messages[0]).toContain('Amp Project: **BookThatApp React**')
		expect(messages[0]).toContain('Project Slug: **bookthatapp-react**')
		expect(messages[1]).toBe(messages[0])
	})

	test('fails visibly to Unassigned without an Amp Project and never accesses configuration', async () => {
		delete process.env.AMP_PROJECT_ID
		const stateHome = mkdtempSync(join(tmpdir(), 'amp-work-hours-plugin-test-'))
		temporaryDirectories.push(stateHome)
		const previousStateHome = process.env.XDG_STATE_HOME
		process.env.XDG_STATE_HOME = stateHome
		const commands = new Map<string, (context: any) => unknown>()
		const disposers: Array<() => unknown> = []
		const amp = {
			registerTool() { return { unsubscribe() {} } },
			on() { return { unsubscribe() {} } },
			registerCommand(id: string, _options: unknown, handler: (context: any) => unknown) {
				commands.set(id, handler)
				return { unsubscribe() {}, setAvailability() {} }
			},
			onDispose(callback: () => unknown) { disposers.push(callback); return { unsubscribe() {} } },
			configuration: {
				get: async () => { throw new Error('configuration must not be read') },
				update: async () => { throw new Error('configuration must not be written') },
				delete: async () => { throw new Error('configuration must not be written') },
			},
			threads: { get: () => idleThread() },
			system: { executor: { kind: 'unknown' }, user: { workspace: null }, workspaceRoot: null },
			$: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
		}
		let message = ''
		let projectLookups = 0
		amp.$ = async () => {
			projectLookups += 1
			return { exitCode: 0, stdout: '', stderr: '' }
		}

		try {
			workHoursPlugin(amp as never)
			await commands.get('project-slug-set')?.({
				ui: { select: async (options: { message: string }) => { message = options.message } },
			})
			expect(message).toContain('No valid Amp Project could be resolved.')
			expect(message).toContain('**Unassigned**')
			expect(projectLookups).toBe(0)
		} finally {
			await Promise.all(disposers.map((dispose) => dispose()))
			if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = previousStateHome
		}
	})

	test('selects exact local host and remote amp-orb profiles without probing a remote hostname', () => {
		expect(executorProfileFor('local', () => 'fleet-host-1')).toEqual({
			kind: 'local',
			hostname: 'fleet-host-1',
		})
		expect(
			executorProfileFor('remote', () => { throw new Error('remote hostname must not be read') }),
		).toEqual({ kind: 'remote', executorLabel: 'amp-orb' })
		expect(executorProfileFor('unknown')).toBeUndefined()
	})

	test('keeps real legacy records and outbox unchanged while the enabled shadow collector writes only its receiver', async () => {
		const stateHome = mkdtempSync(join(tmpdir(), 'amp-work-hours-plugin-shadow-test-'))
		temporaryDirectories.push(stateHome)
		const previousStateHome = process.env.XDG_STATE_HOME
		const previousFetch = globalThis.fetch
		process.env.XDG_STATE_HOME = stateHome
		process.env.CUKUP_SERVICE_URL = 'disabled-for-isolated-shadow-proof'
		process.env.CUKUP_EXPERIMENTAL_AMP_SHADOW = '1'
		process.env.CUKUP_EXPERIMENTAL_RUNTIME_STATE_DIR = join(stateHome, 'runtime')
		const runtime = startLocalHarnessEvidenceRuntime({
			stateDirectory: process.env.CUKUP_EXPERIMENTAL_RUNTIME_STATE_DIR,
		})
		let cloudRequests = 0
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : input)
			if (url.hostname !== '127.0.0.1') cloudRequests += 1
			return previousFetch(input, init)
		}) as typeof fetch
		const handlers = new Map<string, Array<(event: any, context?: any) => unknown>>()
		const observers = new Set<(state: 'running' | 'idle') => void>()
		let dispose = async () => {}
		let tokenMintCalls = 0
		const amp = {
			registerTool() { return { unsubscribe() {} } },
			logger: { log() {} },
			on(name: string, handler: (event: any, context?: any) => unknown) {
				const registered = handlers.get(name) ?? []
				registered.push(handler)
				handlers.set(name, registered)
				return { unsubscribe() {} }
			},
			registerCommand() { return { unsubscribe() {}, setAvailability() {} } },
			onDispose(callback: () => unknown) {
				dispose = async () => { await callback() }
				return { unsubscribe() {} }
			},
			threads: {
				get: () => ({
					state: {
						get: async () => 'idle' as const,
						subscribe(observer: (state: 'running' | 'idle') => void) {
							observers.add(observer)
							return { unsubscribe: () => observers.delete(observer) }
						},
					},
				}),
			},
			configuration: { get: async () => ({}), update: async () => {}, delete: async () => {} },
			system: { executor: { kind: 'remote' }, user: { workspace: null }, workspaceRoot: null },
			helpers: { filePathFromURI: () => '/synthetic' },
			$: async (strings: TemplateStringsArray) => {
				if (strings.join('').includes('orb id-token')) tokenMintCalls += 1
				return { exitCode: 1, stdout: '', stderr: '' }
			},
		}
		const context = { ui: { notify: async () => {} } }
		const event = { thread: { id: 'T-synthetic' }, id: 'message-synthetic', message: 'private' }

		try {
			workHoursPlugin(amp as never)
			await Promise.all((handlers.get('agent.start') ?? []).map((handler) => handler(event, context)))
			for (const observer of observers) observer('running')
			await Promise.all(
				(handlers.get('agent.end') ?? []).map((handler) =>
					handler({ ...event, status: 'done', messages: [] }, context),
				),
			)
			await Bun.sleep(100)
			await dispose()

			const legacy = new Database(join(stateHome, 'amp-work-hours', 'state.sqlite'), { readonly: true })
			expect(legacy.query<{ count: number }, []>('SELECT count(*) AS count FROM events').get()!.count).toBe(2)
			expect(legacy.query<{ count: number }, []>('SELECT count(*) AS count FROM outbox').get()!.count).toBe(2)
			legacy.close()
			const receiver = new Database(join(stateHome, 'runtime', 'receiver.sqlite'), { readonly: true })
			expect(receiver.query<{ count: number }, []>('SELECT count(*) AS count FROM execution_segments').get()!.count).toBe(1)
			expect(receiver.query<{ count: number }, []>('SELECT count(*) AS count FROM execution_segments WHERE end_at IS NOT NULL').get()!.count).toBe(1)
			receiver.close()
			expect(tokenMintCalls).toBe(0)
			expect(cloudRequests).toBe(0)
		} finally {
			await runtime.stop()
			globalThis.fetch = previousFetch
			if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = previousStateHome
		}
	})
})
