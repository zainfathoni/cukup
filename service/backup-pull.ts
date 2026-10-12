import { verifyBackup, type BackupMetadata } from './operations.ts'
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_AGE_MS = DAY_MS
const RETENTION_MS = 30 * DAY_MS
const MAX_LIST_ATTEMPTS = 3
const MAX_TRANSFER_ATTEMPTS = 3
const RETRY_DELAYS_MS = [5_000, 15_000]
const PAIR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TEMPORARY_PAIR_FILE =
	/^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.(?:sqlite|json)\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type BackupPullConfig = {
	remoteHost: string
	remoteDirectory: string
	localDirectory: string
	sshBinary: string
	rsyncBinary: string
	healthchecksPingUrl?: string
}

export type RemoteEntry = { kind: string; name: string }

export type BackupPullReport = {
	backup: {
		status: 'success' | 'failure'
		downloaded: number
		latestBackupId?: string
		latestCreatedAt?: string
		pruned: number
	}
	monitoring: {
		status: 'disabled' | 'success' | 'failure'
		startPing: 'disabled' | 'success' | 'failure'
		completionPing: 'disabled' | 'success' | 'failure'
	}
	error?: string
}

export type BackupPullDependencies = {
	now: () => number
	sleep: (milliseconds: number) => Promise<void>
	listRemoteEntries: (config: BackupPullConfig) => Promise<RemoteEntry[]>
	downloadPair: (config: BackupPullConfig, id: string, destination: string) => Promise<void>
	attestRemotePair: (
		config: BackupPullConfig,
		id: string,
		metadataDestination: string,
		localDatabasePath: string,
	) => Promise<{ databaseChanged: boolean }>
	ping: (url: string, event: 'start' | 'success' | 'failure') => Promise<void>
}

type VerifiedSnapshot = {
	id: string
	directory: string
	metadata: BackupMetadata
	metadataText: string
	createdAtMs: number
}

type ExecutionResult = {
	downloaded: number
	latest: VerifiedSnapshot
	pruned: number
}

type InterruptionState = {
	signal?: 'SIGINT' | 'SIGTERM'
	children: Set<Bun.Subprocess>
}

let activeInterruption: InterruptionState | undefined

export function defaultBackupPullConfigPath(homeDirectory = homedir()): string {
	return join(homeDirectory, '.config', 'cukup', 'backup-pull.json')
}

export function loadBackupPullConfig(configPath = defaultBackupPullConfigPath()): BackupPullConfig {
	const info = lstatSync(configPath)
	if (!info.isFile() || info.isSymbolicLink()) throw new Error('Backup pull config must be a regular file')
	if ((info.mode & 0o077) !== 0) throw new Error('Backup pull config must not allow group or other access')
	if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
		throw new Error('Backup pull config must belong to the current user')
	}

	const value: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Backup pull config must contain a JSON object')
	}
	const record = value as Record<string, unknown>
	const allowedKeys = new Set([
		'remoteHost',
		'remoteDirectory',
		'localDirectory',
		'sshBinary',
		'rsyncBinary',
		'healthchecksPingUrl',
	])
	for (const key of Object.keys(record)) {
		if (!allowedKeys.has(key)) throw new Error(`Unknown backup pull config field: ${key}`)
	}

	const config: BackupPullConfig = {
		remoteHost: requiredString(record, 'remoteHost'),
		remoteDirectory: requiredString(record, 'remoteDirectory'),
		localDirectory: requiredString(record, 'localDirectory'),
		sshBinary: requiredString(record, 'sshBinary'),
		rsyncBinary: requiredString(record, 'rsyncBinary'),
	}
	if (record.healthchecksPingUrl !== undefined) {
		if (typeof record.healthchecksPingUrl !== 'string') {
			throw new Error('healthchecksPingUrl must be a string when set')
		}
		config.healthchecksPingUrl = record.healthchecksPingUrl
	}
	validateBackupPullConfig(config)
	return config
}

