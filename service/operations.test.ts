import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupDatabase, inspectDatabase, restoreDatabase, verifyBackup } from './operations.ts'
import { ServiceStore } from './store.ts'
import type { WorkEvent } from './types.ts'

const temporaryDirectories: string[] = []
const now = Date.parse('2026-08-31T05:00:00.000Z')

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

function workspace(): string {
	const directory = mkdtempSync(join(tmpdir(), 'cukup-backup-'))
	temporaryDirectories.push(directory)
	return directory
}

function event(sequence: number): WorkEvent {
	return {
		schemaVersion: 1,
		eventId: `01990b2e-1c00-7000-8000-${String(sequence).padStart(12, '0')}`,
		sourceInstance: '7ebc7d16-3945-4e30-b46e-2c288d747f6f',
		sourceSequence: sequence,
		sessionId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(sequence).padStart(12, '0')}`,
		kind: 'agent.start',
		occurredAt: new Date(now).toISOString(),
		occurredAtMs: now,
	}
}

test('creates a verified online SQLite snapshot and restores an independently retrieved copy', () => {
	const directory = workspace()
	const sourcePath = join(directory, 'live', 'service.sqlite')
	const backupDirectory = join(directory, 'backups')
	const store = new ServiceStore(sourcePath)
	const issued = store.issueBearer(now)
	const principal = store.authenticateBearer(issued.token)!
	store.ingest(principal, event(1), now)

	const backup = backupDatabase(sourcePath, backupDirectory, {
		nowMs: now,
		backupId: 'snapshot',
	})
	expect(backup.metadata).toMatchObject({
		backup_id: 'snapshot',
		created_at: '2026-08-31T05:00:00.000Z',
		integrity_check: 'ok',
		sqlite_user_version: 1,
	})
	expect(verifyBackup(backup.databasePath, backup.metadataPath)).toEqual(backup.metadata)

	store.ingest(
		principal,
		event(2),
		now,
	)
	expect(store.events()).toHaveLength(2)
	store.close()

	const retrievedDirectory = join(directory, 'retrieved-offsite')
	mkdirSync(retrievedDirectory)
	const retrievedDatabase = join(retrievedDirectory, 'snapshot.sqlite')
	const retrievedMetadata = join(retrievedDirectory, 'snapshot.json')
	copyFileSync(backup.databasePath, retrievedDatabase)
	copyFileSync(backup.metadataPath, retrievedMetadata)
	const restoredPath = join(directory, 'clean-restore', 'service.sqlite')
	restoreDatabase(retrievedDatabase, restoredPath, { metadataPath: retrievedMetadata })
	expect(inspectDatabase(restoredPath)).toEqual({ integrity: 'ok', userVersion: 1 })

	const restored = new ServiceStore(restoredPath)
	expect(restored.authenticateBearer(issued.token)).toEqual({
		kind: 'bearer',
		tokenId: issued.tokenId,
	})
	expect(restored.events().map((value) => value.sourceSequence)).toEqual([1])
	restored.close()
})

test('fails closed on checksum damage and requires an explicit stopped-service replacement', () => {
	const directory = workspace()
	const sourcePath = join(directory, 'live.sqlite')
	const store = new ServiceStore(sourcePath)
	store.close()
	const backup = backupDatabase(sourcePath, join(directory, 'backups'), { backupId: 'snapshot' })
	appendFileSync(backup.databasePath, 'damage')
	expect(() => verifyBackup(backup.databasePath, backup.metadataPath)).toThrow('Backup size mismatch')

	const clean = backupDatabase(sourcePath, join(directory, 'backups'), { backupId: 'clean' })
	const target = join(directory, 'target.sqlite')
	copyFileSync(sourcePath, target)
	expect(() => restoreDatabase(clean.databasePath, target)).toThrow('Restore target already exists')
	restoreDatabase(clean.databasePath, target, { replace: true })
	expect(inspectDatabase(target).integrity).toBe('ok')
})
