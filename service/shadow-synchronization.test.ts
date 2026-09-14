import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { CAPABILITIES, LOCAL_PROTOCOL } from './harness-evidence-protocol.ts'
import { ServiceLogger } from './logger.ts'
import { projectShadowDisclosures } from './shadow-disclosures.ts'
import { SynchronizationClock, type SynchronizationObservation, type SynchronizationOutcome } from './shadow-synchronization.ts'
import { ServiceStore } from './store.ts'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const reject = (reason: Extract<SynchronizationOutcome, { status: 'rejected' }>['reason']) => ({ status: 'rejected' as const, reason })
function observation(overrides: Partial<SynchronizationObservation> = {}): SynchronizationObservation {
	return { protocol_version: 1, collector_instance_id: id(1), observation_sequence: 8,
		observed_at_ms: 940000, state: 'retrying', records: 3, bytes: 740, oldest_queued_at_ms: 70000,
		...overrides }
}
function fixture(register = true, trusted = true) {
	const directory = mkdtempSync(join(tmpdir(), 'cukup-sync-'))
	cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
	const time = { now: 1000000, trusted }
	const source = { now: () => time.now, trusted: () => time.trusted }
	const path = join(directory, 'service.sqlite')
	const store = new ServiceStore(path, source)
	cleanup.push(() => store.close())
	const raw = new Database(path, { strict: true })
	cleanup.push(() => raw.close())
	const token = store.issueBearer(time.now)
	store.bindExecutorLabel(token.tokenId, 'machine-a')
	const site = store.shadowExecutionSite(token.tokenId)!
	function evidence(sequence: number) {
		return store.shadow.append({ executionSiteId: site, sourceSequence: sequence, envelope: {
			protocol: LOCAL_PROTOCOL, protocol_version: 1, collector_instance_id: id(1), capabilities: [...CAPABILITIES],
			evidence: [{ family: 'engagement', evidence_id: id(100 + sequence), recovered: false,
				timing: { wall_time: new Date(900000).toISOString(), provenance: 'native_occurrence', precision_ms: 1 },
				origin: 'human', interaction: 'submission', project_attribution: { kind: 'unassigned', reason: 'absent' } }],
		} }, time.now)
	}
	if (register) expect(evidence(12)).toEqual({ status: 'accepted' })
	const logs: string[] = []
	const app = createApp({ store, now: () => time.now,
		oidcVerifier: { verify: async (value) => value === 'oidc' },
		logger: new ServiceLogger((line) => logs.push(line)), requireHttps: false,
	})
	const send = (body: unknown = observation(), init: RequestInit = {}, url = 'https://api.cukup.dev/v1/shadow-synchronization') =>
		app.fetch(new Request(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
			...init, headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json', ...init.headers } }))
	const rows = () => raw.query('SELECT * FROM shadow_synchronization').all()
	const read = () => store.synchronization.read(id(1), site)
	return { path, store, raw, token, site, time, source, app, logs, send, rows, read, evidence }
}

test('exact first receipt, ack-loss replay, normalized equality and independent source ordering', async () => {
	const f = fixture()
	expect(await (await f.send()).json()).toEqual({ status: 'accepted' })
	const expected = { ...observation(), received_at_ms: 1000000, expires_at_ms: 1060000 }
	expect(f.rows()).toEqual([expected])
	expect(f.read()).toEqual({ state: 'fresh', snapshot: expected })
	f.time.now = 1050000
	const reordered = Object.fromEntries(Object.entries(observation()).reverse())
	expect(await (await f.send(JSON.stringify(reordered, null, 1))).json()).toEqual({ status: 'duplicate' })
	expect(f.rows()).toEqual([expected])
	expect(await (await f.send(observation({ records: 4 }))).json()).toEqual(reject('identity_conflict'))
	expect(await (await f.send(observation({ observation_sequence: 7, observed_at_ms: 0 }))).json()).toEqual(reject('stale_observation'))
	expect(await (await f.send(observation({ observation_sequence: 900, observed_at_ms: 1050000 }))).json()).toEqual({ status: 'accepted' })
	expect(f.evidence(13)).toEqual({ status: 'accepted' })
	expect(f.store.shadow.records().map((row) => row.sourceSequence)).toEqual([12, 13])
	f.time.now = 1300000
	expect(await (await f.send()).json()).toEqual(reject('stale_observation'))
	expect(f.rows()).toHaveLength(1)
	expect(f.rows()[0]).toMatchObject({ observation_sequence: 900, received_at_ms: 1050000, expires_at_ms: 1170000 })
})

test('inclusive client time edges and read half-open expiry, including delayed duplicate after expiry', async () => {
	for (const [observed, outcome, expiry] of [
		[940000, 'accepted', 1060000], [939999, 'invalid_observation_time', 0],
		[1010000, 'accepted', 1120000], [1010001, 'invalid_observation_time', 0],
	] as const) {
		const f = fixture()
		const payload = observation({ observed_at_ms: observed })
		expect(await (await f.send(payload)).json()).toEqual(outcome === 'accepted' ? { status: outcome } : reject(outcome))
		if (!expiry) {
			expect(f.rows()).toEqual([])
			expect(await (await f.send()).json()).toEqual({ status: 'accepted' })
			continue
		}
		f.time.now = expiry - 1
		expect(f.read().state).toBe('fresh')
		f.time.now = expiry
		expect(f.read()).toEqual({ state: 'unknown' })
		f.time.now = expiry + 900000
		expect(await (await f.send(payload)).json()).toEqual({ status: 'duplicate' })
		expect(f.rows()[0]).toMatchObject({ received_at_ms: 1000000, expires_at_ms: expiry })
		expect(f.read()).toEqual({ state: 'unknown' })
	}
})

test('read validates retained content and exact expiry before classifying a snapshot fresh', async () => {
	for (const mutation of [
		"UPDATE shadow_synchronization SET state = 'clear', records = 3",
		'UPDATE shadow_synchronization SET expires_at_ms = expires_at_ms + 1',
		'UPDATE shadow_synchronization SET protocol_version = 2',
	]) {
		const f = fixture()
		expect(await (await f.send()).json()).toEqual({ status: 'accepted' })
		expect(f.read().state).toBe('fresh')
		f.raw.exec(`PRAGMA ignore_check_constraints = ON; ${mutation}`)
		const read = f.read()
		expect(read).toEqual({ state: 'unknown' })
		expect(projectShadowDisclosures([], [], { startMs: 0, endMs: 1 }, [{
			collectorId: id(1), executionSiteId: f.site, read,
		}])[0]!.synchronization).toBe('unknown')
	}
})

test('startup trust, invalid clocks and backward jumps latch closed until explicit host revalidation', async () => {
	const f = fixture(true, false)
	expect((await f.send()).status).toBe(503)
	expect(f.rows()).toEqual([])
	f.time.trusted = true
	expect((await f.send()).status).toBe(503)
	expect(f.store.synchronization.clock.restoreTrust()).toBeTrue()
	expect(await (await f.send()).json()).toEqual({ status: 'accepted' })
	f.time.now = 999999
	expect(f.read()).toEqual({ state: 'unknown' })
	f.time.now = 1000001
	expect(f.read()).toEqual({ state: 'unknown' })
	const retained = f.rows()
	expect(await (await f.send()).json()).toEqual({ status: 'duplicate' })
	expect(await (await f.send(observation({ observation_sequence: 7 }))).json()).toEqual(reject('stale_observation'))
	expect(await (await f.send(observation({ bytes: 741 }))).json()).toEqual(reject('identity_conflict'))
	expect(f.rows()).toEqual(retained)
	const next = observation({ observation_sequence: 9, observed_at_ms: 1000001 })
	expect(await (await f.send(next)).json()).toEqual({ error: 'temporarily_unavailable' })
	expect(f.store.synchronization.clock.restoreTrust()).toBeTrue()
	expect(await (await f.send(next)).json()).toEqual({ status: 'accepted' })
	for (const invalid of [NaN, Infinity, -1, 1.5, 253402300800000]) {
		f.time.now = invalid
		expect(f.read()).toEqual({ state: 'unknown' })
		expect(f.store.synchronization.clock.restoreTrust()).toBeFalse()
		expect((await f.send(observation({ observation_sequence: 10 }))).status).toBe(503)
	}
	expect(new SynchronizationClock().sample()).toBeUndefined()
	expect(new SynchronizationClock({ now: () => { throw new Error('private clock') }, trusted: () => true }).sample()).toBeUndefined()
})

test('registration and site isolation precede order; rotation preserves identity and revocation prevents lookup', async () => {
	const f = fixture(false)
	expect(f.read()).toEqual({ state: 'unknown' })
	expect(await (await f.send()).json()).toEqual(reject('collector_not_registered'))
	expect(f.raw.query('SELECT * FROM shadow_collectors').all()).toEqual([])
	expect(f.evidence(12)).toEqual({ status: 'accepted' })
	expect(await (await f.send()).json()).toEqual({ status: 'accepted' })
	const other = f.store.issueBearer()
	f.store.bindExecutorLabel(other.tokenId, 'machine-b')
	const otherHeaders = { authorization: `Bearer ${other.token}` }
	expect(await (await f.send(observation({ observation_sequence: 1 }), { headers: otherHeaders })).json()).toEqual(reject('identity_conflict'))
	expect(f.store.synchronization.read(id(1), f.store.shadowExecutionSite(other.tokenId)!)).toEqual({ state: 'unknown' })
	const replacement = f.store.rotateBearer(f.token.tokenId)
	expect(await (await f.send(observation(), { headers: { authorization: `Bearer ${replacement.token}` } })).json()).toEqual({ status: 'duplicate' })
	expect((await f.send()).status).toBe(401)
	f.store.revokeBearer(replacement.tokenId)
	expect(f.store.synchronization.observe(replacement.tokenId, observation())).toEqual({ error: 'unauthorized' })
	expect(f.read().state).toBe('fresh')
})

test('revocation/rotation between authentication and profile lookup returns 401 before parsing', async () => {
	for (const rotate of [false, true]) {
		const f = fixture()
		const pending = f.send('{')
		if (rotate) f.store.rotateBearer(f.token.tokenId)
		else f.store.revokeBearer(f.token.tokenId)
		const response = await pending
		expect(response.status).toBe(401)
		expect(response.headers.get('www-authenticate')).toBe('Bearer')
		expect(await response.json()).toEqual({ error: 'unauthorized' })
		expect(f.rows()).toEqual([])
	}
})

test('revocation/rotation committed during body read fail closed before acceptance or duplicate acknowledgement', async () => {
	for (const rotate of [false, true]) for (const existing of [false, true]) {
		const f = fixture()
		if (existing) await f.send()
		const before = f.rows()
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		let entered!: () => void
		const reading = new Promise<void>((resolve) => { entered = resolve })
		const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
			entered()
			await gate
			controller.enqueue(new TextEncoder().encode(JSON.stringify(observation())))
			controller.close()
		} })
		const pending = f.send(null, { body: stream })
		await reading
		if (rotate) f.store.rotateBearer(f.token.tokenId)
		else f.store.revokeBearer(f.token.tokenId)
		release()
		const response = await pending
		expect(response.status).toBe(401)
		expect(response.headers.get('www-authenticate')).toBe('Bearer')
		expect(await response.json()).toEqual({ error: 'unauthorized' })
		expect(f.rows()).toEqual(before)
	}
})

