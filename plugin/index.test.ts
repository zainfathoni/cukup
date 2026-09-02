import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import workHoursPlugin, { executorProfileFor } from './index.ts'
import { PROJECT_SLUG_CONFIG_KEY } from './project.ts'
import { jakartaDateString } from './tracker.ts'

const temporaryDirectories: string[] = []
let previousTokenFile: string | undefined
let previousServiceURL: string | undefined

beforeEach(() => {
	previousTokenFile = process.env.CUKUP_TOKEN_FILE
	previousServiceURL = process.env.CUKUP_SERVICE_URL
	process.env.CUKUP_TOKEN_FILE = '/nonexistent/cukup-plugin-test-token'
	process.env.CUKUP_SERVICE_URL = 'https://api.cukup.dev'
})

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
	if (previousTokenFile === undefined) delete process.env.CUKUP_TOKEN_FILE
	else process.env.CUKUP_TOKEN_FILE = previousTokenFile
	if (previousServiceURL === undefined) delete process.env.CUKUP_SERVICE_URL
	else process.env.CUKUP_SERVICE_URL = previousServiceURL
})

describe('work-hours plugin', () => {
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
		const amp = {
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
					return { state: { get: async () => 'idle' } }
				},
			},
			configuration: {
				get: async () => ({ [PROJECT_SLUG_CONFIG_KEY]: 'cukup-plugin' }),
				update: async () => {},
				delete: async () => {},
			},
			system: { executor: { kind: 'local' }, user: { workspace: null }, workspaceRoot: {} },
				$: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
		}
		const context = {
			ui: {
				notify: async (message: string) => notifications.push(message),
				input: async () => '0:01',
				confirm: async () => true,
				select: async (options: { title: string; message?: string; options: string[] }) => {
					statusDialogs.push(options)
					return 'Close'
				},
			},
		}

		try {
			workHoursPlugin(amp as never)
			expect([...handlers.keys()]).toEqual(['agent.start', 'agent.end'])
			expect([...commands.keys()]).toEqual([
				'work-hours-status',
				'project-slug-set',
				'day-off-set',
				'work-hours-set-target',
			])
			expect([...commandCategories.values()]).toEqual(['cukup', 'cukup', 'cukup', 'cukup'])
			expect(commandTitles.get('day-off-set')).toBe('Set day off or half day')
			expect(commandAvailability.get('project-slug-set')).toEqual({ type: 'enabled' })

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
			on() { return { unsubscribe() {} } },
			registerCommand(id: string, _options: unknown, handler: (context: any) => unknown) {
				commands.set(id, handler)
				return { unsubscribe() {}, setAvailability() {} }
			},
			onDispose(callback: () => unknown) { disposers.push(callback); return { unsubscribe() {} } },
			threads: { get: () => ({ state: { get: async () => 'idle' } }) },
			configuration: {
				get: async () => ({}),
				update: async () => {},
				delete: async () => {},
			},
			system: { executor: { kind: 'local' }, user: { workspace: {} } },
			$: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
		}
		const inputs = ['2026-09-01', '2026-09-01', '2026-02-29']
		const inputOptions: Array<{ initialValue?: string; submitButtonText?: string }> = []
		const selections = [
			'Today',
			'Full day off (0m)',
			'Choose another date',
			'Half day (4h)',
			'Choose another date',
			'Clear / undo',
			'Choose another date',
		]
		const selectionOptions: string[][] = []
		const confirmations: Array<{ title: string; message?: string }> = []
		const notifications: string[] = []
		const context = {
			ui: {
				input: async (options: { initialValue?: string; submitButtonText?: string }) => {
					inputOptions.push(options)
					return inputs.shift()
				},
				select: async (options: { options: string[] }) => {
					selectionOptions.push(options.options)
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
			expect(inputOptions[0]).toMatchObject({
				initialValue: today,
				submitButtonText: 'Preview',
			})
			expect(selectionOptions).toEqual([
				['Today', 'Choose another date'],
				['Full day off (0m)', 'Half day (4h)', 'Clear / undo'],
				['Today', 'Choose another date'],
				['Full day off (0m)', 'Half day (4h)', 'Clear / undo'],
				['Today', 'Choose another date'],
				['Full day off (0m)', 'Half day (4h)', 'Clear / undo'],
				['Today', 'Choose another date'],
			])
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

	test('visibly marks tracking incomplete when a local transactional write fails', async () => {
		const stateHome = mkdtempSync(join(tmpdir(), 'amp-work-hours-plugin-test-'))
		temporaryDirectories.push(stateHome)
		const previousStateHome = process.env.XDG_STATE_HOME
		process.env.XDG_STATE_HOME = stateHome
		const handlers = new Map<string, (event: any, context: any) => unknown>()
		const disposers: Array<() => unknown> = []
		const notifications: string[] = []
		const amp = {
			on(name: string, handler: (event: any, context: any) => unknown) {
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
			threads: { get: () => ({ state: { get: async () => 'idle' } }) },
			configuration: {
				get: async () => ({}),
				update: async () => {},
				delete: async () => {},
			},
			system: { executor: { kind: 'local' }, user: { workspace: {} } },
			$: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
		}
		const context = { ui: { notify: async (message: string) => { notifications.push(message) } } }

		try {
			workHoursPlugin(amp as never)
			const database = new Database(join(stateHome, 'amp-work-hours', 'state.sqlite'))
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
			database.close()
		} finally {
			await Promise.all(disposers.map((dispose) => dispose()))
			if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = previousStateHome
		}
	})

	test('normalizes, previews, saves, and explicitly clears only workspace Project Slug configuration', async () => {
		const stateHome = mkdtempSync(join(tmpdir(), 'amp-work-hours-plugin-test-'))
		temporaryDirectories.push(stateHome)
		const previousStateHome = process.env.XDG_STATE_HOME
		process.env.XDG_STATE_HOME = stateHome
		const commands = new Map<string, (context: any) => unknown>()
		const disposers: Array<() => unknown> = []
		const updates: Array<{ partial: Record<string, unknown>; target: string }> = []
		const deletions: Array<{ key: string; target: string }> = []
		const configuration: Record<string, unknown> = { [PROJECT_SLUG_CONFIG_KEY]: 'old-project' }
		const amp = {
			on() { return { unsubscribe() {} } },
			registerCommand(id: string, _options: unknown, handler: (context: any) => unknown) {
				commands.set(id, handler)
				return { unsubscribe() {}, setAvailability() {} }
			},
			onDispose(callback: () => unknown) { disposers.push(callback); return { unsubscribe() {} } },
			threads: { get: () => ({ state: { get: async () => 'idle' } }) },
			configuration: {
				get: async () => ({ ...configuration }),
				update: async (partial: Record<string, unknown>, target: string) => {
					updates.push({ partial, target })
					Object.assign(configuration, partial)
				},
				delete: async (key: string, target: string) => {
					deletions.push({ key, target })
					delete configuration[key]
				},
			},
			system: {
				executor: { kind: 'local' },
				user: { workspace: null },
				workspaceRoot: {},
			},
			$: async () => { throw new Error('shell and remotes must not be read') },
		}
		const selections = ['Set or change', 'Clear']
		const confirmations: Array<{ title: string; message?: string }> = []
		const notifications: string[] = []
		const context = {
			ui: {
				select: async () => selections.shift(),
				input: async () => '  New_Project   Name ',
				confirm: async (options: { title: string; message?: string }) => {
					confirmations.push(options)
					return true
				},
				notify: async (message: string) => { notifications.push(message) },
			},
		}

		try {
			workHoursPlugin(amp as never)
			await commands.get('project-slug-set')?.(context)
			expect(confirmations[0]?.message).toContain('**new-project-name**')
			expect(updates).toEqual([
				{ partial: { [PROJECT_SLUG_CONFIG_KEY]: 'new-project-name' }, target: 'workspace' },
			])
			expect(notifications.at(-1)).toBe('Project Slug set to new-project-name.')

			await commands.get('project-slug-set')?.(context)
			expect(confirmations[1]).toMatchObject({ title: 'Clear project slug?' })
			expect(deletions).toEqual([{ key: PROJECT_SLUG_CONFIG_KEY, target: 'workspace' }])
			expect(notifications.at(-1)).toBe(
				'Project Slug cleared. Future turns will be Unassigned.',
			)
		} finally {
			await Promise.all(disposers.map((dispose) => dispose()))
			if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = previousStateHome
		}
	})

	test('hides Project Slug configuration without an open workspace', async () => {
		const stateHome = mkdtempSync(join(tmpdir(), 'amp-work-hours-plugin-test-'))
		temporaryDirectories.push(stateHome)
		const previousStateHome = process.env.XDG_STATE_HOME
		process.env.XDG_STATE_HOME = stateHome
		const availability = new Map<string, unknown>()
		const disposers: Array<() => unknown> = []
		const amp = {
			on() { return { unsubscribe() {} } },
			registerCommand(id: string, options: { availability?: unknown }) {
				availability.set(id, options.availability)
				return { unsubscribe() {}, setAvailability() {} }
			},
			onDispose(callback: () => unknown) { disposers.push(callback); return { unsubscribe() {} } },
			configuration: {
				get: async () => { throw new Error('configuration must not be read') },
				update: async () => { throw new Error('configuration must not be written') },
				delete: async () => { throw new Error('configuration must not be written') },
			},
			threads: { get: () => ({ state: { get: async () => 'idle' } }) },
			system: { executor: { kind: 'unknown' }, user: { workspace: null }, workspaceRoot: null },
			$: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
		}

		try {
			workHoursPlugin(amp as never)
			expect(availability.get('project-slug-set')).toEqual({ type: 'hidden' })
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
})