export async function runBackupPull(
	config: BackupPullConfig,
	dependencies: BackupPullDependencies = createBackupPullDependencies(),
): Promise<BackupPullReport> {
	validateBackupPullConfig(config)
	const report: BackupPullReport = {
		backup: { status: 'failure', downloaded: 0, pruned: 0 },
		monitoring: {
			status: config.healthchecksPingUrl ? 'failure' : 'disabled',
			startPing: config.healthchecksPingUrl ? 'failure' : 'disabled',
			completionPing: config.healthchecksPingUrl ? 'failure' : 'disabled',
		},
	}
	let monitoringFailed = false

	if (config.healthchecksPingUrl) {
		try {
			await dependencies.ping(config.healthchecksPingUrl, 'start')
			report.monitoring.startPing = 'success'
		} catch {
			monitoringFailed = true
		}
	}

	let execution: ExecutionResult | undefined
	try {
		execution = await executeBackupPull(config, dependencies)
		report.backup = {
			status: 'success',
			downloaded: execution.downloaded,
			latestBackupId: execution.latest.id,
			latestCreatedAt: execution.latest.metadata.created_at,
			pruned: execution.pruned,
		}
	} catch (error) {
		report.error = errorMessage(error)
	}

	if (config.healthchecksPingUrl) {
		try {
			await dependencies.ping(
				config.healthchecksPingUrl,
				execution ? 'success' : 'failure',
			)
			report.monitoring.completionPing = 'success'
		} catch {
			monitoringFailed = true
		}
		report.monitoring.status = monitoringFailed ? 'failure' : 'success'
	}

	return report
}

export function createBackupPullDependencies(): BackupPullDependencies {
	return {
		now: Date.now,
		sleep: (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
		listRemoteEntries,
		downloadPair,
		attestRemotePair,
		ping: pingHealthchecks,
	}
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key]
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`${key} must be a non-empty string`)
	}
	return value
}

function validateBackupPullConfig(config: BackupPullConfig): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,254}$/.test(config.remoteHost)) {
		throw new Error('remoteHost must be an SSH alias or user@host without shell syntax')
	}
	if (
		!config.remoteDirectory.startsWith('/') ||
		!/^\/[A-Za-z0-9_./-]+$/.test(config.remoteDirectory) ||
		config.remoteDirectory === '/' ||
		config.remoteDirectory.split('/').includes('..')
	) {
		throw new Error('remoteDirectory must be an absolute path without shell syntax or parent segments')
	}
	if (!isAbsolute(config.localDirectory) || resolve(config.localDirectory) === '/') {
		throw new Error('localDirectory must be an absolute non-root path')
	}
	validateAbsoluteExecutable(config.sshBinary, 'sshBinary')
	validateAbsoluteExecutable(config.rsyncBinary, 'rsyncBinary')
	if (config.healthchecksPingUrl !== undefined) validateHealthchecksUrl(config.healthchecksPingUrl)
}

function validateAbsoluteExecutable(path: string, name: string): void {
	if (!isAbsolute(path) || !/^\/[A-Za-z0-9_./-]+$/.test(path) || path.split('/').includes('..')) {
		throw new Error(`${name} must be an absolute executable path without shell syntax`)
	}
}

function validateHealthchecksUrl(value: string): void {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error('healthchecksPingUrl must be a valid HTTPS ping URL')
	}
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname === '/' ||
		url.pathname.split('/').some((segment) => segment === '.' || segment === '..')
	) {
		throw new Error('healthchecksPingUrl must be a private HTTPS ping URL without query or fragment')
	}
}

