import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
	appendFileSync,
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	defaultBackupPullConfigPath,
	loadBackupPullConfig,
	parseRsyncDirectoryListing,
	runBackupPull,
	type BackupPullConfig,
	type BackupPullDependencies,
} from './backup-pull.ts'
import { backupDatabase, verifyBackup } from './operations.ts'
import { ServiceStore } from './store.ts'

const now = Date.parse('2026-10-12T12:00:00.000Z')
const temporaryDirectories: string[] = []

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

function workspace(): string {
	const directory = mkdtempSync(join(tmpdir(), 'cukup-pull-test-'))
	temporaryDirectories.push(directory)
	return directory
}

function sourceDatabase(directory: string): string {
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	const path = join(directory, 'source.sqlite')
	const store = new ServiceStore(path)
	store.close()
	return path
}

function createSnapshot(workspaceDirectory: string, destinationDirectory: string, id: string, createdAtMs: number) {
	return backupDatabase(sourceDatabase(join(workspaceDirectory, 'source')), destinationDirectory, {
		backupId: id,
		nowMs: createdAtMs,
	})
}

function copyPairToDirectory(
	source: { databasePath: string; metadataPath: string },
	destinationRoot: string,
	id: string,
): void {
	const pairDirectory = join(destinationRoot, id)
	mkdirSync(pairDirectory, { recursive: true, mode: 0o700 })
	copyFileSync(source.databasePath, join(pairDirectory, `${id}.sqlite`))
	copyFileSync(source.metadataPath, join(pairDirectory, `${id}.json`))
	chmodSync(pairDirectory, 0o700)
	chmodSync(join(pairDirectory, `${id}.sqlite`), 0o600)
	chmodSync(join(pairDirectory, `${id}.json`), 0o600)
}

function setup(): {
	root: string
	config: BackupPullConfig
	remoteDirectory: string
	localDirectory: string
	dependencies: BackupPullDependencies
	setEntries: (entries: { kind: string; name: string }[]) => void
	setPingFailure: (events: string[]) => void
	sleeps: number[]
	pings: string[]
} {
	const root = workspace()
	const remoteDirectory = join(root, 'remote')
	const localDirectory = join(root, 'local', 'backups')
	mkdirSync(remoteDirectory, { recursive: true, mode: 0o700 })
	const config: BackupPullConfig = {
		remoteHost: 'deploy-user@production-host',
		remoteDirectory: '/srv/example-cukup-backups',
		localDirectory,
		sshBinary: '/usr/bin/ssh',
		rsyncBinary: '/usr/bin/rsync',
	}
	let customEntries: { kind: string; name: string }[] | undefined
	const failedPings = new Set<string>()
	const sleeps: number[] = []
	const pings: string[] = []
	const dependencies: BackupPullDependencies = {
		now: () => now,
		sleep: async (milliseconds) => {
			sleeps.push(milliseconds)
		},
		listRemoteEntries: async () =>
			customEntries ??
			readdirSync(remoteDirectory).map((name) => ({ kind: 'f', name })),
		downloadPair: async (_config, id, destination) => {
			copyFileSync(join(remoteDirectory, `${id}.sqlite`), join(destination, `${id}.sqlite`))
			copyFileSync(join(remoteDirectory, `${id}.json`), join(destination, `${id}.json`))
		},
		attestRemotePair: async (_config, id, metadataDestination, localDatabasePath) => {
			const remoteMetadataPath = join(remoteDirectory, `${id}.json`)
			copyFileSync(remoteMetadataPath, join(metadataDestination, `${id}.json`))
			const remoteDatabase = readFileSync(join(remoteDirectory, `${id}.sqlite`))
			const localDatabase = readFileSync(localDatabasePath)
			return {
				databaseChanged: !createHash('sha256').update(remoteDatabase).digest().equals(
					createHash('sha256').update(localDatabase).digest(),
				),
			}
		},
		ping: async (_url, event) => {
			pings.push(event)
			if (failedPings.has(event)) throw new Error('Private ping URL must not appear in this error')
		},
	}
	return {
		root,
		config,
		remoteDirectory,
		localDirectory,
		dependencies,
		setEntries: (entries) => {
			customEntries = entries
		},
		setPingFailure: (events) => {
			for (const event of events) failedPings.add(event)
		},
		sleeps,
		pings,
	}
}