test('concurrent app revisions and two database connections cannot supersede the larger revision', async () => {
	for (const order of [[14, 15], [15, 14]]) {
		const f = fixture()
		const second = new ServiceStore(f.path, f.source)
		cleanup.push(() => second.close())
		const results = await Promise.all(order.map((observation_sequence) => f.send(observation({ observation_sequence }))))
		expect(await results[0]!.json()).toEqual({ status: 'accepted' })
		expect(await results[1]!.json()).toEqual(order[0] === 14 ? { status: 'accepted' } : reject('stale_observation'))
		expect(second.synchronization.observe(f.token.tokenId, observation({ observation_sequence: 14 }))).toEqual(reject('stale_observation'))
		f.time.now = 1200000
		expect(await (await f.send(observation({ observation_sequence: 14 }))).json()).toEqual(reject('stale_observation'))
		expect(f.rows()).toHaveLength(1)
		expect(f.rows()[0]).toMatchObject({ observation_sequence: 15, received_at_ms: 1000000 })
	}
})

test('separate writer processes serialize simultaneous replacement without stale overwrite', async () => {
	const f = fixture()
	const workers = [14, 15].map((sequence) => Bun.spawn([process.execPath, '-e', `
		import { ServiceStore } from ${JSON.stringify(join(import.meta.dir, 'store.ts'))};
		const store = new ServiceStore(${JSON.stringify(f.path)}, { now: () => 1000000, trusted: () => true });
		console.log('ready');
		await Bun.stdin.text();
		console.log(JSON.stringify(store.synchronization.observe(${JSON.stringify(f.token.tokenId)},
			${JSON.stringify(observation({ observation_sequence: sequence }))})));
		store.close();
	`], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }))
	await Promise.all(workers.map(async (worker) => {
		const reader = worker.stdout.getReader()
		expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe('ready')
		reader.releaseLock()
	}))
	for (const worker of workers) worker.stdin.end()
	const results = await Promise.all(workers.map(async (worker) => {
		const reader = worker.stdout.getReader()
		let output = ''
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			output += new TextDecoder().decode(value)
		}
		reader.releaseLock()
		expect(await worker.exited).toBe(0)
		expect(await new Response(worker.stderr).text()).toBe('')
		return JSON.parse(output)
	}))
	expect(results[1]).toEqual({ status: 'accepted' })
	expect([{ status: 'accepted' }, reject('stale_observation')]).toContainEqual(results[0])
	expect(f.rows()).toEqual([{ ...observation({ observation_sequence: 15 }), received_at_ms: 1000000, expires_at_ms: 1060000 }])
})

