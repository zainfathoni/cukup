import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { prepareLocalHarnessEvidenceDatabaseFile } from './local-harness-evidence-receiver.ts'
import { runLocalHarnessEvidenceReceiverCommand } from './local-harness-evidence-receiver-command.ts'
import { discoverLocalHarnessEvidenceEndpoint } from './local-harness-evidence-runtime.ts'

const LABEL = 'org.cukup.experimental-receiver'
const UNIT = `${LABEL}.service`
export const INSTALL_FAILURE = 'Cukup experimental installation failed\n'
export type Manager = 'linux' | 'darwin'
export type Action = 'install' | 'start' | 'status' | 'stop' | 'remove'
type Result = 'installed' | 'running' | 'loaded' | 'stopped' | 'absent' | 'removed'
type Run = (argv: string[]) => Promise<{ code: number; stdout: string }>
export type InstallOptions = {
	home: string
	platform: Manager
	/** Test seams; production always uses the fixed native manager and local compiler. */
	run?: Run
	build?: (destination: string) => Promise<void>
}

function exact(path: string): void {
	if (path === '/' || resolve(path) !== path || path.trim() !== path || /[\x00-\x1f\x7f]/.test(path)) throw new Error()
}

/** Reject untrusted ancestors; root-owned sticky /tmp is allowed for isolated tests. */
function directory(path: string, privateLeaf = false): void {
	exact(path)
	if (realpathSync(path) !== path) throw new Error()
	for (let current = path; current !== '/'; current = dirname(current)) {
		const st = lstatSync(current)
		if (!st.isDirectory() || st.isSymbolicLink() || (st.uid !== process.getuid!() && st.uid !== 0)) throw new Error()
		if ((st.mode & 0o022) !== 0 && !(st.uid === 0 && (st.mode & 0o1000) !== 0 && current !== path)) throw new Error()
		if (current === path && (st.uid !== process.getuid!() || (privateLeaf && (st.mode & 0o777) !== 0o700))) throw new Error()
	}
}

function ensureDirectory(path: string, privateLeaf = false): void {
	if (!exists(path)) {
		if (!exists(dirname(path))) ensureDirectory(dirname(path))
		directory(dirname(path))
		mkdirSync(path, { mode: 0o700 })
	}
	directory(path, privateLeaf)
}

function exists(path: string): boolean {
	try { lstatSync(path); return true } catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
		throw error
	}
}

function file(path: string, mode: number): Buffer {
	directory(dirname(path))
	if (!lstatSync(path).isFile()) throw new Error()
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const st = fstatSync(fd)
		if (!st.isFile() || st.uid !== process.getuid!() || st.nlink !== 1 || (st.mode & 0o7777) !== mode) throw new Error()
		return readFileSync(fd)
	} finally { closeSync(fd) }
}

function syncDirectory(path: string): void {
	const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
	try { fsyncSync(fd) } finally { closeSync(fd) }
}