function addRemoteSnapshot(directory: string, id: string, createdAtMs = now) {
	return createSnapshot(`${directory}-fixture`, directory, id, createdAtMs)
}

test('parses supported rsync listing output and rejects unknown output', () => {
	expect(
		parseRsyncDirectoryListing(
			'drwx------          160 2026/10/12 12:00:00 .\n' +
			'-rw-------         4096 2026/10/12 12:00:00 snapshot.sqlite\n' +
			'-rw-------          256 2026/10/12 12:00:00 snapshot.json\n',
		),
	).toEqual([
		{ kind: 'f', name: 'snapshot.sqlite' },
		{ kind: 'f', name: 'snapshot.json' },
	])
	expect(
		parseRsyncDirectoryListing(
			'-rw-------       65,536 2026/10/12 12:00:00 snapshot.sqlite\n' +
			'-rw-------        1,024 2026/10/12 12:00:00 snapshot.json\n',
		),
	).toEqual([
		{ kind: 'f', name: 'snapshot.sqlite' },
		{ kind: 'f', name: 'snapshot.json' },
	])
	expect(() =>
		parseRsyncDirectoryListing('-rw-------       65,53 2026/10/12 12:00:00 bad.sqlite\n'),
	).toThrow('unknown format')
	expect(() => parseRsyncDirectoryListing('unexpected rsync output\n')).toThrow(
		'unknown format',
	)
})

test('downloads, verifies, and atomically publishes each private backup pair', async () => {
	const context = setup()
	const snapshot = addRemoteSnapshot(context.remoteDirectory, 'fresh')
	expect(snapshot.metadata.backup_id).toBe('fresh')

	const report = await runBackupPull(context.config, context.dependencies)
	const pairDirectory = join(context.localDirectory, 'fresh')
	expect(report).toMatchObject({
		backup: {
			status: 'success',
			downloaded: 1,
			latestBackupId: 'fresh',
			latestCreatedAt: new Date(now).toISOString(),
			pruned: 0,
		},
		monitoring: { status: 'disabled' },
	})
	expect(verifyBackup(join(pairDirectory, 'fresh.sqlite'), join(pairDirectory, 'fresh.json'))).toEqual(
		snapshot.metadata,
	)
	expect(readdirSync(context.localDirectory)).toEqual(['fresh'])
	expect(readdirSync(pairDirectory).sort()).toEqual(['fresh.json', 'fresh.sqlite'])
	expect(readdirSync(context.localDirectory, { withFileTypes: true }).every((entry) => !entry.name.startsWith('.'))).toBe(
		true,
	)
})

test('does not publish or prune when a staged database fails verification', async () => {
	const context = setup()
	const old = addRemoteSnapshot(context.remoteDirectory, 'old', now - 31 * 24 * 60 * 60 * 1000)
	copyPairToDirectory(old, context.localDirectory, 'old')
	const damaged = addRemoteSnapshot(context.remoteDirectory, 'damaged')
	appendFileSync(damaged.databasePath, 'changed after snapshot')

	const report = await runBackupPull(context.config, context.dependencies)

	expect(report.backup.status).toBe('failure')
	expect(report.error).toContain('Backup size mismatch')
	expect(readdirSync(context.localDirectory)).toEqual(['old'])
})

test('retries an incomplete remote pair, then fails without publishing or pruning', async () => {
	const context = setup()
	const old = addRemoteSnapshot(context.remoteDirectory, 'old', now - 31 * 24 * 60 * 60 * 1000)
	copyPairToDirectory(old, context.localDirectory, 'old')
	context.setEntries([{ kind: 'f', name: 'incomplete.sqlite' }])

	const report = await runBackupPull(context.config, context.dependencies)

	expect(report.backup.status).toBe('failure')
	expect(report.error).toContain('Remote backup pair is incomplete')
	expect(context.sleeps).toEqual([5_000, 15_000])
	expect(readdirSync(context.localDirectory)).toEqual(['old'])
})

