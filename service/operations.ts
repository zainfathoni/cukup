import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

export type BackupMetadata = {
	backup_id: string
	created_at: string
	database_file: string
	size_bytes: number
	sha256: string
	integrity_check: 'ok'
	sqlite_user_version: number
}

export function backupDatabase(
	databasePath: string,
	destinationDirectory: string,
	options: { nowMs?: number; backupId?: string } = {},
): { databasePath: string; metadataPath: string; metadata: BackupMetadata } {
	const nowMs = options.nowMs ?? Date.now()
	const backupId = options.backupId ?? `${timestampId(nowMs)}-${randomUUID()}`
	mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 })
	chmodSync(destinationDirectory, 0o700)
	const outputPath = join(destinationDirectory, `${backupId}.sqlite`)
	const metadataPath = join(destinationDirectory, `${backupId}.json`)
	const temporaryPath = `${outputPath}.tmp-${randomUUID()}`
	const temporaryMetadataPath = `${metadataPath}.tmp-${randomUUID()}`
	if (existsSync(outputPath) || existsSync(metadataPath)) throw new Error('Backup already exists')

	try {
		const source = new Database(databasePath, { readonly: true, strict: true })
		try {
			source.exec('PRAGMA busy_timeout = 5000')
			source.query('VACUUM INTO ?').run(temporaryPath)
		} finally {
			source.close()
		}
		chmodSync(temporaryPath, 0o600)
		const verified = inspectDatabase(temporaryPath)
		const metadata: BackupMetadata = {
			backup_id: backupId,
			created_at: new Date(nowMs).toISOString(),
			database_file: basename(outputPath),
			size_bytes: statSync(temporaryPath).size,
			sha256: sha256File(temporaryPath),
			integrity_check: 'ok',
			sqlite_user_version: verified.userVersion,
		}
		writeFileSync(temporaryMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 })
		renameSync(temporaryPath, outputPath)
		renameSync(temporaryMetadataPath, metadataPath)
		return { databasePath: outputPath, metadataPath, metadata }
	} catch (error) {
		rmSync(temporaryPath, { force: true })
		rmSync(temporaryMetadataPath, { force: true })
		throw error
	}
}

export function verifyBackup(
	backupPath: string,
	metadataPath = backupPath.replace(/\.sqlite$/, '.json'),
): BackupMetadata {
	const metadata = parseMetadata(metadataPath)
	if (metadata.database_file !== basename(backupPath)) throw new Error('Backup metadata file mismatch')
	if (statSync(backupPath).size !== metadata.size_bytes) throw new Error('Backup size mismatch')
	if (sha256File(backupPath) !== metadata.sha256) throw new Error('Backup checksum mismatch')
	const inspected = inspectDatabase(backupPath)
	if (inspected.userVersion !== metadata.sqlite_user_version) {
		throw new Error('Backup schema version mismatch')
	}
	return metadata
}

export function restoreDatabase(
	backupPath: string,
	targetPath: string,
	options: { metadataPath?: string; replace?: boolean } = {},
): void {
	verifyBackup(backupPath, options.metadataPath)
	if (existsSync(targetPath) && !options.replace) {
		throw new Error('Restore target already exists; use --replace only while the service is stopped')
	}
	const directory = dirname(targetPath)
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	chmodSync(directory, 0o700)
	const temporaryPath = `${targetPath}.restore-${randomUUID()}`
	try {
		copyFileSync(backupPath, temporaryPath)
		chmodSync(temporaryPath, 0o600)
		inspectDatabase(temporaryPath)
		if (options.replace) {
			rmSync(`${targetPath}-wal`, { force: true })
			rmSync(`${targetPath}-shm`, { force: true })
		}
		renameSync(temporaryPath, targetPath)
	} catch (error) {
		rmSync(temporaryPath, { force: true })
		throw error
	}
}

export function inspectDatabase(path: string): { integrity: 'ok'; userVersion: number } {
	const database = new Database(path, { readonly: true, strict: true })
	try {
		const integrity = database.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()
		if (integrity?.integrity_check !== 'ok') throw new Error('SQLite integrity check failed')
		const version = database.query<{ user_version: number }, []>('PRAGMA user_version').get()
		return { integrity: 'ok', userVersion: version?.user_version ?? 0 }
	} finally {
		database.close()
	}
}

function parseMetadata(path: string): BackupMetadata {
	const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
	if (
		!value ||
		typeof value !== 'object' ||
		!('backup_id' in value) ||
		typeof value.backup_id !== 'string' ||
		!('created_at' in value) ||
		typeof value.created_at !== 'string' ||
		!('database_file' in value) ||
		typeof value.database_file !== 'string' ||
		!('size_bytes' in value) ||
		typeof value.size_bytes !== 'number' ||
		!('sha256' in value) ||
		typeof value.sha256 !== 'string' ||
		!('integrity_check' in value) ||
		value.integrity_check !== 'ok' ||
		!('sqlite_user_version' in value) ||
		typeof value.sqlite_user_version !== 'number'
	) {
		throw new Error('Invalid backup metadata')
	}
	return value as BackupMetadata
}

function sha256File(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function timestampId(timestampMs: number): string {
	return new Date(timestampMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}
