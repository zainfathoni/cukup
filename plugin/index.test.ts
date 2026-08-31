import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import workHoursPlugin, { executorProfileFor } from './index.ts'
import { PROJECT_SLUG_CONFIG_KEY } from './project.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
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
				options: { category: string; availability?: unknown },
				handler: (context: any) => unknown,
			) {
				commands.set(id, handler)
				commandCategories.set(id, options.category)
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
			system: { executor: { kind: 'local' }, user: { workspace: {} } },
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
				'work-hours-set-target',
			])
			expect([...commandCategories.values()]).toEqual(['cukup', 'cukup', 'cukup'])
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
				user: { workspace: {} },
				get workspaceRoot() { throw new Error('workspaceRoot must not be read') },
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

	test('hides Project Slug configuration without an Amp workspace', async () => {
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
			system: { executor: { kind: 'unknown' }, user: { workspace: null } },
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