test('closed shape validates all fields before version, counts saturate independently and oldest permits skew', async () => {
	const f = fixture()
	const invalid: unknown[] = [null, [], 1, '"private"', { ...observation(), extra: 'private' }]
	for (const field of Object.keys(observation())) {
		const missing: Record<string, unknown> = { ...observation() }
		delete missing[field]
		invalid.push(missing, { ...observation(), [field]: {} })
	}
	for (const patch of [
		{ protocol_version: 0 }, { protocol_version: 1.5 }, { protocol_version: 9007199254740992 },
		{ collector_instance_id: id(1).replace('-4000-', '-5000-') },
		{ observation_sequence: 0 }, { observation_sequence: 1.5 }, { observation_sequence: 9007199254740992 },
		{ observed_at_ms: -1 }, { observed_at_ms: 253402300800000 },
		{ state: 'unknown' }, { state: 'clear' }, { records: -1 }, { records: 1.5 }, { records: 10001 },
		{ bytes: 0 }, { bytes: 8388609 }, { bytes: 1.5 }, { oldest_queued_at_ms: null },
		{ oldest_queued_at_ms: 1540001 }, { oldest_queued_at_ms: -1 }, { oldest_queued_at_ms: 0.5 },
		{ state: 'clear', records: 0, bytes: 1, oldest_queued_at_ms: null },
		{ state: 'queued', records: 0, bytes: 0, oldest_queued_at_ms: null },
		{ state: 'clear', records: 0, bytes: 0, oldest_queued_at_ms: 0 },
	]) invalid.push({ ...observation(), ...patch })
	for (const value of invalid) expect(await (await f.send(value)).json()).toEqual(reject('invalid_record'))
	expect(await (await f.send({ ...observation(), protocol_version: 2, bytes: 8388609 })).json()).toEqual(reject('invalid_record'))
	expect(await (await f.send({ ...observation(), protocol_version: 2 })).json()).toEqual(reject('unsupported_version'))
	for (const [index, patch] of [
		{ records: 10000, bytes: 1, oldest_queued_at_ms: 0 },
		{ records: 1, bytes: 8388607, oldest_queued_at_ms: 1540000 },
		{ records: 2, bytes: 8388608, state: 'blocked' as const },
		{ state: 'clear' as const, records: 0, bytes: 0, oldest_queued_at_ms: null },
	].entries()) {
		const payload = observation({ ...patch, observation_sequence: index + 1 })
		expect(await (await f.send(payload)).json()).toEqual({ status: 'accepted' })
		expect(f.rows()).toEqual([{ ...payload, received_at_ms: 1000000, expires_at_ms: 1060000 }])
	}
	expect(await (await f.send(observation({ observation_sequence: 9007199254740991 }))).json()).toEqual({ status: 'accepted' })
	expect(f.rows()).toHaveLength(1)
})

