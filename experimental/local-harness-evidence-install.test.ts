import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INSTALL_FAILURE, installationPaths, manageInstallation, serviceDefinition, type InstallOptions, type Manager } from './local-harness-evidence-install.ts'
import { discoverLocalHarnessEvidenceEndpoint, startLocalHarnessEvidenceRuntime } from './local-harness-evidence-runtime.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(platform: Manager = 'linux') {
	const home = realpathSync(mkdtempSync(join(tmpdir(), 'cukup-install-')))
	roots.push(home)
	const paths = installationPaths(home, platform)
	let active = false
	let loaded = false
	let version = 'version-one'
	let fail: string | undefined
	const calls: string[][] = []
	const options: InstallOptions = {
		home, platform,
		build: async (destination) => { writeFileSync(destination, version, { mode: 0o755 }) },
		run: async (argv) => {
			calls.push(argv)
			if (fail && argv.includes(fail)) return { code: 1, stdout: 'private manager diagnostic' }
			if (platform === 'linux') {
				if (argv.includes('show')) return { code: 0, stdout: existsSync(paths.definition)
					? `LoadState=loaded\nActiveState=${active ? 'active' : 'inactive'}\nFragmentPath=${paths.definition}\nDropInPaths=\n`
					: 'LoadState=not-found\nActiveState=inactive\nFragmentPath=\nDropInPaths=\n' }
				if (argv.includes('start')) active = true
				if (argv.includes('stop')) active = false
			} else {
				if (argv[1] === 'print' && argv[2]!.includes('/org.')) return { code: loaded ? 0 : 113, stdout: `${argv[2]} = {\n\tpath = ${paths.definition}\n}\n` }
				if (argv[1] === 'bootstrap') loaded = true
				if (argv[1] === 'bootout') { loaded = false; active = false }
				if (argv[1] === 'kickstart') active = true
			}
			return { code: 0, stdout: '' }
		},
	}
	return { options, paths, calls, setVersion: (v: string) => { version = v }, fail: (v?: string) => { fail = v } }
}

async function fails(action: Parameters<typeof manageInstallation>[0], options: InstallOptions) {
	await expect(manageInstallation(action, options)).rejects.toThrow(INSTALL_FAILURE.trim())
}

