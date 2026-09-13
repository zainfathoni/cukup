import { isAbsolute, resolve } from 'node:path'
import {
	startLocalHarnessEvidenceRuntime,
	type LocalHarnessEvidenceRuntime,
} from './local-harness-evidence-runtime.ts'

export const LOCAL_HARNESS_EVIDENCE_RECEIVER_USAGE =
	'Usage: cukup-experimental-receiver --state-directory <absolute-path>\n'
export const LOCAL_HARNESS_EVIDENCE_RECEIVER_FAILURE =
	'Cukup experimental receiver failed\n'

export type LocalHarnessEvidenceReceiverSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM'

export type LocalHarnessEvidenceReceiverCommandHooks = Readonly<{
	startRuntime?: (stateDirectory: string) => LocalHarnessEvidenceRuntime
	onSignal?: (
		signal: LocalHarnessEvidenceReceiverSignal,
		handler: () => void,
	) => () => void
	retainSignalHandlersUntilExit?: boolean
	writeStderr?: (message: string) => void
}>

/** Runs one foreground receiver lifecycle without owning process-global exit behavior. */
export async function runLocalHarnessEvidenceReceiverCommand(
	args: readonly string[],
	hooks: LocalHarnessEvidenceReceiverCommandHooks = {},
): Promise<number> {
	const writeStderr = hooks.writeStderr ?? ((message) => process.stderr.write(message))
	const stateDirectory = parseStateDirectory(args)
	if (stateDirectory === undefined) {
		writeStderr(LOCAL_HARNESS_EVIDENCE_RECEIVER_USAGE)
		return 2
	}

	const startRuntime =
		hooks.startRuntime ??
		((directory: string) => startLocalHarnessEvidenceRuntime({ stateDirectory: directory }))
	const onSignal = hooks.onSignal ?? processSignalSubscription
	let runtime: LocalHarnessEvidenceRuntime | undefined
	let starting = true
	let processing = false
	let finished = false
	let terminating = false
	let failed = false
	const pending: LocalHarnessEvidenceReceiverSignal[] = []
	const subscriptions: Array<() => void> = []
	let resolveCompletion!: (exitCode: number) => void
	const completion = new Promise<number>((resolve) => {
		resolveCompletion = resolve
	})

	const finish = (exitCode: number): void => {
		if (finished) return
		finished = true
		if (!hooks.retainSignalHandlersUntilExit) {
			for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
		}
		if (exitCode !== 0) writeStderr(LOCAL_HARNESS_EVIDENCE_RECEIVER_FAILURE)
		resolveCompletion(exitCode)
	}

	const drain = async (): Promise<void> => {
		if (starting || processing || finished || runtime === undefined) return
		processing = true
		try {
			while (pending.length > 0 && !finished) {
				const signal = pending.shift()!
				if (signal === 'SIGHUP') {
					if (terminating) continue
					try {
						runtime.rotateReceiverToken()
					} catch {
						failed = true
						terminating = true
						pending.length = 0
					}
					continue
				}

				terminating = true
				pending.length = 0
			}

			if (terminating) {
				try {
					await runtime.stop()
				} catch {
					failed = true
				}
				finish(failed ? 1 : 0)
			}
		} finally {
			processing = false
		}
	}

	const request = (signal: LocalHarnessEvidenceReceiverSignal): void => {
		if (finished || (terminating && signal === 'SIGHUP')) return
		if (signal === 'SIGINT' || signal === 'SIGTERM') {
			if (terminating) return
			terminating = true
		}
		pending.push(signal)
		void drain()
	}

	try {
		for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
			subscriptions.push(onSignal(signal, () => request(signal)))
		}
		runtime = startRuntime(stateDirectory)
	} catch {
		finish(1)
		return completion
	} finally {
		starting = false
	}

	void drain()
	return completion
}

function parseStateDirectory(args: readonly string[]): string | undefined {
	if (args.length !== 2 || args[0] !== '--state-directory') return undefined
	const path = args[1]!
	if (!isAbsolute(path) || path.length === 0 || path !== path.trim() || resolve(path) !== path || path === '/') {
		return undefined
	}
	return path
}

function processSignalSubscription(
	signal: LocalHarnessEvidenceReceiverSignal,
	handler: () => void,
): () => void {
	process.on(signal, handler)
	return () => process.off(signal, handler)
}

if (import.meta.main) {
	process.exitCode = await runLocalHarnessEvidenceReceiverCommand(process.argv.slice(2), {
		retainSignalHandlersUntilExit: true,
	})
}