test('raw decimal lexemes reject fractional rounding/underflow but normalize exact integers', async () => {
	const f = fixture()
	const raw = JSON.stringify(observation())
	for (const [field, literal] of [
		['records', '3.0000000000000001'], ['protocol_version', '1.0000000000000001'],
		['observation_sequence', '8.0000000000000001'], ['bytes', '740.000000000000001'],
		['observed_at_ms', '940000.00000000001'], ['oldest_queued_at_ms', '1e-999'],
		['oldest_queued_at_ms', '-1e-999'], ['records', '1e999'],
	]) {
		const payload = raw.replace(new RegExp(`("${field}":)[^,}]+`), `$1${literal}`)
		expect(await (await f.send(payload)).json()).toEqual(reject('invalid_record'))
	}
	expect(f.rows()).toEqual([])
	for (const number of ['3.0', '3e0', '30e-1', '0.3e1', '300.000e-2']) {
		const response = await f.send(raw.replace('"records":3', `"records":${number}`))
		expect(await response.json()).toEqual({ status: number === '3.0' ? 'accepted' : 'duplicate' })
	}
	expect(await (await f.send('{"records":3.0000000000000001,"records":3}')).json()).toEqual({ error: 'invalid_json' })
	expect(f.rows()).toEqual([{ ...observation(), received_at_ms: 1000000, expires_at_ms: 1060000 }])
})