async function executeBackupPull(
	config: BackupPullConfig,
	dependencies: BackupPullDependencies,
): Promise<ExecutionResult> {
	const nowMs = dependencies.now()
	if (!Number.isFinite(nowMs)) throw new Error('Local clock returned an invalid time')
	secureMkdir(config.localDirectory)
	const lockDirectory = join(config.localDirectory, '.pull.lock')
	try {
		mkdirSync(lockDirectory, { mode: 0o700 })
	} catch (error) {
		if (hasErrorCode(error, 'EEXIST')) throw new Error('Another backup pull is active or a stale lock needs review')
		throw error
	}
	const removeInterruptionHandlers = installInterruptionHandlers()
	let stagingDirectory: string | undefined

	try {
		chmodSync(lockDirectory, 0o700)
		writeFileSync(join(lockDirectory, 'owner'), `${process.pid}\n${new Date(nowMs).toISOString()}\n`, {
			mode: 0o600,
		})
		removeStaleStagingDirectories(config.localDirectory)
		const existing = loadLocalSnapshots(config.localDirectory, nowMs)
		const remoteIds = await discoverRemotePairs(config, dependencies)
		stagingDirectory = mkdtempSync(join(config.localDirectory, '.pull-staging-'))
		chmodSync(stagingDirectory, 0o700)
		const staged: VerifiedSnapshot[] = []

		for (const id of remoteIds) {
			throwIfInterrupted()
			const existingSnapshot = existing.get(id)
			if (existingSnapshot) {
				const metadataDirectory = join(stagingDirectory, `.metadata-${id}`)
				mkdirSync(metadataDirectory, { mode: 0o700 })
				const attestation = await dependencies.attestRemotePair(
					config,
					id,
					metadataDirectory,
					join(existingSnapshot.directory, `${id}.sqlite`),
				)
				const metadataPath = join(metadataDirectory, `${id}.json`)
				const metadataInfo = lstatSync(metadataPath)
				if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) {
					throw new Error(`Remote metadata for backup ${id} is not a regular file`)
				}
				chmodSync(metadataPath, 0o600)
				const metadataText = readFileSync(metadataPath, 'utf8')
				assertRemotePairMatches(id, existingSnapshot, metadataText, attestation.databaseChanged)
				continue
			}

			const pairDirectory = join(stagingDirectory, id)
			mkdirSync(pairDirectory, { mode: 0o700 })
			await downloadPairWithRetries(config, id, pairDirectory, dependencies)
			chmodSync(pairDirectory, 0o700)
			securePairFiles(pairDirectory, id)
			const verificationNowMs = dependencies.now()
			if (!Number.isFinite(verificationNowMs)) throw new Error('Local clock returned an invalid time')
			const snapshot = verifySnapshot(pairDirectory, id, verificationNowMs)
			staged.push(snapshot)
		}

		const snapshots = [...existing.values(), ...staged]
		if (snapshots.length === 0) throw new Error('No complete backup pairs are available')
		const latest = newestSnapshot(snapshots)
		const publicationNowMs = dependencies.now()
		if (!Number.isFinite(publicationNowMs)) throw new Error('Local clock returned an invalid time')
		assertSnapshotFresh(latest, publicationNowMs)

		for (const snapshot of staged) {
			const finalDirectory = join(config.localDirectory, snapshot.id)
			if (existsSync(finalDirectory)) {
				throw new Error(`Backup ID appeared during publication: ${snapshot.id}`)
			}
			renameSync(snapshot.directory, finalDirectory)
			snapshot.directory = finalDirectory
		}

		const retentionNowMs = dependencies.now()
		if (!Number.isFinite(retentionNowMs)) throw new Error('Local clock returned an invalid time')
		assertSnapshotFresh(latest, retentionNowMs)
		const retentionCutoff = retentionNowMs - RETENTION_MS
		let pruned = 0
		for (const snapshot of snapshots) {
			if (snapshot.id === latest.id || snapshot.createdAtMs >= retentionCutoff) continue
			rmSync(snapshot.directory, { recursive: true })
			pruned += 1
		}

		return { downloaded: staged.length, latest, pruned }
	} finally {
		if (stagingDirectory && existsSync(stagingDirectory)) {
			rmSync(stagingDirectory, { recursive: true, force: true })
		}
		removeInterruptionHandlers()
		rmSync(lockDirectory, { recursive: true, force: true })
	}
}

async function discoverRemotePairs(
	config: BackupPullConfig,
	dependencies: BackupPullDependencies,
): Promise<string[]> {
	let lastError: Error | undefined
	for (let attempt = 0; attempt < MAX_LIST_ATTEMPTS; attempt += 1) {
		throwIfInterrupted()
		try {
			const entries = await dependencies.listRemoteEntries(config)
			const ids = parseRemotePairEntries(entries)
			if (ids.length === 0) throw new Error('Remote backup directory contains no complete pairs')
			return ids
		} catch (error) {
			lastError = error instanceof Error ? error : new Error('Remote backup listing failed')
			if (!(error instanceof IncompleteRemoteListingError) || attempt === MAX_LIST_ATTEMPTS - 1) {
				throw lastError
			}
			await dependencies.sleep(RETRY_DELAYS_MS[attempt]!)
		}
	}
	throw lastError ?? new Error('Remote backup listing failed')
}

class IncompleteRemoteListingError extends Error {}

