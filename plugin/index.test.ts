import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import workHoursPlugin from './index.ts'

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
		const amp = {
			on(name: string, handler: (event: any, context?: any) => unknown) {
				handlers.set(name, handler)
				return { unsubscribe() {} }
			},
			registerCommand(
				id: string,
				options: { category: string },
				handler: (context: any) => unknown,
			) {
				commands.set(id, handler)
				commandCategories.set(id, options.category)
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
				system: { executor: { kind: 'local' } },
				$: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
		}
		const context = {
			ui: {
				notify: async (message: string) => notifications.push(message),
				input: async () => '0:01',
				select: async (options: { title: string; message?: string; options: string[] }) => {
					statusDialogs.push(options)
					return 'Close'
				},
			},
		}

		try {
			workHoursPlugin(amp as never)
			expect([...handlers.keys()]).toEqual(['agent.start', 'agent.end'])
			expect([...commands.keys()]).toEqual(['work-hours-status', 'work-hours-set-target'])
			expect([...commandCategories.values()]).toEqual(['cukup', 'cukup'])

			const event = {
				thread: { id: 'T-smoke' },
				id: 'message-1',
				message: 'smoke',
			}
			handlers.get('agent.start')?.(event, context)
			handlers.get('agent.end')?.({ ...event, status: 'done', messages: [] }, context)
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
			system: { executor: { kind: 'local' } },
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
			handlers.get('agent.start')?.(
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
})