test('stream framing rejects duplicate decoded/nested keys, invalid UTF-8, trailing JSON and raw-byte overflow', async () => {
	const f = fixture()
	for (const text of ['{', '{}{}', '{"a":1,"a":2}', '{"a":1,"\\u0061":2}',
		'{"x":[{"a":1,"a":2}]}', '\ufeff{}', '{"a":NaN}']) {
		const response = await f.send(text)
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ error: 'invalid_json' })
	}
	expect(await (await f.send('{"x":[{"a":1},{"a":2}]}')).json()).toEqual(reject('invalid_record'))
	const utf8 = await f.send(null, { body: new Uint8Array([123, 34, 97, 34, 58, 34, 255, 34, 125]) })
	expect(await utf8.json()).toEqual({ error: 'invalid_json' })
	const encoded = new TextEncoder().encode(JSON.stringify(observation()).padEnd(1024, ' '))
	for (const extra of [0, 1]) {
		let cancelled = false
		const stream = new ReadableStream<Uint8Array>({ start(controller) {
			controller.enqueue(encoded.slice(0, 400))
			controller.enqueue(encoded.slice(400))
			if (extra) controller.enqueue(new Uint8Array([32]))
			else controller.close()
		}, cancel() { cancelled = true } })
		const response = await f.send(null, { body: stream, headers: { 'content-length': '1' } })
		expect(response.status).toBe(extra ? 413 : 200)
		expect(await response.json()).toEqual(extra ? { error: 'payload_too_large' } : { status: 'accepted' })
		if (extra) expect(cancelled).toBeTrue()
	}
	expect((await f.send('"' + 'é'.repeat(512) + '"')).status).toBe(413)
})