test('cleans a partially transferred pair after bounded retries', async () => {
	const context = setup()
	const old = addRemoteSnapshot(context.remoteDirectory, 'old', now - 31 * 24 * 60 * 60 * 1000)
	copyPairToDirectory(old, context.localDirectory, 'old')
	addRemoteSnapshot(context.remoteDirectory, 'partial')
	let attempts = 0
	const dependencies: BackupPullDependencies = {
		...context.dependencies,
		downloadPair: async (_config, id, destination) => {
			attempts += 1
			copyFileSync(join(context.remoteDirectory, `${id}.sqlite`), join(destination, `${id}.sqlite`))
			throw new Error('Transfer stopped before the metadata file arrived')
		},
	}

	const report = await runBackupPull(context.config, dependencies)

	expect(report.backup.status).toBe('failure')
	expect(report.error).toContain('after bounded retries')
	expect(attempts).toBe(3)
	expect(context.sleeps).toEqual([5_000, 15_000])
	expect(readdirSync(context.localDirectory)).toEqual(['old'])
})

test('accepts a snapshot exactly 24 hours old and rejects one that is older', async () => {
	const accepted = setup()
	addRemoteSnapshot(accepted.remoteDirectory, 'boundary', now - 24 * 60 * 60 * 1000)
	const acceptedReport = await runBackupPull(accepted.config, accepted.dependencies)
	expect(acceptedReport.backup.status).toBe('success')

	const rejected = setup()
	addRemoteSnapshot(rejected.remoteDirectory, 'stale', now - 24 * 60 * 60 * 1000 - 1)
	const rejectedReport = await runBackupPull(rejected.config, rejected.dependencies)
	expect(rejectedReport.backup.status).toBe('failure')
	expect(rejectedReport.error).toContain('older than 24 hours')
	expect(readdirSync(rejected.localDirectory)).toEqual([])
})

test('rejects a pull when transfer makes the newest snapshot older than 24 hours', async () => {
	const context = setup()
	addRemoteSnapshot(context.remoteDirectory, 'near-boundary', now - 23 * 60 * 60 * 1000 - 55 * 60 * 1000)
	let currentTime = now
	const dependencies: BackupPullDependencies = {
		...context.dependencies,
		now: () => currentTime,
		downloadPair: async (config, id, destination) => {
			await context.dependencies.downloadPair(config, id, destination)
			currentTime = now + 10 * 60 * 1000
		},
	}

	const report = await runBackupPull(context.config, dependencies)

	expect(report.backup.status).toBe('failure')
	expect(report.error).toContain('older than 24 hours')
	expect(readdirSync(context.localDirectory)).toEqual([])
})

test('rejects future and invalid creation times before publication', async () => {
	const future = setup()
	addRemoteSnapshot(future.remoteDirectory, 'future', now + 1)
	const futureReport = await runBackupPull(future.config, future.dependencies)
	expect(futureReport.backup.status).toBe('failure')
	expect(futureReport.error).toContain('in the future')
	expect(readdirSync(future.localDirectory)).toEqual([])

	const invalid = setup()
	const invalidSnapshot = addRemoteSnapshot(invalid.remoteDirectory, 'invalid')
	const metadata = JSON.parse(readFileSync(invalidSnapshot.metadataPath, 'utf8')) as { created_at: string }
	metadata.created_at = 'not-a-date'
	const metadataText = `${JSON.stringify(metadata, null, 2)}\n`
	writeFileSync(invalidSnapshot.metadataPath, metadataText, { mode: 0o600 })
	const invalidReport = await runBackupPull(invalid.config, invalid.dependencies)
	expect(invalidReport.backup.status).toBe('failure')
	expect(invalidReport.error).toContain('Backup creation time is invalid')
	expect(readdirSync(invalid.localDirectory)).toEqual([])
})

