import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAPABILITIES, LOCAL_PROTOCOL, type Evidence } from '../experimental/local-harness-evidence.ts'
import { ServiceStore } from './store.ts'

const directories: string[] = []
const stores: ServiceStore[] = []
const now = Date.parse('2026-09-14T12:00:00.000Z')
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`
const project = { kind: 'cukup_project', project_id: id(90), basis: 'explicit_binding' } as const
const timing = (ms = now - 86400000) => ({ wall_time: new Date(ms).toISOString(), provenance: 'native_occurrence' as const, precision_ms: 1 })
function fact(family: Evidence['family'] = 'engagement', n = 1): Evidence {
	const common = { evidence_id: id(n), recovered: true, timing: timing() }
	if (family === 'engagement') return { ...common, family, origin: 'human', interaction: 'submission', project_attribution: project }
	if (family === 'execution_start') return { ...common, family, segment_id: id(80), project_attribution: project }
	return { ...common, family, segment_id: id(80) }
}
function input(evidence: unknown = fact(), sequence = 1, collector = id(70), site = id(60)) {
	return { sourceSequence: sequence, executionSiteId: site, envelope: {
		protocol: LOCAL_PROTOCOL, protocol_version: 1, collector_instance_id: collector,
		capabilities: [...CAPABILITIES], evidence: [evidence],
	} }
}
function open(path?: string) {
	if (!path) {
		const directory = mkdtempSync(join(tmpdir(), 'cukup-shadow-'))
		directories.push(directory)
		path = join(directory, 'service.sqlite')
	}
	const store = new ServiceStore(path)
	stores.push(store)
	return { store, path }
}
function close(store: ServiceStore) {
	store.close()
	stores.splice(stores.indexOf(store), 1)
}
afterEach(() => {
	for (const store of stores.splice(0)) store.close()
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const rejected = <T extends string>(reason: T) => ({ status: 'rejected' as const, reason })

test('immutable replay includes identity, source, site, sequence, protocol, capabilities and attribution', () => {
	const { store } = open()
	const original = input()
	expect(store.shadow.append(original, now)).toEqual({ status: 'accepted' })
	const before = store.shadow.records()
	const reordered = structuredClone(original)
	reordered.envelope.capabilities.reverse()
	expect(store.shadow.append(reordered, now + 100)).toEqual({ status: 'duplicate' })
	for (const changed of [
		input(fact(), 2), input(fact(), 1, id(71)), input(fact(), 1, id(70), id(61)),
		input({ ...fact(), recovered: false }),
		input({ ...fact(), project_attribution: { kind: 'unassigned', reason: 'ambiguous' } }),
		{ ...original, envelope: { ...original.envelope, capabilities: ['engagement.submission', 'recovery.engagement.submission'] } },
	]) expect(store.shadow.append(changed, now)).toEqual(rejected('identity_conflict'))
	expect(store.shadow.records()).toEqual(before)
	expect(before[0]).toMatchObject({ evidence: fact(), sourceSequence: 1, protocolVersion: 1, executionSiteId: id(60), receivedAtMs: now })
})

test('per-collector sequence is increasing with gaps, old exact retries survive, occurrence may be delayed', () => {
	const { store } = open()
	expect(store.shadow.append(input(fact(), 3), now).status).toBe('accepted')
	for (const sequence of [1, 2, 3]) expect(store.shadow.append(input(fact('engagement', 2), sequence), now)).toEqual(rejected('invalid_order'))
	expect(store.shadow.append(input({ ...fact('engagement', 2), timing: timing(now - 7 * 86400000) }, 8), now).status).toBe('accepted')
	expect(store.shadow.append(input(fact(), 3), now + 1).status).toBe('duplicate')
	expect(store.shadow.append(input(fact('engagement', 3), 1, id(71)), now).status).toBe('accepted')
	expect(store.shadow.append(input(fact('engagement', 4), 9, id(70), id(61)), now)).toEqual(rejected('identity_conflict'))
	expect(store.shadow.records().map((row) => row.sourceSequence)).toEqual([3, 8, 1])
})

test('pending starts survive restart; delayed ends close only their source and retain start attribution', () => {
	const { store, path } = open()
	const start = fact('execution_start')
	const end = { ...fact('execution_end', 2), timing: timing(now - 86400000 + 3210) }
	expect(store.shadow.append(input(end), now)).toEqual(rejected('invalid_order'))
	expect(store.shadow.append(input(start), now).status).toBe('accepted')
	expect(store.shadow.append(input(end, 1, id(71)), now)).toEqual(rejected('invalid_order'))
	expect(store.shadow.append(input({ ...end, timing: timing(now - 86400001) }, 2), now)).toEqual(rejected('invalid_order'))
	expect(store.shadow.append(input({ ...end, project_attribution: { kind: 'unassigned', reason: 'absent' } }, 2), now)).toEqual(rejected('invalid_record'))
	const pending = store.shadow.segments()
	expect(pending).toEqual([{ start: store.shadow.records()[0], end: null, status: 'pending' }])
	close(store)
	const restarted = open(path).store
	expect(restarted.shadow.segments()).toEqual(pending)
	expect(restarted.shadow.append(input(end, 2), now + 86400000).status).toBe('accepted')
	expect(restarted.shadow.append(input(fact('execution_end', 3), 3), now)).toEqual(rejected('identity_conflict'))
	expect(restarted.shadow.append(input(fact('execution_start', 4), 3), now)).toEqual(rejected('identity_conflict'))
	expect(restarted.shadow.segments()[0]).toMatchObject({ status: 'closed', start: { evidence: { project_attribution: project } }, end: { evidence: end } })
	const closed = restarted.shadow.segments()
	close(restarted)
	const again = open(path).store
	expect(again.shadow.segments()).toEqual(closed)
	expect(again.shadow.append(input(end, 2), now + 2 * 86400000).status).toBe('duplicate')
	expect(again.shadow.append(input(fact('execution_start', 5), 1, id(71)), now).status).toBe('accepted')
	expect(again.shadow.segments().map((segment) => segment.status)).toEqual(['closed', 'pending'])
})

test('closed parser rejects forbidden/unknown metadata at every boundary and never persists it', () => {
	const { store } = open()
	for (const field of ['prompt', 'output', 'path', 'tokens', 'cost', 'native_thread_id', 'native_message_id', 'metadata', 'surprise']) {
		const original = input()
		for (const bad of [
			{ ...original, [field]: 'secret' },
			{ ...original, envelope: { ...original.envelope, [field]: 'secret' } },
			input({ ...fact(), [field]: 'secret' }),
			input({ ...fact(), timing: { ...timing(), [field]: 'secret' } }),
			input({ ...fact(), project_attribution: { ...project, [field]: 'secret' } }),
		]) expect(store.shadow.append(bad, now)).toEqual(rejected('invalid_record'))
	}
	const original = input()
	expect(store.shadow.append({ ...original, envelope: { ...original.envelope, protocol_version: 2 } }, now)).toEqual(rejected('unsupported_version'))
	for (const bad of [input({ ...fact(), origin: 'unknown' }), input({ ...fact(), timing: timing(now + 600001) }), input(fact(), 0), input(fact(), 1.5)]) {
		expect(store.shadow.append(bad, now)).toEqual(rejected('invalid_record'))
	}
	expect(store.shadow.records()).toEqual([])
})

test('SQLite failures roll back first-source binding and append-only triggers prevent mutation', () => {
	const { store, path } = open()
	const raw = new Database(path)
	raw.exec(`CREATE TRIGGER fail_shadow BEFORE INSERT ON shadow_evidence BEGIN SELECT RAISE(ABORT, 'injected'); END`)
	expect(() => store.shadow.append(input(), now)).toThrow('injected')
	expect(raw.query('SELECT * FROM shadow_collectors').all()).toEqual([])
	expect(store.shadow.records()).toEqual([])
	raw.exec('DROP TRIGGER fail_shadow')
	expect(store.shadow.append(input(), now).status).toBe('accepted')
	for (const table of ['shadow_evidence', 'shadow_collectors']) {
		expect(() => raw.exec(`DELETE FROM ${table}`)).toThrow('append-only')
		expect(() => raw.exec(`UPDATE ${table} SET collector_id = '${id(99)}'`)).toThrow('append-only')
	}
	expect(store.shadow.records()).toHaveLength(1)
	raw.close()
})

test('v4 upgrade retains exact legacy schema, rows, ownership, credentials, and mixed v1/v2 behavior', () => {
	const { store, path } = open()
	const credential = store.issueBearer(now)
	store.bindExecutorLabel(credential.tokenId, 'test-machine')
	const principal = store.authenticateBearer(credential.token)!
	const legacy = { schemaVersion: 1 as const, eventId: id(1), sourceInstance: id(70), sourceSequence: 1, sessionId: id(80), kind: 'agent.start' as const, occurredAt: new Date(now).toISOString(), occurredAtMs: now }
	const v2 = { ...legacy, schemaVersion: 2 as const, eventId: id(2), sourceSequence: 2, sessionId: id(81), projectSlug: 'cukup' }
	expect(store.ingest(principal, legacy, now).outcome).toBe('accepted')
	expect(store.ingest(principal, v2, now).outcome).toBe('accepted')
	store.putTargetOverride('2026-09-14', 240, now)
	const events = store.attributedEvents()
	close(store)
	const raw = new Database(path)
	raw.exec('DROP TABLE shadow_evidence; DROP TABLE shadow_collectors; PRAGMA user_version = 4')
	const snapshot = () => ({
		schema: raw.query(`SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE tbl_name NOT LIKE 'shadow_%' ORDER BY name`).all(),
		rows: ['events', 'source_owners', 'auth_tokens', 'target_overrides'].map((table) => raw.query(`SELECT * FROM ${table}`).all()),
	})
	const before = snapshot()
	const migrated = open(path).store
	expect(snapshot()).toEqual(before)
	expect(migrated.shadow.append(input(), now).status).toBe('accepted')
	expect(snapshot()).toEqual(before)
	expect(migrated.attributedEvents()).toEqual(events)
	expect(migrated.authenticateBearer(credential.token)).toEqual(principal)
	expect(migrated.ingest(principal, legacy, now + 1).outcome).toBe('duplicate')
	expect(migrated.ingest(principal, v2, now + 1).outcome).toBe('duplicate')
	expect(migrated.integrityCheck()).toBe('ok')
	expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
	raw.close()
})

test('failed v4 migration rolls back DDL and version and can restart after repair', () => {
	const { store, path } = open()
	close(store)
	const raw = new Database(path)
	raw.exec('DROP TABLE shadow_evidence; DROP TABLE shadow_collectors; PRAGMA user_version = 4; CREATE TABLE shadow_evidence (sentinel TEXT)')
	expect(() => new ServiceStore(path)).toThrow()
	expect(raw.query('PRAGMA user_version').get()).toEqual({ user_version: 4 })
	expect(raw.query("SELECT name FROM sqlite_schema WHERE name = 'shadow_collectors'").all()).toEqual([])
	raw.exec('DROP TABLE shadow_evidence')
	const repaired = open(path).store
	expect(repaired.shadow.records()).toEqual([])
	expect(raw.query('PRAGMA user_version').get()).toEqual({ user_version: 5 })
	raw.close()
})

test('service builds from existing Docker inputs and the parser is covered by publication paths', () => {
	const root = join(import.meta.dir, '..')
	const dockerfile = readFileSync(join(root, 'Dockerfile.service'), 'utf8')
	expect(dockerfile).toContain('COPY service ./service')
	expect(readFileSync(join(root, '.github/workflows/publish-service.yml'), 'utf8')).toContain('      - service/**')
	const directory = mkdtempSync(join(tmpdir(), 'cukup-service-build-'))
	directories.push(directory)
	for (const path of ['package.json', 'bun.lock', 'tsconfig.json', 'service']) {
		cpSync(join(root, path), join(directory, path), { recursive: true })
	}
	// Use installed dependencies, but no experimental or plugin source tree, just like Docker.
	symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir')
	const result = Bun.spawnSync([process.execPath, 'run', 'build:service'], { cwd: directory })
	expect(result.exitCode).toBe(0)
	expect(result.stderr.toString()).not.toContain('Could not resolve')
	expect(readFileSync(join(directory, 'dist/service/index.js'), 'utf8')).toContain('shadow_evidence')
})