test('route errors and headers are closed; authentication/profile precede malformed bodies; logs allow only fixed event/status', async () => {
	const f = fixture()
	const unbound = f.store.issueBearer()
	const cases: Array<[RequestInit, string, number, string]> = [
		[{ headers: { authorization: '' } }, '', 401, 'unauthorized'],
		[{ headers: { authorization: 'Bearer invalid' } }, '', 401, 'unauthorized'],
		[{ headers: { authorization: 'Bearer oidc' } }, '', 403, 'physical_bearer_required'],
		[{ headers: { authorization: `Bearer ${unbound.token}` } }, '', 403, 'executor_profile_required'],
		[{ method: 'PUT' }, '', 405, 'method_not_allowed'],
		[{}, '?private=value', 400, 'invalid_request'],
		[{}, '/private', 404, 'not_found'],
		...['text/plain', 'application/json; charset=latin1', 'application/json; private=x',
			'application/json; charset=utf-8; charset=utf-8'].map((type): [RequestInit, string, number, string] =>
			[{ headers: { 'content-type': type } }, '', 415, 'unsupported_media_type']),
		[{ headers: { 'content-encoding': 'identity' } }, '', 415, 'unsupported_media_type'],
		[{ headers: { 'content-encoding': '' } }, '', 415, 'unsupported_media_type'],
	]
	for (const [init, suffix, status, error] of cases) {
		const response = await f.send('{', init, `https://api.cukup.dev/v1/shadow-synchronization${suffix}`)
		expect(response.status).toBe(status)
		expect(await response.json()).toEqual({ error })
		expect(response.headers.get('content-type')).toContain('application/json')
		expect(response.headers.get('cache-control')).toBe('no-store')
		if (status === 401) expect(response.headers.get('www-authenticate')).toBe('Bearer')
		if (status === 405) expect(response.headers.get('allow')).toBe('POST')
	}
	for (const host of ['private.invalid', 'cukup.dev']) {
		expect(await (await f.send('{', {}, `https://${host}/v1/shadow-synchronization`)).json()).toEqual({ error: 'not_found' })
	}
	expect(await (await f.send('{', {}, 'http://api.cukup.dev/v1/shadow-synchronization')).json()).toEqual({ error: 'secure_transport_required' })
	expect(await (await f.send(observation(), { headers: { 'content-type': 'application/json; charset="UTF-8"' } })).json()).toEqual({ status: 'accepted' })
	for (const line of f.logs) {
		const log = JSON.parse(line)
		expect(Object.keys(log).sort()).toEqual(['event', 'level', 'status'])
		expect(log).toMatchObject({ event: 'shadow_synchronization', level: 'info' })
	}
})

test('insert/update rollback never acknowledges, failed reads are unknown and errors never leak diagnostics', async () => {
	const f = fixture()
	for (const operation of ['INSERT', 'UPDATE']) {
		const before = f.rows()
		f.raw.exec(`CREATE TRIGGER fail_sync BEFORE ${operation} ON shadow_synchronization
			BEGIN SELECT RAISE(ABORT, 'private sentinel'); END`)
		const response = await f.send(observation({ observation_sequence: operation === 'INSERT' ? 8 : 9 }))
		expect(response.status).toBe(500)
		expect(await response.json()).toEqual({ error: 'internal_error' })
		expect(f.rows()).toEqual(before)
		f.raw.exec('DROP TRIGGER fail_sync')
		expect(await (await f.send()).json()).toEqual(operation === 'INSERT' ? { status: 'accepted' } : { status: 'duplicate' })
	}
	expect(f.logs.every((line) => Object.keys(JSON.parse(line)).length === 3)).toBeTrue()
	expect(f.logs.join('')).not.toContain('private')
	f.raw.exec('DROP TABLE shadow_synchronization')
	expect(f.read()).toEqual({ state: 'unknown' })
})

