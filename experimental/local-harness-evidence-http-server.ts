import { timingSafeEqual } from 'node:crypto'
import { LOCAL_PROTOCOL } from './local-harness-evidence.ts'
import type { LocalHarnessEvidenceReceiver } from './local-harness-evidence-receiver.ts'

export const LOCAL_HARNESS_EVIDENCE_MAX_BODY_BYTES = 1024 * 1024
export const LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH =
	'/experimental/local-harness-evidence/negotiate'
export const LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH =
	'/experimental/local-harness-evidence/evidence'

const LOOPBACK_HOSTNAME = '127.0.0.1'
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const TOO_LARGE = Symbol('too_large')
const INVALID_BODY = Symbol('invalid_body')

type ParsedBody = Record<string, unknown> | typeof TOO_LARGE | typeof INVALID_BODY

export type LocalHarnessEvidenceHttpServer = Readonly<{
	hostname: typeof LOOPBACK_HOSTNAME
	port: number
	stop: () => Promise<void>
}>

export type LocalHarnessEvidenceHttpServerOptions = Readonly<{
	receiver: LocalHarnessEvidenceReceiver
	token: string
	port?: number
}>

/**
 * Starts the experimental transport on IPv4 loopback. The caller owns and closes the receiver;
 * stopping this server closes only its HTTP listener.
 */
export function startLocalHarnessEvidenceHttpServer(
	options: LocalHarnessEvidenceHttpServerOptions,
): LocalHarnessEvidenceHttpServer {
	if (!isLocalHarnessEvidenceReceiverToken(options.token)) {
		throw new Error('Receiver token must be 32 random bytes encoded as unpadded base64url')
	}
	const expectedAuthorization = Buffer.from(`Bearer ${options.token}`)
	const server = Bun.serve({
		hostname: LOOPBACK_HOSTNAME,
		port: options.port ?? 0,
		development: false,
		reusePort: false,
		maxRequestBodySize: Number.MAX_SAFE_INTEGER,
		fetch: async (request) => {
			if (!isAuthorized(request, expectedAuthorization)) return json({ error: 'unauthorized' }, 401)

			const path = new URL(request.url).pathname
			if (
				path !== LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH &&
				path !== LOCAL_HARNESS_EVIDENCE_SUBMISSION_PATH
			) {
				return json({ error: 'not_found' }, 404)
			}
			if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
			if (mediaType(request.headers.get('content-type')) !== 'application/json') {
				return json({ error: 'unsupported_media_type' }, 415)
			}

			const declaredLength = request.headers.get('content-length')
			if (declaredLength !== null) {
				if (!/^\d+$/.test(declaredLength)) return json({ error: 'invalid_request' }, 400)
				if (BigInt(declaredLength) > BigInt(LOCAL_HARNESS_EVIDENCE_MAX_BODY_BYTES)) {
					return json({ error: 'request_too_large' }, 413)
				}
			}

			const body = await readJsonObject(request)
			if (body === TOO_LARGE) return json({ error: 'request_too_large' }, 413)
			if (body === INVALID_BODY) return json({ error: 'invalid_request' }, 400)

			try {
				if (path === LOCAL_HARNESS_EVIDENCE_NEGOTIATION_PATH) {
					const outcome = options.receiver.negotiate(body)
					if (outcome.status === 'accepted') {
						return json({ protocol: LOCAL_PROTOCOL, selected_version: outcome.selectedVersion }, 200)
					}
					if (outcome.status === 'unsupported_version') {
						return json(
							{
								protocol: LOCAL_PROTOCOL,
								unsupported_versions: true,
								supported_versions: outcome.supportedVersions,
							},
							200,
						)
					}
					return outcome.reason === 'collector_binding_conflict'
						? json({ error: 'collector_binding_conflict' }, 409)
						: json({ error: 'invalid_request' }, 400)
				}

				return json({ outcomes: options.receiver.submitAuthenticated(body) }, 200)
			} catch {
				return serviceUnavailable()
			}
		},
		error: () => serviceUnavailable(),
	})

	return Object.freeze({
		hostname: LOOPBACK_HOSTNAME,
		port: server.port!,
		stop: () => server.stop(true),
	})
}

/** Validates the shared strict receiver-token representation without retaining or reflecting it. */
export function isLocalHarnessEvidenceReceiverToken(value: string): boolean {
	if (!TOKEN.test(value)) return false
	const decoded = Buffer.from(value, 'base64url')
	return decoded.byteLength === 32 && decoded.toString('base64url') === value
}

function isAuthorized(request: Request, expected: Buffer): boolean {
	const supplied = request.headers.get('authorization')
	if (supplied === null) return false
	const suppliedBytes = Buffer.from(supplied)
	if (suppliedBytes.byteLength !== expected.byteLength) return false
	return timingSafeEqual(suppliedBytes, expected)
}

function mediaType(value: string | null): string | undefined {
	return value?.split(';', 1)[0]?.trim().toLowerCase()
}

async function readJsonObject(request: Request): Promise<ParsedBody> {
	if (request.body === null) return INVALID_BODY
	const reader = request.body.getReader()
	const chunks: Uint8Array[] = []
	let length = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			length += value.byteLength
			if (length > LOCAL_HARNESS_EVIDENCE_MAX_BODY_BYTES) {
				void reader.cancel().catch(() => undefined)
				return TOO_LARGE
			}
			chunks.push(value)
		}
	} catch {
		return INVALID_BODY
	}
	if (length === 0) return INVALID_BODY

	const bytes = new Uint8Array(length)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	try {
		const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: INVALID_BODY
	} catch {
		return INVALID_BODY
	}
}

function json(value: object, status: number): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			'cache-control': 'no-store',
			'content-type': 'application/json; charset=utf-8',
		},
	})
}

function serviceUnavailable(): Response {
	return new Response(JSON.stringify({ error: 'service_unavailable' }), {
		status: 503,
		headers: {
			'cache-control': 'no-store',
			'content-type': 'application/json; charset=utf-8',
			'retry-after': '1',
		},
	})
}