test('accepts a snapshot published during the pull once its creation time is no longer in the future', async () => {
	const context = setup()
	addRemoteSnapshot(context.remoteDirectory, 'published-during-pull', now + 500)
	let clockReads = 0
	const dependencies: BackupPullDependencies = {
		...context.dependencies,
		now: () => {
			clockReads += 1
			return clockReads === 1 ? now : now + 1_000
		},
	}

	const report = await runBackupPull(context.config, dependencies)

	expect(report.backup.status).toBe('success')
	expect(report.backup.latestBackupId).toBe('published-during-pull')
	expect(readdirSync(context.localDirectory)).toEqual(['published-during-pull'])
})

test('prunes only backups older than 30 days and preserves the newest pair', async () => {
	const context = setup()
	const old = addRemoteSnapshot(context.remoteDirectory, 'older', now - 30 * 24 * 60 * 60 * 1000 - 1)
	const boundary = addRemoteSnapshot(context.remoteDirectory, 'boundary', now - 30 * 24 * 60 * 60 * 1000)
	copyPairToDirectory(old, context.localDirectory, 'older')
	copyPairToDirectory(boundary, context.localDirectory, 'boundary')
	addRemoteSnapshot(context.remoteDirectory, 'fresh')

	const report = await runBackupPull(context.config, context.dependencies)

	expect(report.backup).toMatchObject({ status: 'success', latestBackupId: 'fresh', pruned: 1 })
	expect(readdirSync(context.localDirectory).sort()).toEqual(['boundary', 'fresh'])
})

test('keeps the newest verified pair and does not prune after a stale freshness failure', async () => {
	const context = setup()
	const old = addRemoteSnapshot(context.remoteDirectory, 'old', now - 31 * 24 * 60 * 60 * 1000)
	copyPairToDirectory(old, context.localDirectory, 'old')

	const report = await runBackupPull(context.config, context.dependencies)

	expect(report.backup.status).toBe('failure')
	expect(report.error).toContain('older than 24 hours')
	expect(readdirSync(context.localDirectory)).toEqual(['old'])
})

test('fails on an immutable backup ID conflict and leaves the verified local copy unchanged', async () => {
	const context = setup()
	const localSnapshot = createSnapshot(
		join(context.root, 'local-source'),
		join(context.root, 'local-source'),
		'reused',
		now,
	)
	const remoteSnapshot = createSnapshot(
		join(context.root, 'remote-source'),
		join(context.root, 'remote-source'),
		'reused',
		now - 1_000,
	)
	copyPairToDirectory(localSnapshot, context.localDirectory, 'reused')
	copyFileSync(remoteSnapshot.databasePath, join(context.remoteDirectory, 'reused.sqlite'))
	copyFileSync(remoteSnapshot.metadataPath, join(context.remoteDirectory, 'reused.json'))
	const localMetadata = readFileSync(join(context.localDirectory, 'reused', 'reused.json'), 'utf8')

	const report = await runBackupPull(context.config, context.dependencies)

	expect(report.backup.status).toBe('failure')
	expect(report.error).toContain('conflicts with the verified local pair')
	expect(readFileSync(join(context.localDirectory, 'reused', 'reused.json'), 'utf8')).toBe(localMetadata)
})

test('detects remote database drift when a published ID keeps its old metadata', async () => {
	const context = setup()
	const localSnapshot = createSnapshot(
		join(context.root, 'same-source'),
		join(context.root, 'same-source'),
		'reused',
		now,
	)
	copyPairToDirectory(localSnapshot, context.localDirectory, 'reused')
	copyFileSync(localSnapshot.databasePath, join(context.remoteDirectory, 'reused.sqlite'))
	copyFileSync(localSnapshot.metadataPath, join(context.remoteDirectory, 'reused.json'))
	appendFileSync(join(context.remoteDirectory, 'reused.sqlite'), 'changed without metadata update')

	const report = await runBackupPull(context.config, context.dependencies)

	expect(report.backup.status).toBe('failure')
	expect(report.error).toContain('conflicts with the verified local pair')
	expect(verifyBackup(join(context.localDirectory, 'reused', 'reused.sqlite'))).toEqual(
		localSnapshot.metadata,
	)
})

