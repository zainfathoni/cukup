import { summarizeWork } from './aggregation.ts'
import { isBearerToken, type OidcVerifier } from './auth.ts'
import { ServiceLogger } from './logger.ts'
import {
	MAX_REQUEST_BYTES,
	batchResult,
	parseBatch,
	type BatchResult,
} from './protocol.ts'
import { ServiceStore } from './store.ts'
import type { Principal } from './types.ts'

type OidcVerification = Pick<OidcVerifier, 'verify'>

type AppOptions = {
	store: ServiceStore
	oidcVerifier: OidcVerification
	now?: () => number
	logger?: ServiceLogger
	requireHttps?: boolean
	trustTlsProxy?: boolean
}

export function createApp(options: AppOptions): { fetch(request: Request): Promise<Response> } {
	const now = options.now ?? Date.now
	const logger = options.logger ?? new ServiceLogger()
	const requireHttps = options.requireHttps ?? true
	const trustTlsProxy = options.trustTlsProxy ?? false

	return {
		async fetch(request: Request): Promise<Response> {
			const startedAt = performance.now()
			const url = new URL(request.url)
			let response: Response
			try {
				if (url.pathname === '/healthz') {
					response =
						request.method === 'GET'
							? json({ ok: true })
							: json({ error: 'method_not_allowed' }, 405, { allow: 'GET' })
				} else if (url.pathname.startsWith('/v1/')) {
					if (requireHttps && !isSecureRequest(request, trustTlsProxy)) {
						response = json({ error: 'secure_transport_required' }, 400)
					} else {
						const principal = await authenticate(request, options.store, options.oidcVerifier)
						response = principal
							? await authenticatedResponse(request, url, principal, options.store, now)
							: json(
									{ error: 'unauthorized' },
									401,
									{ 'www-authenticate': 'Bearer' },
								)
					}
				} else {
					response = json({ error: 'not_found' }, 404)
				}
			} catch (error) {
				logger.error('request_failed', {
					method: request.method,
					path: logPath(url.pathname),
					error: error instanceof Error ? error.name : 'unknown',
				})
				response = json({ error: 'internal_error' }, 500)
			}
			logger.info('request', {
				method: request.method,
				path: logPath(url.pathname),
				status: response.status,
				duration_ms: Math.round(performance.now() - startedAt),
			})
			return response
		},
	}
}

async function authenticatedResponse(
	request: Request,
	url: URL,
	principal: Principal,
	store: ServiceStore,
	now: () => number,
): Promise<Response> {
	if (url.pathname === '/v1/time') {
		return request.method === 'GET'
			? json({ server_time: new Date(now()).toISOString() })
			: json({ error: 'method_not_allowed' }, 405, { allow: 'GET' })
	}
	if (url.pathname === '/v1/summary') {
		return request.method === 'GET'
			? json(summarizeWork(store.events(), now()))
			: json({ error: 'method_not_allowed' }, 405, { allow: 'GET' })
	}
	if (url.pathname === '/v1/events:batch') {
		if (request.method !== 'POST') {
			return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' })
		}
		if (
			request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
			'application/json'
		) {
			return json({ error: 'unsupported_media_type' }, 415)
		}
		const contentLength = Number(request.headers.get('content-length'))
		if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
			return json({ error: 'payload_too_large' }, 413)
		}
		const text = await request.text()
		if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) {
			return json({ error: 'payload_too_large' }, 413)
		}
		let body: unknown
		try {
			body = JSON.parse(text)
		} catch {
			return json({ error: 'invalid_request' }, 400)
		}
		const entries = parseBatch(body)
		if (!entries) return json({ error: 'invalid_request' }, 400)

		const receivedAtMs = now()
		const results: BatchResult[] = entries.map((entry) => {
			if (!('event' in entry)) {
				return {
					event_id: entry.eventId ?? '',
					status: 'rejected',
				}
			}
			return batchResult(entry, store.ingest(principal, entry.event, receivedAtMs))
		})
		return json({ results })
	}
	return json({ error: 'not_found' }, 404)
}

async function authenticate(
	request: Request,
	store: ServiceStore,
	oidcVerifier: OidcVerification,
): Promise<Principal | undefined> {
	const authorization = request.headers.get('authorization')
	const match = authorization ? /^Bearer ([^\s]+)$/.exec(authorization) : null
	if (!match) return undefined
	const credential = match[1]!
	if (isBearerToken(credential)) return store.authenticateBearer(credential)
	return (await oidcVerifier.verify(credential)) ? { kind: 'oidc' } : undefined
}

function isSecureRequest(request: Request, trustTlsProxy: boolean): boolean {
	return (
		new URL(request.url).protocol === 'https:' ||
		(trustTlsProxy && request.headers.get('x-forwarded-proto') === 'https')
	)
}

function logPath(pathname: string): string {
	if (
		pathname === '/healthz' ||
		pathname === '/v1/time' ||
		pathname === '/v1/events:batch' ||
		pathname === '/v1/summary'
	) {
		return pathname
	}
	return pathname.startsWith('/v1/') ? '/v1/*' : 'other'
}

function json(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	return Response.json(body, {
		status,
		headers: {
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
			...headers,
		},
	})
}
