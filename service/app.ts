import { summarizeWork } from './aggregation.ts'
import { isBearerToken, type OidcVerifier } from './auth.ts'
import { DEFAULT_API_HOSTNAME, DEFAULT_DASHBOARD_HOSTNAME } from './config.ts'
import type { DashboardBackend } from './dashboard/backend.ts'
import { ServiceLogger } from './logger.ts'
import {
	MAX_REQUEST_BYTES,
	batchResult,
	parseBatch,
	parseExecutorProfile,
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
	fleetHostnames?: ReadonlySet<string>
	preferredNewEventSchemaVersion?: 1 | 2
	apiHostname?: string
	dashboardHostname?: string
	dashboard?: Pick<DashboardBackend, 'fetch'>
}

export function createApp(options: AppOptions): { fetch(request: Request): Promise<Response> } {
	const now = options.now ?? Date.now
	const logger = options.logger ?? new ServiceLogger()
	const requireHttps = options.requireHttps ?? true
	const trustTlsProxy = options.trustTlsProxy ?? false
	const fleetHostnames = options.fleetHostnames ?? new Set<string>()
	const preferredNewEventSchemaVersion = options.preferredNewEventSchemaVersion ?? 1
	const apiHostname = options.apiHostname ?? DEFAULT_API_HOSTNAME
	const dashboardHostname = options.dashboardHostname ?? DEFAULT_DASHBOARD_HOSTNAME

	return {
		async fetch(request: Request): Promise<Response> {
			const startedAt = performance.now()
			const url = new URL(request.url)
			let response: Response
			try {
				const hostname = originalHostname(request, url)
				if (url.pathname === '/up') {
					response =
						request.method === 'GET'
							? json({ ok: true })
							: json({ error: 'method_not_allowed' }, 405, { allow: 'GET' })
				} else if (hostname === dashboardHostname) {
					response =
						options.dashboard && (!requireHttps || isSecureRequest(request, trustTlsProxy))
							? await options.dashboard.fetch(request, url)
							: json({ error: 'not_found' }, 404)
				} else if (hostname !== apiHostname) {
					response = json({ error: 'not_found' }, 404)
				} else if (url.pathname === '/healthz') {
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
							? await authenticatedResponse(
									request,
									url,
									principal,
									options.store,
									now,
									fleetHostnames,
									preferredNewEventSchemaVersion,
								)
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
	fleetHostnames: ReadonlySet<string>,
	preferredNewEventSchemaVersion: 1 | 2,
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
	if (url.pathname === '/v1/capabilities') {
		return request.method === 'GET'
			? json({
					schema_version: 1,
					accepted_event_schema_versions: [1, 2],
					preferred_new_event_schema_version: preferredNewEventSchemaVersion,
				})
			: json({ error: 'method_not_allowed' }, 405, { allow: 'GET' })
	}
	if (url.pathname === '/v1/executor-profile') {
		if (request.method !== 'PUT') {
			return json({ error: 'method_not_allowed' }, 405, { allow: 'PUT' })
		}
		if (principal.kind !== 'bearer') {
			return json({ error: 'physical_bearer_required' }, 403)
		}
		if (!isJsonRequest(request)) return json({ error: 'unsupported_media_type' }, 415)
		const body = await requestBody(request)
		if (body.outcome === 'too_large') return json({ error: 'payload_too_large' }, 413)
		if (body.outcome === 'invalid') return json({ error: 'invalid_request' }, 400)
		const hostname = parseExecutorProfile(body.value)
		if (hostname === undefined || !fleetHostnames.has(hostname)) {
			return json({ error: 'invalid_executor_profile' }, 422)
		}
		const result = store.bindExecutorLabel(principal.tokenId, hostname)
		return result.outcome === 'bound'
			? json({ executor_label: result.executorLabel })
			: json({ error: 'executor_profile_conflict' }, 409)
	}
	if (url.pathname === '/v1/events:batch') {
		if (request.method !== 'POST') {
			return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' })
		}
		if (!isJsonRequest(request)) {
			return json({ error: 'unsupported_media_type' }, 415)
		}
		const body = await requestBody(request)
		if (body.outcome === 'too_large') return json({ error: 'payload_too_large' }, 413)
		if (body.outcome === 'invalid') return json({ error: 'invalid_request' }, 400)
		const entries = parseBatch(body.value)
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
	if (trustTlsProxy) return request.headers.get('x-forwarded-proto') === 'https'
	return new URL(request.url).protocol === 'https:'
}

function originalHostname(request: Request, url: URL): string {
	return request.headers.get('host') ?? url.host
}

function logPath(pathname: string): string {
	if (
		pathname === '/up' ||
		pathname === '/healthz' ||
		pathname === '/v1/time' ||
		pathname === '/v1/capabilities' ||
		pathname === '/v1/executor-profile' ||
		pathname === '/v1/events:batch' ||
		pathname === '/v1/summary' ||
		pathname === '/' ||
		pathname === '/auth/github' ||
		pathname === '/auth/github/callback' ||
		pathname === '/logout' ||
		pathname === '/dashboard/report' ||
		pathname === '/assets/dashboard.css' ||
		pathname === '/assets/dashboard.js'
	) {
		return pathname
	}
	return pathname.startsWith('/v1/') ? '/v1/*' : 'other'
}

function isJsonRequest(request: Request): boolean {
	return (
		request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
		'application/json'
	)
}

async function requestBody(
	request: Request,
): Promise<
	| { outcome: 'valid'; value: unknown }
	| { outcome: 'invalid' }
	| { outcome: 'too_large' }
> {
	const contentLength = Number(request.headers.get('content-length'))
	if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
		return { outcome: 'too_large' }
	}
	const text = await request.text()
	if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) return { outcome: 'too_large' }
	try {
		return { outcome: 'valid', value: JSON.parse(text) }
	} catch {
		return { outcome: 'invalid' }
	}
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