test('fails closed on remote symlinks, directories, unsafe names, and empty listings', async () => {
	for (const entries of [
		[{ kind: 'l', name: 'backup.sqlite' }],
		[{ kind: 'd', name: 'unexpected' }],
		[{ kind: 'f', name: '../escape.json' }],
		[],
	]) {
		const context = setup()
		context.setEntries(entries)
		const report = await runBackupPull(context.config, context.dependencies)
		expect(report.backup.status).toBe('failure')
		expect(readdirSync(context.localDirectory)).toEqual([])
	}
})

test('rejects lock contention without removing another run\'s lock', async () => {
	const context = setup()
	mkdirSync(join(context.localDirectory, '.pull.lock'), { mode: 0o700, recursive: true })
	let listed = false
	const dependencies = {
		...context.dependencies,
		listRemoteEntries: async () => {
			listed = true
			return []
		},
	}

	const report = await runBackupPull(context.config, dependencies)

	expect(report.backup.status).toBe('failure')
	expect(report.error).toContain('lock needs review')
	expect(listed).toBe(false)
	expect(readdirSync(context.localDirectory)).toEqual(['.pull.lock'])
})

test('runs backups without a Healthchecks URL and records a monitoring ping failure separately', async () => {
	const unmonitored = setup()
	addRemoteSnapshot(unmonitored.remoteDirectory, 'unmonitored')
	const unmonitoredReport = await runBackupPull(unmonitored.config, unmonitored.dependencies)
	expect(unmonitoredReport).toMatchObject({
		backup: { status: 'success' },
		monitoring: { status: 'disabled', startPing: 'disabled', completionPing: 'disabled' },
	})
	expect(unmonitored.pings).toEqual([])

	const monitored = setup()
	monitored.config.healthchecksPingUrl = 'https://hc-ping.com/host-secret-token'
	addRemoteSnapshot(monitored.remoteDirectory, 'monitored')
	monitored.setPingFailure(['start'])
	const monitoredReport = await runBackupPull(monitored.config, monitored.dependencies)
	expect(monitoredReport.backup.status).toBe('success')
	expect(monitoredReport.monitoring).toMatchObject({
		status: 'failure',
		startPing: 'failure',
		completionPing: 'success',
	})
	expect(monitored.pings).toEqual(['start', 'success'])
	expect(JSON.stringify(monitoredReport)).not.toContain('host-secret-token')
})

test('sends a failure ping after backup failure and keeps monitoring errors out of the report', async () => {
	const context = setup()
	context.config.healthchecksPingUrl = 'https://hc-ping.com/host-secret-token'
	context.setEntries([{ kind: 'f', name: 'orphan.sqlite' }])
	context.setPingFailure(['failure'])

	const report = await runBackupPull(context.config, context.dependencies)

	expect(report.backup.status).toBe('failure')
	expect(report.monitoring).toMatchObject({ status: 'failure', completionPing: 'failure' })
	expect(context.pings).toEqual(['start', 'failure'])
	expect(JSON.stringify(report)).not.toContain('host-secret-token')
	expect(JSON.stringify(report)).not.toContain('Private ping URL')
})

test('loads only a private config file and uses a per-user default path', () => {
	const directory = workspace()
	const home = join(directory, 'home')
	const configPath = defaultBackupPullConfigPath(home)
	mkdirSync(join(home, '.config', 'cukup'), { recursive: true, mode: 0o700 })
	writeFileSync(
		configPath,
		JSON.stringify({
			remoteHost: 'production-host',
			remoteDirectory: '/srv/example-cukup-backups',
			localDirectory: join(home, '.local', 'state', 'cukup-backups', 'backups'),
			sshBinary: '/usr/bin/ssh',
			rsyncBinary: '/usr/bin/rsync',
			healthchecksPingUrl: 'https://hc-ping.com/private-token',
		}),
		{ mode: 0o600 },
	)
	chmodSync(configPath, 0o600)
	expect(loadBackupPullConfig(configPath).remoteHost).toBe('production-host')
	chmodSync(configPath, 0o644)
	expect(() => loadBackupPullConfig(configPath)).toThrow('must not allow group or other access')
})