test('v7 migration is additive, transactional, empty, restart safe and future refusing; existing rows and projections unchanged', async () => {
	const f = fixture()
	const principal = f.store.authenticateBearer(f.token.token)!
	for (const schemaVersion of [1, 2] as const) {
		expect(f.store.ingest(principal, { schemaVersion, eventId: id(30 + schemaVersion), sourceInstance: id(50),
			sourceSequence: schemaVersion, sessionId: id(60 + schemaVersion), kind: 'agent.start',
			occurredAt: new Date(900000).toISOString(), occurredAtMs: 900000,
			...(schemaVersion === 2 ? { projectSlug: 'cukup' } : {}) }, 1000000).outcome).toBe('accepted')
	}
	expect(f.store.shadow.appendCoverage({ executionSiteId: f.site, sourceSequence: 13, envelope: {
		protocol: LOCAL_PROTOCOL, protocol_version: 1, collector_instance_id: id(1), capabilities: [...CAPABILITIES],
		fact: { family: 'capability_declaration', fact_id: id(90), effective_at: new Date(900000).toISOString() },
	} }, 1000000).status).toBe('accepted')
	f.store.putTargetOverride('2026-09-14', 240, 1000000)
	const snapshot = () => ({
		schema: f.raw.query("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE tbl_name != 'shadow_synchronization' ORDER BY name").all(),
		rows: ['auth_tokens', 'source_owners', 'events', 'target_overrides', 'shadow_collectors', 'shadow_evidence', 'shadow_coverage']
			.map((table) => f.raw.query(`SELECT * FROM ${table} ORDER BY rowid`).all()),
	})
	const before = snapshot()
	const disclosure = () => projectShadowDisclosures(f.store.shadow.records(), f.store.shadow.coverageRecords(), { startMs: 0, endMs: 2000000 })
	const disclosureBefore = disclosure()
	const summaryBefore = await (await f.app.fetch(new Request('https://api.cukup.dev/v1/summary', { headers: { authorization: `Bearer ${f.token.token}` } }))).json()
	f.raw.exec('DROP TABLE shadow_synchronization; PRAGMA user_version = 7')
	// Fail after synchronization CREATE TABLE at the next existing-index DDL statement.
	f.raw.exec('DROP INDEX source_owners_bearer_owner; CREATE TABLE source_owners_bearer_owner (sentinel TEXT)')
	expect(() => new ServiceStore(f.path, f.source)).toThrow()
	expect(f.raw.query('PRAGMA user_version').get()).toEqual({ user_version: 7 })
	expect(f.raw.query("SELECT name FROM sqlite_schema WHERE tbl_name = 'shadow_synchronization'").all()).toEqual([])
	f.raw.exec("DROP TABLE source_owners_bearer_owner; CREATE INDEX source_owners_bearer_owner ON source_owners(owner_id) WHERE owner_kind = 'bearer'")
	// Preserve the original schema spelling for the byte-exact comparison.
	const repairedBefore = snapshot()
	for (let restart = 0; restart < 2; restart++) {
		const migrated = new ServiceStore(f.path, f.source)
		expect(f.raw.query('PRAGMA user_version').get()).toEqual({ user_version: 8 })
		expect(snapshot()).toEqual(repairedBefore)
		expect(f.rows()).toEqual([])
		migrated.close()
	}
	expect(snapshot().rows).toEqual(before.rows)
	expect(await (await f.send()).json()).toEqual({ status: 'accepted' })
	const saved = f.rows()
	const restarted = new ServiceStore(f.path, f.source)
	expect(restarted.synchronization.observe(f.token.tokenId, observation())).toEqual({ status: 'duplicate' })
	expect(f.rows()).toEqual(saved)
	restarted.close()
	expect(disclosure()).toEqual(disclosureBefore)
	expect(disclosure().every((lane) => lane.synchronization === 'unknown')).toBeTrue()
	expect(await (await f.app.fetch(new Request('https://api.cukup.dev/v1/summary', { headers: { authorization: `Bearer ${f.token.token}` } }))).json()).toEqual(summaryBefore)
	expect(snapshot()).toEqual(repairedBefore)
	expect(f.raw.query('PRAGMA foreign_key_check').all()).toEqual([])
	f.raw.exec('PRAGMA user_version = 9')
	expect(() => new ServiceStore(f.path)).toThrow('newer than supported')
	expect(f.raw.query('PRAGMA user_version').get()).toEqual({ user_version: 9 })
	expect(f.rows()).toEqual(saved)
})