describe('user service installation boundary', () => {
	for (const platform of ['linux', 'darwin'] as const) {
		test(`${platform}: install/start/idempotent reinstall/stop/replace/remove retains durable state`, async () => {
			const f = fixture(platform)
			expect(await manageInstallation('install', f.options)).toBe('installed')
			expect(f.calls.some((c) => c.includes('start') || c.includes('bootstrap') || c.includes('enable'))).toBeFalse()
			expect(statSync(f.paths.binary).mode & 0o777).toBe(0o700)
			expect(statSync(f.paths.definition).mode & 0o777).toBe(0o600)
			const runtime = startLocalHarnessEvidenceRuntime({ stateDirectory: f.paths.state })
			await runtime.stop()
			const token = readFileSync(join(f.paths.state, 'receiver-token'))
			const database = readFileSync(join(f.paths.state, 'receiver.sqlite'))
			expect(await manageInstallation('start', f.options)).toBe(platform === 'linux' ? 'running' : 'loaded')
			expect(await manageInstallation('install', f.options)).toBe('installed')
			f.setVersion('version-two')
			await fails('install', f.options)
			expect(readFileSync(f.paths.binary, 'utf8')).toBe('version-one')
			expect(await manageInstallation('stop', f.options)).toBe('stopped')
			expect(await manageInstallation('stop', f.options)).toBe('stopped')
			expect(await manageInstallation('install', f.options)).toBe('installed')
			expect(readFileSync(f.paths.binary, 'utf8')).toBe('version-two')
			expect(await manageInstallation('remove', f.options)).toBe('removed')
			expect(await manageInstallation('remove', f.options)).toBe('removed')
			expect(existsSync(f.paths.binary)).toBeFalse()
			expect(existsSync(f.paths.definition)).toBeFalse()
			expect(readFileSync(join(f.paths.state, 'receiver-token'))).toEqual(token)
			expect(readFileSync(join(f.paths.state, 'receiver.sqlite'))).toEqual(database)
			expect(await manageInstallation('install', f.options)).toBe('installed')
			if (platform === 'darwin') {
				const domain = `gui/${process.getuid!()}`
				expect(f.calls).toContainEqual(['/bin/launchctl', 'bootstrap', domain, f.paths.definition])
				expect(f.calls).toContainEqual(['/bin/launchctl', 'kickstart', `${domain}/org.cukup.experimental-receiver`])
				expect(f.calls).toContainEqual(['/bin/launchctl', 'bootout', `${domain}/org.cukup.experimental-receiver`])
			}
		})
	}

	test('failed replacement restores old artifact; uncertain manager rollback requires explicit remove', async () => {
		const f = fixture()
		await manageInstallation('install', f.options)
		f.setVersion('version-two')
		f.fail('daemon-reload')
		await fails('install', f.options)
		expect(readFileSync(f.paths.binary, 'utf8')).toBe('version-one')
		expect(existsSync(join(f.paths.root, 'pending'))).toBeTrue()
		f.fail()
		await fails('start', f.options)
		expect(await manageInstallation('remove', f.options)).toBe('removed')
		expect(await manageInstallation('install', f.options)).toBe('installed')
	})

	test('first-install reload failure rolls back publication and does not manufacture success', async () => {
		const f = fixture()
		f.fail('daemon-reload')
		await fails('install', f.options)
		expect(existsSync(f.paths.binary)).toBeFalse()
		expect(existsSync(f.paths.definition)).toBeFalse()
		f.fail()
		await manageInstallation('remove', f.options)
		expect(await manageInstallation('install', f.options)).toBe('installed')
	})

	test('compiler failure and concurrent installers do not publish partial artifacts', async () => {
		const f = fixture()
		const build = f.options.build!
		f.options.build = async (destination) => {
			await fails('install', { ...f.options, build })
			writeFileSync(destination, 'partial build', { mode: 0o644 })
			throw new Error('private compiler error')
		}
		await fails('install', f.options)
		expect(existsSync(f.paths.binary)).toBeFalse()
		expect(existsSync(f.paths.definition)).toBeFalse()
		f.options.build = build
		expect(await manageInstallation('install', f.options)).toBe('installed')
	})

	test('pending/crash marker prevents start/reinstall but permits stopping and state-preserving removal', async () => {
		const f = fixture()
		await manageInstallation('install', f.options)
		writeFileSync(join(f.paths.root, 'pending'), 'pending\n', { mode: 0o600 })
		writeFileSync(join(f.paths.root, 'receiver.next'), 'partial', { mode: 0o700 })
		await fails('install', f.options)
		await fails('start', f.options)
		expect(await manageInstallation('stop', f.options)).toBe('stopped')
		expect(await manageInstallation('remove', f.options)).toBe('removed')
	})

	test('manager absence/failure never means stopped and never permits destructive cleanup', async () => {
		for (const platform of ['linux', 'darwin'] as const) {
			const f = fixture(platform)
			await manageInstallation('install', f.options)
			f.fail(platform === 'linux' ? 'show-environment' : 'print')
			for (const action of ['status', 'start', 'stop', 'remove', 'install'] as const) await fails(action, f.options)
			expect(readFileSync(f.paths.binary, 'utf8')).toBe('version-one')
		}
	})

	test('stop failure retains installation; start failure retains recoverable installation', async () => {
		const f = fixture()
		await manageInstallation('install', f.options)
		f.fail('start'); await fails('start', f.options)
		f.fail(); await manageInstallation('start', f.options)
		f.fail('stop'); await fails('remove', f.options)
		expect(existsSync(f.paths.binary)).toBeTrue()
		expect(existsSync(f.paths.definition)).toBeTrue()
	})

	test('unmanaged live receiver prevents replacement and removal', async () => {
		const f = fixture()
		await manageInstallation('install', f.options)
		const runtime = startLocalHarnessEvidenceRuntime({ stateDirectory: f.paths.state })
		try {
			f.setVersion('replacement')
			await fails('install', f.options)
			await fails('remove', f.options)
			expect(readFileSync(f.paths.binary, 'utf8')).toBe('version-one')
		} finally { await runtime.stop() }
	})

	test('unsafe modes, links, noncanonical paths, and foreign definitions fail without leaking values', async () => {
		for (const path of ['relative', '/', '/tmp/../private', '/tmp/private\npath', '/tmp/private\0path', ' /tmp/private']) {
			await fails('install', { ...fixture().options, home: path })
		}
		for (const attack of ['symlink', 'hardlink', 'mode', 'parent', 'definition', 'root'] as const) {
			const f = fixture()
			await manageInstallation('install', f.options)
			if (attack === 'symlink') { rmSync(f.paths.binary); symlinkSync('/dev/null', f.paths.binary) }
			if (attack === 'hardlink') linkSync(f.paths.binary, join(f.paths.root, 'alias'))
			if (attack === 'mode') chmodSync(f.paths.binary, 0o755)
			if (attack === 'parent') chmodSync(join(f.options.home, '.config'), 0o777)
			if (attack === 'root') chmodSync(f.paths.root, 0o755)
			if (attack === 'definition') writeFileSync(f.paths.definition, 'private foreign definition')
			await fails('install', f.options)
			await fails('remove', f.options)
		}
	})

	test('substitution during build refuses publication and preserves link target', async () => {
		const f = fixture()
		await manageInstallation('install', f.options)
		const outside = join(f.options.home, 'outside')
		writeFileSync(outside, 'untouched', { mode: 0o700 })
		f.options.build = async (destination) => {
			writeFileSync(destination, 'new', { mode: 0o755 })
			rmSync(f.paths.binary)
			symlinkSync(outside, f.paths.binary)
		}
		await fails('install', f.options)
		expect(readFileSync(outside, 'utf8')).toBe('untouched')
	})

	test('identical builds still revalidate service definition and manager availability', async () => {
		for (const change of ['definition', 'manager']) {
			const f = fixture()
			await manageInstallation('install', f.options)
			const build = f.options.build!
			f.options.build = async (destination) => {
				await build(destination)
				if (change === 'definition') writeFileSync(f.paths.definition, 'foreign')
				else f.fail('show-environment')
			}
			await fails('install', f.options)
			expect(readFileSync(f.paths.binary, 'utf8')).toBe('version-one')
		}
	})

	test('first-install success and failure paths preserve files that appeared during compilation', async () => {
		for (const failBuild of [false, true]) {
			for (const target of ['definition', 'binary', 'backup', 'unitNext', 'staged'] as const) {
				const f = fixture()
				const foreignPath = target === 'definition' ? f.paths.definition
					: target === 'binary' ? f.paths.binary
					: target === 'backup' ? join(f.paths.root, 'receiver.previous')
					: target === 'unitNext' ? `${f.paths.definition}.next` : join(f.paths.root, 'receiver.next')
				f.options.build = async (destination) => {
					writeFileSync(foreignPath, 'foreign owner file', { mode: target === 'definition' || target === 'unitNext' ? 0o600 : 0o700 })
					if (failBuild) throw new Error('failed build')
					writeFileSync(destination, 'new build', { mode: 0o755 })
				}
				await fails('install', f.options)
				expect(readFileSync(foreignPath, 'utf8')).toBe('foreign owner file')
				if (target !== 'binary') expect(existsSync(f.paths.binary)).toBeFalse()
				if (target !== 'definition') expect(existsSync(f.paths.definition)).toBeFalse()
			}
		}
	})

	test('effective systemd drop-ins and foreign/unknown LaunchAgent origins refuse all service control', async () => {
		for (const platform of ['linux', 'darwin'] as const) {
			for (const foreign of ['foreign', 'unknown']) {
				const f = fixture(platform)
				await manageInstallation('install', f.options)
				const run = f.options.run!
				f.options.run = async (argv) => {
					const result = await run(argv)
					if (platform === 'linux' && argv.includes('show')) return { code: 0, stdout: result.stdout.replace('DropInPaths=', 'DropInPaths=/foreign/override.conf') }
					if (platform === 'darwin' && argv[1] === 'print' && argv[2]!.includes('/org.')) return { code: 0, stdout: foreign === 'foreign' ? '\tpath = /foreign/job.plist\n' : 'unrecognized print format' }
					return result
				}
				f.calls.length = 0
				for (const action of ['start', 'stop', 'remove'] as const) await fails(action, f.options)
				expect(f.calls.some((c) => c.some((a) => ['start', 'stop', 'kickstart', 'bootout', 'bootstrap'].includes(a)))).toBeFalse()
			}
		}
	})

	test('drop-in appearing on reload prevents start', async () => {
		const f = fixture()
		await manageInstallation('install', f.options)
		let reloaded = false
		const run = f.options.run!
		f.options.run = async (argv) => {
			const result = await run(argv)
			if (argv.includes('daemon-reload')) reloaded = true
			if (reloaded && argv.includes('show')) result.stdout = result.stdout.replace('DropInPaths=', 'DropInPaths=/foreign/override.conf')
			return result
		}
		f.calls.length = 0
		await fails('start', f.options)
		expect(f.calls.some((c) => c.includes('start'))).toBeFalse()
	})

	test('interrupted first start permits stop, replacement, and removal without deleting state', async () => {
		const f = fixture()
		await manageInstallation('install', f.options)
		mkdirSync(f.paths.state, { mode: 0o700 })
		writeFileSync(join(f.paths.state, 'retained'), 'retained state', { mode: 0o600 })
		expect(await manageInstallation('stop', f.options)).toBe('stopped')
		expect(statSync(join(f.paths.state, 'runtime-ownership.sqlite')).mode & 0o777).toBe(0o600)
		f.setVersion('replacement')
		expect(await manageInstallation('install', f.options)).toBe('installed')
		expect(await manageInstallation('remove', f.options)).toBe('removed')
		expect(readFileSync(join(f.paths.state, 'retained'), 'utf8')).toBe('retained state')
	})

	test('FIFO managed paths fail promptly with only the fixed diagnostic', async () => {
		for (const name of ['receiver', 'install-lock.sqlite']) {
			const f = fixture()
			mkdirSync(f.paths.root, { mode: 0o700 })
			expect(Bun.spawnSync(['mkfifo', '-m', '600', join(f.paths.root, name)]).exitCode).toBe(0)
			const child = Bun.spawn([process.execPath, join(import.meta.dir, 'local-harness-evidence-install.ts'), 'status'], {
				env: { ...process.env, HOME: f.options.home }, stdout: 'pipe', stderr: 'pipe', timeout: 2_000,
			})
			expect(await child.exited).toBe(1)
			expect(await new Response(child.stderr).text()).toBe(INSTALL_FAILURE)
			expect(await new Response(child.stdout).text()).toBe('')
		}
	})

	test('generation escapes shell/XML/systemd metacharacters without adding activation or credentials', () => {
		const home = '/home/a b"c\\d%h${HOME}&<>'
		expect(() => serviceDefinition(home, 'linux')).toThrow()
		const unit = serviceDefinition('/home/a b%h${HOME}&<>', 'linux')
		expect(unit).toContain('ExecStart=:"/home/a b%%h${HOME}&<>/.cukup-experimental-receiver/receiver" serve')
		expect(unit).not.toContain('[Install]')
		const plist = serviceDefinition(home, 'darwin')
		expect(plist).toContain('a b&quot;c\\d%h${HOME}&amp;&lt;&gt;')
		expect(plist).toContain('<key>RunAtLoad</key><false/>')
		expect(plist).toContain('<key>KeepAlive</key><false/>')
		for (const text of [unit, plist]) expect(text).not.toContain('receiver-token')
	})

	test.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/systemd-analyze'))('native systemd parser accepts generated literal metacharacter paths', () => {
		const f = fixture()
		const home = join(f.options.home, 'a b%h${HOME}&<>日本語')
		const p = installationPaths(home, 'linux')
		mkdirSync(p.root, { recursive: true, mode: 0o700 })
		writeFileSync(p.binary, 'placeholder', { mode: 0o700 })
		const definition = join(f.options.home, 'test.service')
		writeFileSync(definition, serviceDefinition(home, 'linux'), { mode: 0o600 })
		const hasUserManager = existsSync('/usr/bin/systemctl') && Bun.spawnSync(['/usr/bin/systemctl', '--user', 'show-environment'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
		const mode = hasUserManager ? ['--user', 'verify'] : ['verify']
		const result = Bun.spawnSync(['/usr/bin/systemd-analyze', ...mode, definition], { stdout: 'pipe', stderr: 'pipe' })
		expect(result.exitCode).toBe(0)
		expect(result.stderr.length).toBe(0)
	})

	test('standalone artifact runs and retains identity outside checkout and without Bun on PATH', async () => {
		const f = fixture()
		delete f.options.build
		expect(await manageInstallation('install', f.options)).toBe('installed')
		expect(await manageInstallation('install', f.options)).toBe('installed')
		const run = () => Bun.spawn([f.paths.binary, 'serve', '--state-directory', f.paths.state], {
			cwd: f.options.home, env: { HOME: f.options.home, PATH: '/nonexistent' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
		})
		let identity: string | undefined
		for (let i = 0; i < 2; i++) {
			const process = run()
			try {
				const deadline = Date.now() + 5_000
				while (true) {
					try { await discoverLocalHarnessEvidenceEndpoint(f.paths.state); break } catch {
						if (Date.now() >= deadline) throw new Error('readiness timeout')
						await Bun.sleep(20)
					}
				}
				const value = readFileSync(join(f.paths.state, 'execution-site-id'), 'utf8')
				if (identity) expect(value).toEqual(identity)
				identity = value
				process.kill('SIGTERM')
				expect(await process.exited).toBe(0)
				expect(await new Response(process.stderr).text()).toBe('')
				expect(await new Response(process.stdout).text()).toBe('')
				expect(existsSync(join(f.paths.state, 'endpoint.json'))).toBeFalse()
			} finally { if (process.exitCode === null) { process.kill('SIGKILL'); await process.exited } }
		}
	}, 120_000)
})
