import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	LOCAL_HARNESS_EVIDENCE_MAX_BODY_BYTES,
	LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH,
	LOCAL_HARNESS_EVIDENCE_READINESS_PATH,
	LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH,
	startLocalHarnessEvidenceHttpServer,
	type LocalHarnessEvidenceHttpServer,
} from './local-harness-evidence-http-server.ts'
import { LocalHarnessEvidenceReceiver } from './local-harness-evidence-receiver.ts'
import { LOCAL_PROTOCOL, LOCAL_PROTOCOL_VERSION, type Capability } from './local-harness-evidence.ts'

const SITE_A = '10000000-0000-4000-8000-000000000001'
const SITE_B = '10000000-0000-4000-8000-000000000002'
const COLLECTOR = '20000000-0000-4000-8000-000000000001'
const PROJECT = '30000000-0000-4000-8000-000000000001'

const directories: string[] = []
const servers: LocalHarnessEvidenceHttpServer[] = []
const receivers: LocalHarnessEvidenceReceiver[] = []

afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop()
	for (const receiver of receivers.splice(0)) receiver.close()
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function setup(site = SITE_A, path = databasePath()) {
	const receiver = new LocalHarnessEvidenceReceiver(path, site)
	receivers.push(receiver)
	const token = randomBytes(32).toString('base64url')
	const server = startLocalHarnessEvidenceHttpServer({ receiver, token })
	servers.push(server)
	return { path, receiver, token, server, origin: `http://${server.hostname}:${server.port}` }
}

function databasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), 'cukup-http-receiver-'))
	directories.push(directory)
	return join(directory, 'receiver.sqlite')
}

function offer(capabilities: Capability[]) {
	return {
		protocol: LOCAL_PROTOCOL,
		supported_versions: [LOCAL_PROTOCOL_VERSION],
		collector_instance_id: COLLECTOR,
		capabilities,
	}
}

function envelope(capabilities: Capability[], evidence: unknown[], version: number = LOCAL_PROTOCOL_VERSION) {
	return {
		protocol: LOCAL_PROTOCOL,
		protocol_version: version,
		collector_instance_id: COLLECTOR,
		capabilities,
		evidence,
	}
}

function engagement(
	evidenceId: string,
	interaction: 'submission' | 'approval' | 'follow_up' = 'submission',
) {
	return {
		family: 'engagement',
		evidence_id: evidenceId,
		interaction,
		origin: 'human',
		recovered: false,
		timing: {
			wall_time: '2026-09-10T02:00:00.000Z',
			provenance: 'collector_observation',
			precision_ms: 1,
		},
		project_attribution: { kind: 'cukup_project', project_id: PROJECT, basis: 'approved_mapping' },
	}
}

function start(evidenceId: string, segmentId: string) {
	return {
		family: 'execution_start',
		evidence_id: evidenceId,
		segment_id: segmentId,
		recovered: false,
		timing: {
			wall_time: '2026-09-10T02:00:00.000Z',
			provenance: 'native_occurrence',
			precision_ms: 1,
		},
		project_attribution: { kind: 'unassigned', reason: 'absent' },
	}
}

function end(evidenceId: string, segmentId: string) {
	return {
		family: 'execution_end',
		evidence_id: evidenceId,
		segment_id: segmentId,
		recovered: false,
		timing: {
			wall_time: '2026-09-10T02:05:00.000Z',
			provenance: 'native_occurrence',
			precision_ms: 1,
		},
	}
}

async function request(
	origin: string,
	path: string,
	token: string | undefined,
	body: BodyInit | null,
	init: { method?: string; contentType?: string } = {},
) {
	const headers = new Headers()
	if (token !== undefined) headers.set('authorization', `Bearer ${token}`)
	if (init.contentType !== undefined) headers.set('content-type', init.contentType)
	const response = await fetch(`${origin}${path}`, {
		method: init.method ?? 'POST',
		headers,
		body,
	})
	const text = await response.text()
	return {
		status: response.status,
		text,
		body: JSON.parse(text) as Record<string, unknown>,
		retryAfter: response.headers.get('retry-after'),
	}
}

async function post(origin: string, path: string, token: string, body: unknown) {
	return request(origin, path, token, JSON.stringify(body), { contentType: 'application/json' })
}

