import { afterEach, describe, expect, test } from 'bun:test'
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

		const handlers = new Map<string, (event: any) => unknown>()
		const commands = new Map<string, (context: any) => unknown>()
		const disposers: Array<() => unknown> = []
		const notifications: string[] = []
		const amp = {
			on(name: string, handler: (event: any) => unknown) {
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
			threads: {
				get() {
					return { state: { get: async () => 'idle' } }
				},
			},
		}
		const context = {
			ui: {
				notify: async (message: string) => notifications.push(message),
				input: async () => '0:01',
			},
		}

		try {
			workHoursPlugin(amp as never)
			expect([...handlers.keys()]).toEqual(['agent.start', 'agent.end'])
			expect([...commands.keys()]).toEqual(['work-hours-status', 'work-hours-set-target'])

			const event = {
				thread: { id: 'T-smoke' },
				id: 'message-1',
				message: 'smoke',
			}
			handlers.get('agent.start')?.(event)
			handlers.get('agent.end')?.({ ...event, status: 'done', messages: [] })
			await commands.get('work-hours-status')?.(context)
			expect(notifications.at(-1)).toMatch(/^(UNDER|COMPLETE|OVER|NO HOURS DUE) · /)

			await commands.get('work-hours-set-target')?.(context)
			expect(notifications.at(-1)).toBe('Weekday target set to 1m.')
		} finally {
			for (const dispose of disposers) dispose()
			if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
			else process.env.XDG_STATE_HOME = previousStateHome
		}
	})
})