function write(path: string, data: Uint8Array | string, mode: number): void {
	directory(dirname(path))
	const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
	try { writeFileSync(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
}

function erase(path: string, mode: number): void {
	if (!exists(path)) return
	file(path, mode)
	unlinkSync(path)
	syncDirectory(dirname(path))
}

export function installationPaths(home: string, platform: Manager) {
	exact(home)
	// systemd refuses these characters in executable names, regardless of escaping.
	if (platform === 'linux' && /["'\\]/.test(home)) throw new Error()
	const root = join(home, '.cukup-experimental-receiver')
	return {
		root,
		state: join(root, 'state'),
		binary: join(root, 'receiver'),
		definition: platform === 'linux'
			? join(home, '.config/systemd/user', UNIT)
			: join(home, 'Library/LaunchAgents', `${LABEL}.plist`),
	}
}

export function serviceDefinition(home: string, platform: Manager): string {
	const p = installationPaths(home, platform)
	if (platform === 'linux') {
		// systemd performs specifier and environment expansion even inside quotes.
		const quote = (s: string) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`
		return `[Unit]\nDescription=Cukup experimental receiver\n[Service]\nType=exec\nExecStart=:${quote(p.binary)} serve --state-directory ${quote(p.state)}\nUMask=0077\nStandardOutput=null\nStandardError=null\nRestart=no\nTimeoutStopSec=15\n`
	}
	const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
	return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>${xml(p.binary)}</string><string>serve</string><string>--state-directory</string><string>${xml(p.state)}</string></array><key>RunAtLoad</key><false/><key>KeepAlive</key><false/><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>\n`
}

const runNative: Run = async (argv) => {
	const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env: { ...process.env, LC_ALL: 'C' }, timeout: 15_000 })
	const stdout = await new Response(child.stdout).text()
	return { code: await child.exited, stdout }
}

async function compile(destination: string): Promise<void> {
	const child = Bun.spawn([process.execPath, 'build', '--compile', join(import.meta.dir, 'local-harness-evidence-install.ts'), '--outfile', destination], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', timeout: 120_000 })
	if (await child.exited !== 0) throw new Error()
}

/** Session-only service activation. No login enablement, collector installation, or state deletion. */
export async function manageInstallation(action: Action, options: InstallOptions): Promise<Result> {
	let lock: Database | undefined
	let runtimeLock: Database | undefined
	try {
		const { home, platform } = options
		if (platform !== 'linux' && platform !== 'darwin') throw new Error()
		directory(home)
		const p = installationPaths(home, platform)
		ensureDirectory(p.root, true)
		const lockPath = join(p.root, 'install-lock.sqlite')
		if (exists(lockPath)) file(lockPath, 0o600)
		for (const suffix of ['-journal', '-wal', '-shm']) if (exists(lockPath + suffix)) file(lockPath + suffix, 0o600)
		prepareLocalHarnessEvidenceDatabaseFile(lockPath)
		lock = new Database(lockPath)
		lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
		const excludeRuntime = () => {
			if (!exists(p.state)) return
			directory(p.state, true)
			const ownership = join(p.state, 'runtime-ownership.sqlite')
			if (exists(ownership)) file(ownership, 0o600)
			for (const suffix of ['-journal', '-wal', '-shm']) if (exists(ownership + suffix)) file(ownership + suffix, 0o600)
			prepareLocalHarnessEvidenceDatabaseFile(ownership)
			runtimeLock = new Database(ownership)
			runtimeLock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
		}
		const run = options.run ?? runNative
		const command = async (args: string[]) => {
			const result = await run(args)
			if (result.code !== 0) throw new Error()
			return result.stdout
		}
		const systemctl = '/usr/bin/systemctl'
		const launchctl = '/bin/launchctl'
		const domain = `gui/${process.getuid!()}`
		const target = `${domain}/${LABEL}`
		const status = async (): Promise<Result> => {
			if (platform === 'linux') {
				// Manager availability must be established before interpreting a missing unit.
				await command([systemctl, '--user', 'show-environment'])
				const output = await command([systemctl, '--user', 'show', UNIT, '--property=LoadState,ActiveState,FragmentPath,DropInPaths', '--no-pager'])
				const fields = new Set(output.trim().split('\n'))
				if (fields.size !== 4 || !fields.has('DropInPaths=')) throw new Error()
				if (fields.has('LoadState=not-found') && fields.has('ActiveState=inactive') && fields.has('FragmentPath=')) return 'absent'
				if (!fields.has('LoadState=loaded') || !fields.has(`FragmentPath=${p.definition}`)) throw new Error()
				if (fields.has('ActiveState=inactive') || fields.has('ActiveState=failed')) return 'stopped'
				if (fields.has('ActiveState=active')) return 'running'
				throw new Error()
			}
			await command([launchctl, 'print', domain])
			const result = await run([launchctl, 'print', target])
			if (result.code === 113) return 'absent'
			if (result.code !== 0) throw new Error()
			// Experimental compatibility check: launchctl print is not a stable API.
			const origins = result.stdout.split('\n').filter((line) => line.startsWith('\tpath = '))
			if (origins.length !== 1 || origins[0] !== `\tpath = ${p.definition}` || file(p.definition, 0o600).toString() !== serviceDefinition(home, platform)) throw new Error()
			return 'loaded'
		}
		const stop = async () => {
			const current = await status()
			if (platform === 'linux' && current !== 'absent') await command([systemctl, '--user', 'stop', UNIT])
			if (platform === 'darwin' && current === 'loaded') await command([launchctl, 'bootout', target])
			const after = await status()
			if (after !== 'absent' && after !== 'stopped') throw new Error()
		}
		const pending = join(p.root, 'pending')
		const backup = join(p.root, 'receiver.previous')
		const staged = join(p.root, 'receiver.next')
		const unitNext = `${p.definition}.next`
		const buildDir = join(p.root, 'build')
		const clearBuild = () => {
			if (!exists(buildDir)) return
			directory(buildDir, true)
			const output = join(buildDir, 'receiver')
			if (exists(output)) {
				const mode = lstatSync(output).mode & 0o777
				if (mode !== 0o755 && mode !== 0o700 && mode !== 0o644 && mode !== 0o600) throw new Error()
				erase(output, mode)
			}
			rmdirSync(buildDir)
			syncDirectory(p.root)
		}
		if (exists(pending) && action !== 'remove' && action !== 'stop') throw new Error()
		if (exists(p.binary)) file(p.binary, 0o700)
		if (exists(p.definition) && file(p.definition, 0o600).toString() !== serviceDefinition(home, platform)) throw new Error()
		if (action === 'status') return await status()
		if (action === 'stop') { await stop(); excludeRuntime(); return 'stopped' }
		if (action === 'remove') {
			await stop()
			excludeRuntime()
			clearBuild()
			// Known files only. Retain state and the serialization database, including on partial removal.
			for (const [path, mode] of [[p.definition, 0o600], [unitNext, 0o600], [p.binary, 0o700], [backup, 0o700], [staged, 0o700], [pending, 0o600]] as const) erase(path, mode)
			if (platform === 'linux') await command([systemctl, '--user', 'daemon-reload'])
			return 'removed'
		}
		if (action === 'start') {
			file(p.binary, 0o700)
			file(p.definition, 0o600)
			const current = await status()
			if (platform === 'linux') {
				await command([systemctl, '--user', 'daemon-reload'])
				await status()
				await command([systemctl, '--user', 'start', UNIT])
			} else {
				if (current === 'absent') await command([launchctl, 'bootstrap', domain, p.definition])
				await command([launchctl, 'kickstart', target])
			}
			const after = await status()
			if (after !== 'running' && after !== 'loaded') throw new Error()
			if (!options.run) {
				const deadline = Date.now() + 5_000
				while (true) {
					try { await discoverLocalHarnessEvidenceEndpoint(p.state); break } catch {
						if (Date.now() >= deadline) throw new Error()
						await Bun.sleep(50)
					}
				}
			}
			return after
		}
		await status()
		ensureDirectory(dirname(p.definition))
		for (const path of [backup, staged, unitNext, buildDir]) if (exists(path)) throw new Error()
		const oldBinary = exists(p.binary)
		const oldDefinition = exists(p.definition)
		if (oldBinary !== oldDefinition) throw new Error()
		write(pending, 'pending\n', 0o600)
		syncDirectory(p.root)
		let replaced = false
		let definitionPublished = false
		let backedUp = false
		let stagedOwned = false
		let unitNextOwned = false
		let committed = false
		try {
			// The compiler writes exclusively into an owner-only fresh directory.
			mkdirSync(buildDir, { mode: 0o700 })
			try {
				const output = join(buildDir, 'receiver')
				await (options.build ?? compile)(output)
				directory(p.root, true)
				directory(buildDir, true)
				// Bun emits 0755; copy through O_NOFOLLOW and an owner-only destination.
				if (!lstatSync(output).isFile()) throw new Error()
				const fd = openSync(output, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
				try {
					const st = fstatSync(fd)
					if (!st.isFile() || st.uid !== process.getuid!() || st.nlink !== 1 || (st.mode & 0o022) !== 0) throw new Error()
					write(staged, readFileSync(fd), 0o700)
					stagedOwned = true
				} finally { closeSync(fd) }
				unlinkSync(output)
			} finally {
				// Never recursively remove unexpected compiler output.
				clearBuild()
			}
			const current = await status()
			directory(p.root, true)
			if (exists(p.binary) !== oldBinary || exists(p.definition) !== oldDefinition || exists(backup) || exists(unitNext)) throw new Error()
			if (oldDefinition && file(p.definition, 0o600).toString() !== serviceDefinition(home, platform)) throw new Error()
			if (oldBinary && createHash('sha256').update(file(p.binary, 0o700)).digest('hex') === createHash('sha256').update(file(staged, 0o700)).digest('hex')) {
				erase(staged, 0o700); erase(pending, 0o600); return 'installed'
			}
			if (current === 'running' || current === 'loaded') throw new Error()
			excludeRuntime()
			if (oldBinary) file(p.binary, 0o700)
			write(unitNext, serviceDefinition(home, platform), 0o600)
			unitNextOwned = true
			if (oldBinary) { renameSync(p.binary, backup); backedUp = true }
			renameSync(staged, p.binary)
			replaced = true
			renameSync(unitNext, p.definition)
			definitionPublished = true
			syncDirectory(p.root); syncDirectory(dirname(p.definition))
			if (platform === 'linux') await command([systemctl, '--user', 'daemon-reload'])
			committed = true
			erase(backup, 0o700)
			erase(pending, 0o600)
			return 'installed'
		} catch {
			// Cleanup failure after durable publication must not delete the new artifact.
			if (committed) throw new Error()
			if (replaced) erase(p.binary, 0o700)
			if (backedUp) renameSync(backup, p.binary)
			if (definitionPublished && !oldDefinition) erase(p.definition, 0o600)
			clearBuild()
			if (stagedOwned) erase(staged, 0o700)
			if (unitNextOwned) erase(unitNext, 0o600)
			if (exists(staged) || exists(unitNext) || exists(backup)) throw new Error()
			if (platform === 'linux' && replaced) await command([systemctl, '--user', 'daemon-reload'])
			erase(pending, 0o600)
			throw new Error()
		}
	} catch { throw new Error(INSTALL_FAILURE.trim()) }
	finally { runtimeLock?.close(); lock?.close() }
}

if (import.meta.main) {
	const action = process.argv[2]
	if (action === 'serve') {
		process.exitCode = await runLocalHarnessEvidenceReceiverCommand(process.argv.slice(3), { retainSignalHandlersUntilExit: true })
	} else if (process.argv.length !== 3 || !['install', 'start', 'status', 'stop', 'remove'].includes(action ?? '')) {
		process.stderr.write('Usage: cukup-experimental-install <install|start|status|stop|remove>\n')
		process.exitCode = 2
	} else {
		try {
			const result = await manageInstallation(action as Action, { home: homedir(), platform: process.platform as Manager })
			process.stdout.write(`${result}\n`)
		} catch { process.stderr.write(INSTALL_FAILURE); process.exitCode = 1 }
	}
}
