import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
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

function event(sequence: number, overrides: Partial<WorkEvent> = {}): WorkEvent {
	return {
		schemaVersion: 1,
		eventId: `01990b2e-1c00-7000-8000-${String(sequence).padStart(12, '0')}`,
		sourceInstance: '7ebc7d16-3945-4e30-b46e-2c288d747f6f',
		sourceSequence: sequence,
		sessionId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(sequence).padStart(12, '0')}`,
		kind: 'agent.start',
		occurredAt: new Date(now).toISOString(),
		occurredAtMs: now,
		...overrides,
	}
}

function createVersion3Database(path: string): void {
	const store = new ServiceStore(path)
	store.putTargetOverride('2026-08-31', 0, now)
	store.close()
	const database = new Database(path, { strict: true })
	database.exec(`
		ALTER TABLE target_overrides RENAME TO target_overrides_v4;
		CREATE TABLE target_overrides (
			date TEXT PRIMARY KEY CHECK (
				length(date) = 10 AND
				date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
			),
			target_minutes INTEGER NOT NULL CHECK (target_minutes = 0),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		) STRICT;
		INSERT INTO target_overrides SELECT * FROM target_overrides_v4;
		DROP TABLE target_overrides_v4;
		PRAGMA user_version = 3;
	`)
	database.close()
}

test('creates a verified online SQLite snapshot and restores an independently retrieved copy', () => {
	const directory = workspace()
	const sourcePath = join(directory, 'live', 'service.sqlite')
	const backupDirectory = join(directory, 'backups')
	const store = new ServiceStore(sourcePath)
	const issued = store.issueBearer(now)
	const principal = store.authenticateBearer(issued.token)!
	store.bindExecutorLabel(issued.tokenId, 'workstation-a')
	store.ingest(principal, event(1, { schemaVersion: 2, projectSlug: 'cukup-service' }), now)
	store.putTargetOverride('2026-08-31', 240, now)

	const backup = backupDatabase(sourcePath, backupDirectory, {
		nowMs: now,
		backupId: 'snapshot',
	})
	expect(backup.metadata).toMatchObject({
		backup_id: 'snapshot',
		created_at: '2026-08-31T05:00:00.000Z',
		integrity_check: 'ok',
		sqlite_user_version: 4,
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
	expect(inspectDatabase(restoredPath)).toEqual({ integrity: 'ok', userVersion: 4 })

	const restored = new ServiceStore(restoredPath)
	expect(restored.authenticateBearer(issued.token)).toEqual({
		kind: 'bearer',
		tokenId: issued.tokenId,
	})
	expect(restored.events().map((value) => value.sourceSequence)).toEqual([1])
	expect(restored.attributedEvents()[0]).toMatchObject({
		schemaVersion: 2,
		projectSlug: 'cukup-service',
		executorLabel: 'workstation-a',
	})
	expect(restored.targetOverrides()).toEqual(new Map([['2026-08-31', 240]]))
	restored.close()
})

test('restores v1, v2, v3, and v4 backups into clean restartable databases', () => {
	const directory = workspace()
	const versionOnePath = join(directory, 'version-one.sqlite')
	const versionOne = new Database(versionOnePath, { create: true, strict: true })
	versionOne.exec(`
		CREATE TABLE auth_tokens (
			token_id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL,
			revoked_at TEXT,
			replaced_by TEXT REFERENCES auth_tokens(token_id)
		) STRICT;
		CREATE TABLE source_owners (
			source_instance TEXT PRIMARY KEY,
			owner_kind TEXT NOT NULL CHECK (owner_kind IN ('bearer', 'oidc')),
			owner_id TEXT REFERENCES auth_tokens(token_id),
			CHECK (
				(owner_kind = 'bearer' AND owner_id IS NOT NULL) OR
				(owner_kind = 'oidc' AND owner_id IS NULL)
			)
		) STRICT;
		CREATE TABLE events (
			event_id TEXT PRIMARY KEY,
			schema_version INTEGER NOT NULL CHECK (schema_version = 1),
			source_instance TEXT NOT NULL REFERENCES source_owners(source_instance),
			source_sequence INTEGER NOT NULL CHECK (source_sequence >= 1),
			session_id TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('agent.start', 'agent.end')),
			occurred_at TEXT NOT NULL,
			occurred_at_ms INTEGER NOT NULL,
			monotonic_duration_ms INTEGER CHECK (monotonic_duration_ms IS NULL OR monotonic_duration_ms >= 0),
			received_at TEXT NOT NULL,
			received_at_ms INTEGER NOT NULL,
			UNIQUE (source_instance, source_sequence)
		) STRICT;
		INSERT INTO source_owners VALUES ('7ebc7d16-3945-4e30-b46e-2c288d747f6f', 'oidc', NULL);
		INSERT INTO events VALUES (
			'01990b2e-1c00-7000-8000-000000000001', 1,
			'7ebc7d16-3945-4e30-b46e-2c288d747f6f', 1,
			'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'agent.start',
			'2026-08-31T05:00:00.000Z', ${now}, NULL,
			'2026-08-31T05:00:00.000Z', ${now}
		);
		PRAGMA user_version = 1;
	`)
	versionOne.close()

	const pre = backupDatabase(versionOnePath, join(directory, 'pre-backups'), {
		nowMs: now,
		backupId: 'pre-migration',
	})
	expect(pre.metadata.sqlite_user_version).toBe(1)
	const upgradedPath = join(directory, 'pre-restored', 'service.sqlite')
	restoreDatabase(pre.databasePath, upgradedPath, { metadataPath: pre.metadataPath })
	expect(inspectDatabase(upgradedPath).userVersion).toBe(1)
	const upgraded = new ServiceStore(upgradedPath)
	expect(upgraded.events()).toHaveLength(1)
	expect(upgraded.attributedEvents()[0]?.executorLabel).toBe('amp-orb')
	upgraded.close()
	expect(inspectDatabase(upgradedPath).userVersion).toBe(4)

	const versionTwoPath = join(directory, 'version-two.sqlite')
	const current = new ServiceStore(versionTwoPath)
	current.close()
	const versionTwo = new Database(versionTwoPath, { strict: true })
	versionTwo.exec(`
		DROP TABLE target_overrides;
		PRAGMA user_version = 2;
	`)
	versionTwo.close()
	const versionTwoBackup = backupDatabase(versionTwoPath, join(directory, 'v2-backups'), {
		nowMs: now,
		backupId: 'version-two',
	})
	expect(versionTwoBackup.metadata.sqlite_user_version).toBe(2)
	const versionTwoRestoredPath = join(directory, 'v2-restored', 'service.sqlite')
	restoreDatabase(versionTwoBackup.databasePath, versionTwoRestoredPath, {
		metadataPath: versionTwoBackup.metadataPath,
	})
	const versionTwoRestored = new ServiceStore(versionTwoRestoredPath)
	expect(versionTwoRestored.targetOverrides()).toEqual(new Map())
	versionTwoRestored.close()
	expect(inspectDatabase(versionTwoRestoredPath).userVersion).toBe(4)

	const versionThreePath = join(directory, 'version-three.sqlite')
	createVersion3Database(versionThreePath)
	const versionThreeBackup = backupDatabase(versionThreePath, join(directory, 'v3-backups'), {
		nowMs: now + 1,
		backupId: 'version-three',
	})
	expect(versionThreeBackup.metadata.sqlite_user_version).toBe(3)
	const versionThreeRestoredPath = join(directory, 'v3-restored', 'service.sqlite')
	restoreDatabase(versionThreeBackup.databasePath, versionThreeRestoredPath, {
		metadataPath: versionThreeBackup.metadataPath,
	})
	expect(inspectDatabase(versionThreeRestoredPath).userVersion).toBe(3)
	const versionThreeRestored = new ServiceStore(versionThreeRestoredPath)
	expect(versionThreeRestored.targetOverrides()).toEqual(new Map([['2026-08-31', 0]]))
	versionThreeRestored.close()
	expect(inspectDatabase(versionThreeRestoredPath).userVersion).toBe(4)

	const versionFourPath = join(directory, 'version-four.sqlite')
	const versionFour = new ServiceStore(versionFourPath)
	versionFour.putTargetOverride('2026-08-31', 240, now)
	versionFour.close()
	const versionFourBackup = backupDatabase(versionFourPath, join(directory, 'v4-backups'), {
		nowMs: now + 2,
		backupId: 'version-four',
	})
	expect(versionFourBackup.metadata.sqlite_user_version).toBe(4)
	const versionFourRestoredPath = join(directory, 'v4-restored', 'service.sqlite')
	restoreDatabase(versionFourBackup.databasePath, versionFourRestoredPath, {
		metadataPath: versionFourBackup.metadataPath,
	})
	expect(inspectDatabase(versionFourRestoredPath).userVersion).toBe(4)
	const versionFourRestored = new ServiceStore(versionFourRestoredPath)
	expect(versionFourRestored.targetOverrides()).toEqual(new Map([['2026-08-31', 240]]))
	versionFourRestored.close()
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