function parseRemotePairEntries(entries: RemoteEntry[]): string[] {
	if (entries.length === 0) throw new Error('Remote backup directory is empty')
	const sqliteIds = new Set<string>()
	const metadataIds = new Set<string>()
	let hasTemporaryFiles = false

	for (const entry of entries) {
		if (entry.kind !== 'f') throw new Error('Remote backup directory contains a non-regular entry')
		const temporaryMatch = TEMPORARY_PAIR_FILE.exec(entry.name)
		if (temporaryMatch) {
			hasTemporaryFiles = true
			continue
		}
		const sqliteMatch = /^(.*)\.sqlite$/.exec(entry.name)
		const metadataMatch = /^(.*)\.json$/.exec(entry.name)
		const id = sqliteMatch?.[1] ?? metadataMatch?.[1]
		if (!id || !PAIR_ID.test(id)) throw new Error('Remote backup directory contains an unexpected file name')
		if (sqliteMatch) {
			if (sqliteIds.has(id)) throw new Error(`Remote backup contains a duplicate database file: ${id}`)
			sqliteIds.add(id)
		} else {
			if (metadataIds.has(id)) throw new Error(`Remote backup contains duplicate metadata: ${id}`)
			metadataIds.add(id)
		}
	}

	if (hasTemporaryFiles) throw new IncompleteRemoteListingError('Remote backup creation is in progress')
	if (sqliteIds.size === 0 && metadataIds.size === 0) {
		throw new Error('Remote backup directory contains no complete pairs')
	}
	const allIds = new Set([...sqliteIds, ...metadataIds])
	for (const id of allIds) {
		if (!sqliteIds.has(id) || !metadataIds.has(id)) {
			throw new IncompleteRemoteListingError(`Remote backup pair is incomplete: ${id}`)
		}
	}
	return [...allIds].sort()
}

async function downloadPairWithRetries(
	config: BackupPullConfig,
	id: string,
	destination: string,
	dependencies: BackupPullDependencies,
): Promise<void> {
	let lastError: Error | undefined
	for (let attempt = 0; attempt < MAX_TRANSFER_ATTEMPTS; attempt += 1) {
		throwIfInterrupted()
		try {
			await dependencies.downloadPair(config, id, destination)
			return
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(`Transfer failed for backup ${id}`)
			for (const name of readdirSync(destination)) {
				rmSync(join(destination, name), { recursive: true, force: true })
			}
			if (attempt < MAX_TRANSFER_ATTEMPTS - 1) {
				await dependencies.sleep(RETRY_DELAYS_MS[attempt]!)
			}
		}
	}
	throw new Error(`Could not transfer backup ${id} after bounded retries: ${errorMessage(lastError)}`)
}

function loadLocalSnapshots(directory: string, nowMs: number): Map<string, VerifiedSnapshot> {
	const snapshots = new Map<string, VerifiedSnapshot>()
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === '.pull.lock' || entry.name.startsWith('.pull-staging-')) continue
		if (!PAIR_ID.test(entry.name)) throw new Error('Local backup directory contains an unmanaged entry')
		const path = join(directory, entry.name)
		const info = lstatSync(path)
		if (!info.isDirectory() || info.isSymbolicLink()) {
			throw new Error(`Published backup is not a regular pair directory: ${entry.name}`)
		}
		snapshots.set(entry.name, verifySnapshot(path, entry.name, nowMs))
	}
	return snapshots
}