function count(path: string, table: string): number {
	const database = new Database(path, { readonly: true, strict: true })
	try {
		return database.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()!.count
	} finally {
		database.close()
	}
}

function rawHttp(port: number, requestBytes: string | Uint8Array) {
	return new Promise<{ status: number; text: string; body: Record<string, unknown> }>(
		(resolve, reject) => {
			let response = Buffer.alloc(0)
			let settled = false
			const socket = createConnection({ host: '127.0.0.1', port }, () => socket.write(requestBytes))
			const fail = (error: Error) => {
				if (settled) return
				settled = true
				socket.destroy()
				reject(error)
			}
			socket.setTimeout(3_000, () => fail(new Error('HTTP response timed out')))
			socket.on('error', fail)
			socket.on('data', (chunk) => {
				response = Buffer.concat([response, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
				const headerEnd = response.indexOf('\r\n\r\n')
				if (headerEnd < 0) return
				const headers = response.subarray(0, headerEnd).toString('utf8')
				const length = /\r\ncontent-length:\s*(\d+)/i.exec(headers)?.[1]
				if (length === undefined || response.byteLength < headerEnd + 4 + Number(length)) return
				const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(headers)?.[1])
				const text = response.subarray(headerEnd + 4, headerEnd + 4 + Number(length)).toString('utf8')
				settled = true
				socket.destroy()
				resolve({ status, text, body: JSON.parse(text) as Record<string, unknown> })
			})
		},
	)
}

function rawPostHeaders(port: number, contentLength: number, authorization?: string): string {
	return [
		`POST ${LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH} HTTP/1.1`,
		`Host: 127.0.0.1:${port}`,
		'Content-Type: application/json',
		`Content-Length: ${contentLength}`,
		...(authorization === undefined ? [] : [`Authorization: ${authorization}`]),
		'Connection: close',
		'',
		'',
	].join('\r\n')
}

describe('experimental local Harness evidence HTTP server', () => {
	test('exposes exact side-effect-free readiness only to the canonical bearer', async () => {
		const { origin, token } = setup()
		const wrongToken = randomBytes(32).toString('base64url')
		for (const authorization of [undefined, `Bearer ${wrongToken}`]) {
			const response = await fetch(`${origin}${LOCAL_HARNESS_EVIDENCE_READINESS_PATH}`, {
				headers: authorization === undefined ? {} : { authorization },
			})
			expect(response.status).toBe(401)
			expect(await response.text()).toBe('{"error":"unauthorized"}')
		}
		const response = await fetch(`${origin}${LOCAL_HARNESS_EVIDENCE_READINESS_PATH}`, {
			headers: { authorization: `Bearer ${token}` },
		})
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
		expect(await response.text()).toBe(
			'{"protocol":"cukup.experimental.harness-evidence","protocol_version":1,"ready":true}',
		)
	})

	test('binds only IPv4 loopback, reports its ephemeral port, and stops without closing the receiver', async () => {
		const { origin, receiver, server } = setup()
		expect(server.hostname).toBe('127.0.0.1')
		expect(server.port).toBeGreaterThan(0)
		expect((await fetch(origin)).status).toBe(401)
		expect((await fetch(`${origin}/bun:info`)).status).toBe(401)
		expect(
			(
				await fetch(`${origin}/bun:info`, {
					headers: { authorization: `Bearer ${randomBytes(32).toString('base64url')}` },
				})
			).status,
		).toBe(401)
		await expect(fetch(`http://[::1]:${server.port}`)).rejects.toThrow()
		expect(() =>
			startLocalHarnessEvidenceHttpServer({ receiver, token: 'a'.repeat(43) }),
		).toThrow('Receiver token must be 32 random bytes encoded as unpadded base64url')

		await server.stop()
		servers.splice(servers.indexOf(server), 1)
		await expect(fetch(origin)).rejects.toThrow()
		expect(receiver.negotiate(offer(['engagement.submission'])).status).toBe('accepted')
	})

	test('requires strict bearer authentication before disclosing route, method, or media rules', async () => {
		const { origin, token } = setup()
		const wrongToken = randomBytes(32).toString('base64url')
		const attempts = await Promise.all([
			request(origin, '/not-a-route', undefined, null, { method: 'GET' }),
			request(origin, LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH, wrongToken, '{}', {
				contentType: 'text/plain',
			}),
			request(origin, `${LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH}?access=${token}`, undefined, null),
			fetch(`${origin}${LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH}`, {
				method: 'POST',
				headers: { cookie: `receiver=${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ authorization: token }),
			}).then(async (response) => ({
				status: response.status,
				text: await response.text(),
				body: {},
			})),
		])
		for (const attempt of attempts) {
			expect(attempt.status).toBe(401)
			expect(attempt.text).toBe('{"error":"unauthorized"}')
			expect(attempt.text).not.toContain(token)
			expect(attempt.text).not.toContain(wrongToken)
		}
		const authenticatedDevelopmentRoute = await fetch(`${origin}/bun:info`, {
			headers: { authorization: `Bearer ${token}` },
		})
		expect(authenticatedDevelopmentRoute.status).toBe(404)
		expect(await authenticatedDevelopmentRoute.text()).toBe('{"error":"not_found"}')
	})

	test('persists negotiation snapshots and supports restart-safe replay and pending closure', async () => {
		const path = databasePath()
		const capabilitiesA: Capability[] = ['engagement.submission', 'execution.segments']
		const capabilitiesB: Capability[] = [...capabilitiesA, 'engagement.approval']
		const first = setup(SITE_A, path)
		expect(
			(
				await post(first.origin, LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH, first.token, {
					...offer(capabilitiesA),
					supported_versions: [2],
				})
			).body,
		).toEqual({
			protocol: LOCAL_PROTOCOL,
			unsupported_versions: true,
			supported_versions: [LOCAL_PROTOCOL_VERSION],
		})
		for (const capabilities of [capabilitiesA, capabilitiesB]) {
			expect(
				await post(first.origin, LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH, first.token, offer(capabilities)),
			).toMatchObject({
				status: 200,
				body: { protocol: LOCAL_PROTOCOL, selected_version: LOCAL_PROTOCOL_VERSION },
			})
		}
		const replayed = engagement('40000000-0000-4000-8000-000000000001')
		const segmentId = '50000000-0000-4000-8000-000000000001'
		const pending = start('40000000-0000-4000-8000-000000000002', segmentId)
		expect(
			(
				await post(
					first.origin,
					LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH,
					first.token,
					envelope(capabilitiesA, [replayed, pending]),
				)
			).body,
		).toEqual({
			outcomes: [
				{ evidence_id: replayed.evidence_id, status: 'accepted' },
				{ evidence_id: pending.evidence_id, status: 'accepted' },
			],
		})
		await first.server.stop()
		servers.splice(servers.indexOf(first.server), 1)
		first.receiver.close()
		receivers.splice(receivers.indexOf(first.receiver), 1)

		const second = setup(SITE_A, path)
		const closing = end('40000000-0000-4000-8000-000000000003', segmentId)
		expect(
			(
				await post(
					second.origin,
					LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH,
					second.token,
					envelope(capabilitiesA, [replayed, closing]),
				)
			).body,
		).toEqual({
			outcomes: [
				{ evidence_id: replayed.evidence_id, status: 'duplicate' },
				{ evidence_id: closing.evidence_id, status: 'accepted' },
			],
		})
		const approval = engagement('40000000-0000-4000-8000-000000000004', 'approval')
		expect(
			(
				await post(
					second.origin,
					LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH,
					second.token,
					envelope(capabilitiesB, [approval]),
				)
			).body,
		).toEqual({ outcomes: [{ evidence_id: approval.evidence_id, status: 'accepted' }] })
		expect(count(path, 'negotiations')).toBe(2)
		expect(count(path, 'accepted_evidence')).toBe(4)
		const database = new Database(path, { readonly: true, strict: true })
		expect(
			database.query<{ endAt: string | null }, []>('SELECT end_at AS endAt FROM execution_segments').get()!
				.endAt,
		).toBe('2026-09-10T02:05:00.000Z')
		database.close()
	})

	test('rejects opportunistic capabilities, transport binding fields, and a different receiver site', async () => {
		const path = databasePath()
		const capabilities: Capability[] = ['engagement.submission']
		const first = setup(SITE_A, path)
		await post(first.origin, LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH, first.token, offer(capabilities))
		const changed: Capability[] = [...capabilities, 'engagement.follow_up']
		const opportunistic = await post(
			first.origin,
			LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH,
			first.token,
			envelope(changed, [engagement('41000000-0000-4000-8000-000000000001', 'follow_up')]),
		)
		expect(opportunistic.body).toEqual({
			outcomes: [{ scope: 'envelope', status: 'rejected', reason: 'invalid_envelope' }],
		})
		const bindingField = await post(
			first.origin,
			LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH,
			first.token,
			{ ...envelope(capabilities, []), execution_site_id: SITE_A },
		)
		expect(bindingField.body).toEqual({
			outcomes: [{ scope: 'envelope', status: 'rejected', reason: 'unknown_field' }],
		})
		await first.server.stop()
		servers.splice(servers.indexOf(first.server), 1)
		first.receiver.close()
		receivers.splice(receivers.indexOf(first.receiver), 1)

		const second = setup(SITE_B, path)
		const wrongSite = await post(
			second.origin,
			LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH,
			second.token,
			envelope(capabilities, [engagement('41000000-0000-4000-8000-000000000002')]),
		)
		expect(wrongSite.body).toEqual({
			outcomes: [{ scope: 'envelope', status: 'rejected', reason: 'invalid_envelope' }],
		})
		expect(count(path, 'accepted_evidence')).toBe(0)
	})

	test('keeps unsupported versions envelope-level and does not expose prohibited evidence', async () => {
		const { origin, path, token } = setup()
		const sensitive = 'private-marker-that-must-not-escape'
		const response = await post(
			origin,
			LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH,
			token,
			envelope(['engagement.submission'], [{ prompt: sensitive, native_id: sensitive }], 2),
		)
		expect(response.body).toEqual({
			outcomes: [
				{ scope: 'envelope', status: 'unsupported_version', reason: 'unsupported_version' },
			],
		})
		expect(response.text).not.toContain(sensitive)
		expect(response.text).not.toContain(token)
		expect(count(path, 'accepted_evidence')).toBe(0)
	})

	test('does not reflect invalid evidence identities or prohibited values', async () => {
		const { origin, path, token } = setup()
		const capabilities: Capability[] = ['engagement.submission']
		await post(origin, LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH, token, offer(capabilities))
		const sensitive = 'private-native-id-or-token'
		const response = await post(
			origin,
			LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH,
			token,
			envelope(capabilities, [
				{ ...engagement(sensitive), prompt: sensitive },
				{ family: sensitive, evidence_id: sensitive },
			]),
		)
		expect(response.body).toEqual({
			outcomes: [
				{ evidence_id: '', status: 'rejected', reason: 'prohibited_field' },
				{ evidence_id: '', status: 'rejected', reason: 'invalid_evidence' },
			],
		})
		expect(response.text).not.toContain(sensitive)
		expect(response.text).not.toContain(token)
		expect(count(path, 'accepted_evidence')).toBe(0)
	})

	test('returns fixed framing errors for bad methods, paths, media, JSON, and bounded bodies', async () => {
		const { origin, path, token } = setup()
		const cases = [
			await request(origin, '/experimental/local-harness-evidence/missing', token, '{}', {
				contentType: 'application/json',
			}),
			await request(origin, LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH, token, null, {
				method: 'GET',
			}),
			await request(origin, LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH, token, '{}', {
				contentType: 'text/plain',
			}),
			await request(origin, LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH, token, '', {
				contentType: 'application/json',
			}),
			await request(origin, LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH, token, '{', {
				contentType: 'application/json',
			}),
			await request(origin, LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH, token, '[]', {
				contentType: 'application/json',
			}),
		]
		expect(cases.map(({ status, body }) => ({ status, body }))).toEqual([
			{ status: 404, body: { error: 'not_found' } },
			{ status: 405, body: { error: 'method_not_allowed' } },
			{ status: 415, body: { error: 'unsupported_media_type' } },
			{ status: 400, body: { error: 'invalid_request' } },
			{ status: 400, body: { error: 'invalid_request' } },
			{ status: 400, body: { error: 'invalid_request' } },
		])

		const declared = await request(
			origin,
			LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH,
			token,
			'x'.repeat(LOCAL_HARNESS_EVIDENCE_MAX_BODY_BYTES + 1),
			{ contentType: 'application/json' },
		)
		expect(declared).toMatchObject({ status: 413, body: { error: 'request_too_large' } })
		const exactlyAtLimit = `{"padding":"${'a'.repeat(
			LOCAL_HARNESS_EVIDENCE_MAX_BODY_BYTES - '{"padding":""}'.length,
		)}"}`
		expect(Buffer.byteLength(exactlyAtLimit)).toBe(LOCAL_HARNESS_EVIDENCE_MAX_BODY_BYTES)
		expect(
			await request(origin, LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH, token, exactlyAtLimit, {
				contentType: 'application/json',
			}),
		).toMatchObject({ status: 400, body: { error: 'invalid_request' } })

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(LOCAL_HARNESS_EVIDENCE_MAX_BODY_BYTES))
				controller.enqueue(new Uint8Array([1]))
				controller.close()
			},
		})
		const streamed = await request(
			origin,
			LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH,
			token,
			stream,
			{ contentType: 'application/json' },
		)
		expect(streamed).toMatchObject({ status: 413, body: { error: 'request_too_large' } })
		expect(count(path, 'collectors')).toBe(0)
		expect(count(path, 'accepted_evidence')).toBe(0)
	})

	test('authenticates huge declarations and rejects unterminated chunked oversize bodies itself', async () => {
		const { server, token } = setup()
		const aboveBunDefault = 128 * 1024 * 1024 + 1
		const missing = await rawHttp(server.port, rawPostHeaders(server.port, aboveBunDefault))
		const wrong = await rawHttp(
			server.port,
			rawPostHeaders(server.port, aboveBunDefault, `Bearer ${randomBytes(32).toString('base64url')}`),
		)
		for (const response of [missing, wrong]) {
			expect(response.status).toBe(401)
			expect(response.text).toBe('{"error":"unauthorized"}')
		}
		const authenticated = await rawHttp(
			server.port,
			rawPostHeaders(server.port, aboveBunDefault, `Bearer ${token}`),
		)
		expect(authenticated).toMatchObject({
			status: 413,
			body: { error: 'request_too_large' },
		})

		const headers = [
			`POST ${LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH} HTTP/1.1`,
			`Host: 127.0.0.1:${server.port}`,
			'Content-Type: application/json',
			`Authorization: Bearer ${token}`,
			'Transfer-Encoding: chunked',
			'Connection: close',
			'',
			'',
		].join('\r\n')
		const firstChunk = Buffer.alloc(LOCAL_HARNESS_EVIDENCE_MAX_BODY_BYTES)
		const unterminated = Buffer.concat([
			Buffer.from(headers),
			Buffer.from(`${firstChunk.byteLength.toString(16)}\r\n`),
			firstChunk,
			Buffer.from('\r\n1\r\nx\r\n'),
		])
		const streamed = await rawHttp(server.port, unterminated)
		expect(streamed).toMatchObject({ status: 413, body: { error: 'request_too_large' } })
	}, 5_000)

	test('turns a SQLite failure into one retryable response and rolls back all records', async () => {
		const { origin, path, token } = setup()
		const capabilities: Capability[] = ['execution.segments']
		await post(origin, LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH, token, offer(capabilities))
		const failingId = '42000000-0000-4000-8000-000000000002'
		const injector = new Database(path, { strict: true })
		injector.exec(`
			CREATE TRIGGER inject_http_storage_failure BEFORE INSERT ON accepted_evidence
			WHEN NEW.evidence_id = '${failingId}'
			BEGIN SELECT RAISE(FAIL, 'private database diagnostic'); END
		`)
		injector.close()
		const response = await post(
			origin,
			LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH,
			token,
			envelope(capabilities, [
				start('42000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000001'),
				start(failingId, '52000000-0000-4000-8000-000000000002'),
			]),
		)
		expect(response.status).toBe(503)
		expect(response.body).toEqual({ error: 'service_unavailable' })
		expect(response.retryAfter).toBe('1')
		expect(response.text).not.toContain('outcomes')
		expect(response.text).not.toContain('private database diagnostic')
		expect(response.text).not.toContain(token)
		expect(count(path, 'accepted_evidence')).toBe(0)
		expect(count(path, 'execution_segments')).toBe(0)
	})
})
