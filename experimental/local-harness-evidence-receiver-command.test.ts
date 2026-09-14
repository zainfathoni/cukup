import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	LOCAL_HARNESS_EVIDENCE_RECEIVER_FAILURE,
	LOCAL_HARNESS_EVIDENCE_RECEIVER_USAGE,
	runLocalHarnessEvidenceReceiverCommand,
	type LocalHarnessEvidenceReceiverSignal,
} from './local-harness-evidence-receiver-command.ts'
import { discoverLocalHarnessEvidenceEndpoint } from './local-harness-evidence-runtime.ts'
import type { LocalHarnessEvidenceRuntime } from './local-harness-evidence-runtime.ts'
import {
	LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH,
	LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH,
} from './local-harness-evidence-http-server.ts'
import { LOCAL_PROTOCOL, LOCAL_PROTOCOL_VERSION } from './local-harness-evidence.ts'

const COMMAND = join(import.meta.dir, 'local-harness-evidence-receiver-command.ts')
const COLLECTOR = '20000000-0000-4000-8000-000000000001'
const EVIDENCE = '40000000-0000-4000-8000-000000000001'
const roots: string[] = []
const subprocesses: Bun.Subprocess[] = []

afterEach(async () => {
	for (const subprocess of subprocesses.splice(0)) {
		if (subprocess.exitCode === null) subprocess.kill('SIGKILL')
		await subprocess.exited
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function state(): string {
	const root = mkdtempSync(join(tmpdir(), 'cukup-receiver-command-'))
	roots.push(root)
	return join(root, 'state')
}

function spawnCommand(args: string[]) {
	const subprocess = Bun.spawn([process.execPath, COMMAND, ...args], {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	})
	subprocesses.push(subprocess)
	return subprocess
}

async function boundedExit(subprocess: Bun.Subprocess): Promise<number> {
	return await Promise.race([
		subprocess.exited,
		Bun.sleep(5_000).then(() => {
			throw new Error('subprocess did not exit')
		}),
	])
}

async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
	const deadline = Date.now() + 5_000
	let lastError: unknown
	while (Date.now() < deadline) {
		try {
			const value = await read()
			if (accept(value)) return value
		} catch (error) {
			lastError = error
		}
		await Bun.sleep(20)
	}
	throw lastError instanceof Error ? lastError : new Error('condition was not reached')
}

function signalHooks() {
	const handlers = new Map<LocalHarnessEvidenceReceiverSignal, () => void>()
	return {
		handlers,
		onSignal: (signal: LocalHarnessEvidenceReceiverSignal, handler: () => void) => {
			handlers.set(signal, handler)
			return () => handlers.delete(signal)
		},
	}
}

function fakeRuntime(overrides: Partial<LocalHarnessEvidenceRuntime> = {}): LocalHarnessEvidenceRuntime {
	return {
		endpoint: {
			protocol: LOCAL_PROTOCOL,
			protocol_version: LOCAL_PROTOCOL_VERSION,
			origin: 'http://127.0.0.1:1',
		},
		rotateReceiverToken: () => undefined,
		stop: async () => undefined,
		...overrides,
	}
}

describe('foreground receiver lifecycle', () => {
	test('passes an exact caller-assigned port to the runtime', async () => {
		const signals = signalHooks()
		let received: Readonly<{ stateDirectory: string; port?: number }> | undefined
		const stateDirectory = state()
		const command = runLocalHarnessEvidenceReceiverCommand(
			['--state-directory', stateDirectory, '--port', '49152'],
			{
				onSignal: signals.onSignal,
				startRuntime: (directory, port) => {
					received = { stateDirectory: directory, port }
					return fakeRuntime()
				},
			},
		)
		signals.handlers.get('SIGTERM')!()
		expect(await command).toBe(0)
		expect(received).toEqual({ stateDirectory, port: 49152 })
	})

	test('serializes termination requested during startup and stops exactly once', async () => {
		const signals = signalHooks()
		let stops = 0
		const command = runLocalHarnessEvidenceReceiverCommand(['--state-directory', state()], {
			onSignal: signals.onSignal,
			startRuntime: () => {
				signals.handlers.get('SIGTERM')!()
				signals.handlers.get('SIGINT')!()
				return fakeRuntime({ stop: async () => void (stops += 1) })
			},
		})
		expect(await command).toBe(0)
		expect(stops).toBe(1)
		expect(signals.handlers.size).toBe(0)
	})

	test('queues termination behind rotation and ignores later or repeated signals', async () => {
		const signals = signalHooks()
		const events: string[] = []
		const command = runLocalHarnessEvidenceReceiverCommand(['--state-directory', state()], {
			onSignal: signals.onSignal,
			startRuntime: () =>
				fakeRuntime({
					rotateReceiverToken: () => {
						events.push('rotate:start')
						signals.handlers.get('SIGTERM')!()
						signals.handlers.get('SIGHUP')!()
						signals.handlers.get('SIGINT')!()
						events.push('rotate:end')
					},
					stop: async () => void events.push('stop'),
				}),
		})
		signals.handlers.get('SIGHUP')!()
		expect(await command).toBe(0)
		expect(events).toEqual(['rotate:start', 'rotate:end', 'stop'])
	})

	test('rotation failure stops once and emits only the fixed failure', async () => {
		const signals = signalHooks()
		const stderr: string[] = []
		let stops = 0
		const command = runLocalHarnessEvidenceReceiverCommand(['--state-directory', state()], {
			onSignal: signals.onSignal,
			writeStderr: (message) => stderr.push(message),
			startRuntime: () =>
				fakeRuntime({
					rotateReceiverToken: () => {
						throw new Error('private rotation diagnostic')
					},
					stop: async () => void (stops += 1),
				}),
		})
		signals.handlers.get('SIGHUP')!()
		expect(await command).toBe(1)
		expect(stops).toBe(1)
		expect(stderr).toEqual([LOCAL_HARNESS_EVIDENCE_RECEIVER_FAILURE])
	})

	test('waits for one asynchronous stop while suppressing repeated termination and rotation', async () => {
		const signals = signalHooks()
		let stops = 0
		let rotations = 0
		let complete = false
		let releaseStop!: () => void
		const stopping = new Promise<void>((resolve) => {
			releaseStop = resolve
		})
		const command = runLocalHarnessEvidenceReceiverCommand(['--state-directory', state()], {
			onSignal: signals.onSignal,
			startRuntime: () =>
				fakeRuntime({
					rotateReceiverToken: () => void (rotations += 1),
					stop: () => {
						stops += 1
						return stopping
					},
				}),
		}).then((exitCode) => {
			complete = true
			return exitCode
		})
		signals.handlers.get('SIGTERM')!()
		signals.handlers.get('SIGINT')!()
		signals.handlers.get('SIGHUP')!()
		await Bun.sleep(0)
		expect(stops).toBe(1)
		expect(rotations).toBe(0)
		expect(complete).toBeFalse()
		releaseStop()
		expect(await command).toBe(0)
	})

	test('normalizes an asynchronous shutdown failure', async () => {
		const signals = signalHooks()
		const stderr: string[] = []
		const command = runLocalHarnessEvidenceReceiverCommand(['--state-directory', state()], {
			onSignal: signals.onSignal,
			writeStderr: (message) => stderr.push(message),
			startRuntime: () =>
				fakeRuntime({ stop: async () => { throw new Error('private shutdown diagnostic') } }),
		})
		signals.handlers.get('SIGINT')!()
		expect(await command).toBe(1)
		expect(stderr).toEqual([LOCAL_HARNESS_EVIDENCE_RECEIVER_FAILURE])
	})
})

describe('foreground receiver subprocess', () => {
	test('starts ready, rotates immediately, delivers, stops on both termination signals, and restarts durable state', async () => {
		const stateDirectory = state()
		const first = spawnCommand(['--state-directory', stateDirectory])
		const firstEndpoint = await eventually(
			() => discoverLocalHarnessEvidenceEndpoint(stateDirectory),
			() => true,
		)
		const site = readFileSync(join(stateDirectory, 'execution-site-id'), 'utf8')
		const oldToken = readFileSync(join(stateDirectory, 'receiver-token'), 'utf8')
		first.kill('SIGHUP')
		const token = await eventually(
			() => readFileSync(join(stateDirectory, 'receiver-token'), 'utf8'),
			(value) => value !== oldToken,
		)
		expect(
			(await fetch(`${firstEndpoint.origin}/experimental/local-harness-evidence/ready`, {
				headers: { authorization: `Bearer ${oldToken}` },
				signal: AbortSignal.timeout(1_000),
			})).status,
		).toBe(401)
		expect(await discoverLocalHarnessEvidenceEndpoint(stateDirectory)).toEqual(firstEndpoint)

		const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
		const negotiation = await fetch(`${firstEndpoint.origin}${LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH}`, {
			method: 'POST',
			headers,
			signal: AbortSignal.timeout(1_000),
			body: JSON.stringify({
				protocol: LOCAL_PROTOCOL,
				supported_versions: [LOCAL_PROTOCOL_VERSION],
				collector_instance_id: COLLECTOR,
				capabilities: ['engagement.submission'],
			}),
		})
		expect(negotiation.status).toBe(200)
		const submission = await fetch(`${firstEndpoint.origin}${LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH}`, {
			method: 'POST',
			headers,
			signal: AbortSignal.timeout(1_000),
			body: JSON.stringify({
				protocol: LOCAL_PROTOCOL,
				protocol_version: LOCAL_PROTOCOL_VERSION,
				collector_instance_id: COLLECTOR,
				capabilities: ['engagement.submission'],
				evidence: [{
					family: 'engagement',
					evidence_id: EVIDENCE,
					interaction: 'submission',
					origin: 'human',
					recovered: false,
					timing: {
						wall_time: new Date(Date.now() - 1_000).toISOString(),
						provenance: 'collector_observation',
						precision_ms: 1,
					},
					project_attribution: { kind: 'unassigned', reason: 'absent' },
				}],
			}),
		})
		expect(submission.status).toBe(200)
		expect(await submission.json()).toEqual({ outcomes: [{ evidence_id: EVIDENCE, status: 'accepted' }] })

		first.kill('SIGTERM')
		first.kill('SIGINT')
		first.kill('SIGHUP')
		expect(await boundedExit(first)).toBe(0)
		expect(await new Response(first.stderr).text()).toBe('')
		expect(await new Response(first.stdout).text()).toBe('')
		expect(() => statSync(join(stateDirectory, 'endpoint.json'))).toThrow()

		const second = spawnCommand(['--state-directory', stateDirectory])
		await eventually(() => discoverLocalHarnessEvidenceEndpoint(stateDirectory), () => true)
		expect(readFileSync(join(stateDirectory, 'execution-site-id'), 'utf8')).toBe(site)
		expect(readFileSync(join(stateDirectory, 'receiver-token'), 'utf8')).toBe(token)
		const database = new Database(join(stateDirectory, 'receiver.sqlite'), { readonly: true })
		try {
			expect(database.query<{ count: number }, []>('SELECT count(*) AS count FROM accepted_evidence').get()!.count).toBe(1)
		} finally {
			database.close()
		}
		second.kill('SIGINT')
		expect(await boundedExit(second)).toBe(0)
		expect(await new Response(second.stderr).text()).toBe('')
		expect(await new Response(second.stdout).text()).toBe('')
		expect(() => statSync(join(stateDirectory, 'endpoint.json'))).toThrow()
	})

	test('binds only the requested IPv4-loopback port', async () => {
		const reservation = Bun.listen({
			hostname: '127.0.0.1',
			port: 0,
			socket: { data: () => undefined },
		})
		const port = reservation.port
		reservation.stop(true)
		const stateDirectory = state()
		const subprocess = spawnCommand([
			'--state-directory',
			stateDirectory,
			'--port',
			String(port),
		])
		const endpoint = await eventually(
			() => discoverLocalHarnessEvidenceEndpoint(stateDirectory),
			() => true,
		)
		expect(endpoint.origin).toBe(`http://127.0.0.1:${port}`)
		subprocess.kill('SIGTERM')
		expect(await boundedExit(subprocess)).toBe(0)
	})

	test('refuses second ownership and reports no path or raw diagnostic', async () => {
		const stateDirectory = state()
		const first = spawnCommand(['--state-directory', stateDirectory])
		await eventually(() => discoverLocalHarnessEvidenceEndpoint(stateDirectory), () => true)
		const second = spawnCommand(['--state-directory', stateDirectory])
		expect(await boundedExit(second)).toBe(1)
		const stderr = await new Response(second.stderr).text()
		expect(stderr).toBe(LOCAL_HARNESS_EVIDENCE_RECEIVER_FAILURE)
		expect(stderr).not.toContain(stateDirectory)
		first.kill('SIGTERM')
		expect(await boundedExit(first)).toBe(0)
	})

	test('fails closed and exits visibly when SIGHUP cannot reconcile the token', async () => {
		const stateDirectory = state()
		const subprocess = spawnCommand(['--state-directory', stateDirectory])
		await eventually(() => discoverLocalHarnessEvidenceEndpoint(stateDirectory), () => true)
		writeFileSync(join(stateDirectory, 'receiver-token'), 'private malformed token', { mode: 0o600 })
		subprocess.kill('SIGHUP')
		expect(await boundedExit(subprocess)).toBe(1)
		expect(await new Response(subprocess.stderr).text()).toBe(LOCAL_HARNESS_EVIDENCE_RECEIVER_FAILURE)
		expect(() => statSync(join(stateDirectory, 'endpoint.json'))).toThrow()
	})

	test('strictly rejects missing, malformed, reordered, and extra arguments', async () => {
		const privateValue = 'private-native-value'
		for (const args of [
			[],
			['--state-directory'],
			['--state-directory', 'relative'],
			['--state-directory', '/'],
			['--state-directory', `/tmp/${privateValue}/../state`],
			['/tmp/state', '--state-directory'],
			['--state-directory', '/tmp/state', privateValue],
			['--state-directory', '/tmp/state', '--port'],
			['--state-directory', '/tmp/state', '--port', '0'],
			['--state-directory', '/tmp/state', '--port', '06535'],
			['--state-directory', '/tmp/state', '--port', '65536'],
			['--state-directory', '/tmp/state', '--port', privateValue],
			['--state-directory', '/tmp/state', privateValue, '49152'],
		]) {
			const subprocess = spawnCommand(args)
			expect(await boundedExit(subprocess)).toBe(2)
			const stderr = await new Response(subprocess.stderr).text()
			expect(stderr).toBe(LOCAL_HARNESS_EVIDENCE_RECEIVER_USAGE)
			expect(stderr).not.toContain(privateValue)
		}
	})
})