function verifySnapshot(directory: string, id: string, nowMs: number): VerifiedSnapshot {
	const directoryInfo = lstatSync(directory)
	if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
		throw new Error(`Backup ${id} is not a regular directory`)
	}
	if ((directoryInfo.mode & 0o077) !== 0) throw new Error(`Backup directory permissions are too open: ${id}`)
	const databasePath = join(directory, `${id}.sqlite`)
	const metadataPath = join(directory, `${id}.json`)
	const names = readdirSync(directory).sort()
	if (names.length !== 2 || names[0] !== `${id}.json` || names[1] !== `${id}.sqlite`) {
		throw new Error(`Backup ${id} does not contain exactly one SQLite/JSON pair`)
	}
	for (const path of [databasePath, metadataPath]) {
		const info = lstatSync(path)
		if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Backup ${id} contains a non-regular file`)
		if ((info.mode & 0o077) !== 0) throw new Error(`Backup file permissions are too open: ${id}`)
	}

	const metadata = verifyBackup(databasePath, metadataPath)
	if (metadata.backup_id !== id || metadata.database_file !== `${id}.sqlite`) {
		throw new Error(`Backup metadata does not match pair ID: ${id}`)
	}
	const createdAtMs = Date.parse(metadata.created_at)
	if (!Number.isFinite(createdAtMs) || new Date(createdAtMs).toISOString() !== metadata.created_at) {
		throw new Error(`Backup creation time is invalid: ${id}`)
	}
	if (createdAtMs > nowMs) throw new Error(`Backup creation time is in the future: ${id}`)
	return {
		id,
		directory,
		metadata,
		metadataText: readFileSync(metadataPath, 'utf8'),
		createdAtMs,
	}
}

function securePairFiles(directory: string, id: string): void {
	for (const name of [`${id}.sqlite`, `${id}.json`]) {
		const path = join(directory, name)
		const info = lstatSync(path)
		if (!info.isFile() || info.isSymbolicLink()) {
			throw new Error(`Staged backup ${id} contains a non-regular file`)
		}
		chmodSync(path, 0o600)
	}
}

function assertRemotePairMatches(
	id: string,
	existing: VerifiedSnapshot,
	remoteMetadataText: string,
databaseChanged: boolean,
): void {
	const remoteMetadata: unknown = JSON.parse(remoteMetadataText)
	if (
		!remoteMetadata ||
		typeof remoteMetadata !== 'object' ||
		!('backup_id' in remoteMetadata) ||
		remoteMetadata.backup_id !== id ||
		!('database_file' in remoteMetadata) ||
		remoteMetadata.database_file !== `${id}.sqlite` ||
		!('sha256' in remoteMetadata) ||
		remoteMetadata.sha256 !== existing.metadata.sha256
	) {
		throw new Error(`Remote backup ID conflicts with the verified local pair: ${id}`)
	}
	if (remoteMetadataText !== existing.metadataText || databaseChanged) {
		throw new Error(`Remote backup ID conflicts with the verified local pair: ${id}`)
	}
}

function newestSnapshot(snapshots: VerifiedSnapshot[]): VerifiedSnapshot {
	return snapshots.reduce((latest, candidate) => {
		if (candidate.createdAtMs > latest.createdAtMs) return candidate
		if (candidate.createdAtMs === latest.createdAtMs && candidate.id > latest.id) return candidate
		return latest
	})
}

function assertSnapshotFresh(snapshot: VerifiedSnapshot, nowMs: number): void {
	const ageMs = nowMs - snapshot.createdAtMs
	if (ageMs < 0) throw new Error('Newest verified backup has a future creation time')
	if (ageMs > MAX_AGE_MS) throw new Error('Newest verified backup is older than 24 hours')
}

function secureMkdir(directory: string): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	const info = lstatSync(directory)
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Local backup path must be a regular directory')
	chmodSync(directory, 0o700)
}

function removeStaleStagingDirectories(directory: string): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (!entry.name.startsWith('.pull-staging-')) continue
		const path = join(directory, entry.name)
		const info = lstatSync(path)
		if (!info.isDirectory() || info.isSymbolicLink()) {
			throw new Error('Found an invalid stale backup staging entry')
		}
		rmSync(path, { recursive: true })
	}
}

function installInterruptionHandlers(): () => void {
	const state: InterruptionState = { children: new Set() }
	activeInterruption = state
	const onInterrupt = (signal: 'SIGINT' | 'SIGTERM') => {
		state.signal = signal
		for (const child of state.children) child.kill(signal)
	}
	const onSigint = () => onInterrupt('SIGINT')
	const onSigterm = () => onInterrupt('SIGTERM')
	process.on('SIGINT', onSigint)
	process.on('SIGTERM', onSigterm)
	return () => {
		process.off('SIGINT', onSigint)
		process.off('SIGTERM', onSigterm)
		activeInterruption = undefined
	}
}

function throwIfInterrupted(): void {
	if (activeInterruption?.signal) {
		throw new Error(`Backup pull interrupted by ${activeInterruption.signal}`)
	}
}

async function listRemoteEntries(config: BackupPullConfig): Promise<RemoteEntry[]> {
	const output = await runRsync(
		config,
		[
			'--list-only',
			'--archive',
			'--timeout=60',
			`${config.remoteHost}:${config.remoteDirectory}/`,
		],
		'Remote backup listing',
	)
	const text = new TextDecoder('utf-8', { fatal: true }).decode(output)
	return parseRsyncDirectoryListing(text)
}

export function parseRsyncDirectoryListing(text: string): RemoteEntry[] {
	const entries: RemoteEntry[] = []
	for (const line of text.split('\n')) {
		const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line
		if (normalizedLine.length === 0) continue
		const match = /^([bcdlps-][rwxstST-]{9})\s+(?:\d{1,3}(?:,\d{3})+|\d+)\s+\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+(.+)$/.exec(
			normalizedLine,
		)
		if (!match) throw new Error('Remote backup listing used an unknown format')
		const name = match[2]!
		if (name === '.' || name === './') continue
		const type = match[1]![0]!
		entries.push({ kind: type === '-' ? 'f' : type, name })
	}
	return entries
}

async function downloadPair(
	config: BackupPullConfig,
	id: string,
	destination: string,
): Promise<void> {
	const remotePrefix = `${config.remoteHost}:${config.remoteDirectory}`
	await runRsync(
		config,
		[
			'--archive',
			'--timeout=60',
			`${remotePrefix}/${id}.sqlite`,
			`${remotePrefix}/${id}.json`,
			`${destination}/`,
		],
		'Backup transfer',
	)
}

async function attestRemotePair(
	config: BackupPullConfig,
	id: string,
	metadataDestination: string,
	localDatabasePath: string,
): Promise<{ databaseChanged: boolean }> {
	const remotePrefix = `${config.remoteHost}:${config.remoteDirectory}`
	await runRsync(
		config,
		[
			'--archive',
			'--timeout=60',
			`${remotePrefix}/${id}.json`,
			`${metadataDestination}/`,
		],
		'Remote metadata transfer',
	)
	const comparison = await runRsync(
		config,
		[
			'--checksum',
			'--dry-run',
			'--itemize-changes',
			'--out-format=%i%n',
			'--timeout=60',
			`${remotePrefix}/${id}.sqlite`,
			localDatabasePath,
		],
		'Remote database content check',
	)
	return {
		databaseChanged: comparison.byteLength > 0,
	}
}

async function runRsync(config: BackupPullConfig, args: string[], label: string): Promise<Uint8Array> {
	const sshOptions =
		'-o BatchMode=yes -o ForwardAgent=no -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2 -o StrictHostKeyChecking=yes'
	const rsyncRsh = `${config.sshBinary} ${sshOptions}`
	return runCommand(
		[
			config.rsyncBinary,
			'--rsync-path=sudo -n rsync',
			'--rsh',
			rsyncRsh,
			...args,
		],
		label,
	)
}

async function runCommand(args: string[], label: string): Promise<Uint8Array> {
	throwIfInterrupted()
	const child = Bun.spawn(args, {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'ignore',
	})
	activeInterruption?.children.add(child)
	let timedOut = false
	const timeout = setTimeout(() => {
		timedOut = true
		child.kill('SIGTERM')
	}, 30 * 60 * 1000)
	let stdout: ArrayBuffer
	let exitCode: number
	try {
		;[stdout, exitCode] = await Promise.all([
			new Response(child.stdout).arrayBuffer(),
			child.exited,
		])
	} finally {
		clearTimeout(timeout)
		activeInterruption?.children.delete(child)
	}
	throwIfInterrupted()
	if (timedOut) throw new Error(`${label} timed out`)
	if (exitCode !== 0) throw new Error(`${label} failed (exit code ${exitCode})`)
	return new Uint8Array(stdout)
}

async function pingHealthchecks(urlValue: string, event: 'start' | 'success' | 'failure'): Promise<void> {
	const url = new URL(urlValue)
	if (event !== 'success') {
		url.pathname = `${url.pathname.replace(/\/+$/, '')}/${event === 'start' ? 'start' : 'fail'}`
	}
	const response = await fetch(url, {
		method: 'GET',
		redirect: 'error',
		signal: AbortSignal.timeout(5_000),
	})
	await response.body?.cancel()
	if (!response.ok) throw new Error('Healthchecks request failed')
}

function hasErrorCode(error: unknown, code: string): boolean {
	return !!error && typeof error === 'object' && 'code' in error && error.code === code
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown backup pull failure'
}
