import type { PluginAPI, ThreadState } from '@ampcode/plugin'
import { Database } from 'bun:sqlite'
import { isAbsolute, join, resolve } from 'node:path'
import { createExperimentalAmpShadowCollector } from '../plugin/experimental-amp-shadow-collector.ts'

const [runtimeStateDirectory, collectorStateDirectory] = process.argv.slice(2)

async function run(): Promise<boolean> {
	if (
		!runtimeStateDirectory ||
		!collectorStateDirectory ||
		!isAbsolute(runtimeStateDirectory) ||
		!isAbsolute(collectorStateDirectory) ||
		resolve(runtimeStateDirectory) !== runtimeStateDirectory ||
		resolve(collectorStateDirectory) !== collectorStateDirectory
	) {
		return false
	}
	let database: Database | undefined
	let collector: ReturnType<typeof createExperimentalAmpShadowCollector> | undefined
	try {
		const handlers = new Map<string, Array<(event: any) => unknown>>()
		const observers = new Set<(state: ThreadState) => void>()
		const amp = {
			logger: { log: () => { process.stderr.write('experimental Amp shadow collection warning\n') } },
			on(name: string, handler: (event: any) => unknown) {
				const registered = handlers.get(name) ?? []
				registered.push(handler)
				handlers.set(name, registered)
				return { unsubscribe() {} }
			},
			threads: {
				get() {
					return {
						state: {
							get: async () => 'idle' as const,
							subscribe(observer: (state: ThreadState) => void) {
								observers.add(observer)
								return { unsubscribe: () => observers.delete(observer) }
							},
						},
					}
				},
			},
		} as unknown as PluginAPI
		database = new Database(join(runtimeStateDirectory, 'receiver.sqlite'), {
			readonly: true,
			strict: true,
		})
		const countAccepted = () =>
			database!.query<{ count: number }, []>('SELECT count(*) AS count FROM accepted_evidence').get()!.count
		const before = countAccepted()
		collector = createExperimentalAmpShadowCollector({
			amp,
			runtimeStateDirectory,
			collectorStateDirectory,
		})
		const event = { thread: { id: 'synthetic-thread' }, id: 'synthetic-turn', message: 'synthetic' }
		for (const handler of handlers.get('agent.start') ?? []) handler(event)
		for (const observer of observers) observer('running')
		for (const observer of observers) observer('awaiting-approval')
		for (const observer of observers) observer('running')
		for (const handler of handlers.get('agent.end') ?? []) {
			handler({ ...event, status: 'done', messages: [] })
		}
		await Bun.sleep(250)
		await collector.dispose()
		collector = undefined
		if (countAccepted() - before !== 4) return false
		process.stdout.write('experimental Amp shadow collector harness accepted 4 synthetic records\n')
		return true
	} catch {
		return false
	} finally {
		try {
			await collector?.dispose()
		} catch {}
		try {
			database?.close()
		} catch {}
	}
}

if (!(await run())) {
	process.stderr.write('experimental Amp shadow collector harness failed\n')
	process.exitCode = 1
}
