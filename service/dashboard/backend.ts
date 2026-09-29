import { randomBytes } from 'node:crypto'
import type { DashboardConfiguration } from '../config.ts'
import { DashboardAuth } from './auth.ts'
import {
	availableDashboardLabels,
	buildDashboardReport,
	parseDashboardSelection,
	type DashboardReportStore,
} from './report-builder.ts'
import { EXPLAINER_ROUTES, parseByteRange, type ExplainerAssets } from './explainer.ts'
import { renderLandingPage } from './landing.ts'
import { renderDashboardDocument } from './render.ts'
import type { DashboardSelection } from './report.ts'

const MAX_REPORT_REQUEST_BYTES = 32 * 1024
const initialSelection: DashboardSelection = {
	projects: [],
	executors: [],
	range: { preset: 30 },
}

export type DashboardAssets = { css: string; javascript: string }

/** Local, dependency-free mark. Inlined so no build step or remote asset is added. */
const FAVICON =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
	'<rect width="32" height="32" rx="8" fill="#26201a"/>' +
	'<rect x="5" y="19" width="22" height="7" rx="3.5" fill="#fff4dd"/>' +
	'<rect x="5" y="19" width="14" height="7" rx="3.5" fill="#ff5c2b"/>' +
	'<circle cx="16" cy="11" r="4.5" fill="#ffd84d"/>' +
	'</svg>'

export class DashboardBackend {
	readonly #config: DashboardConfiguration
	readonly #store: DashboardReportStore
	readonly #assets: DashboardAssets
	readonly #auth: DashboardAuth
	readonly #now: () => number
	readonly #explainer: ExplainerAssets | undefined

	constructor(options: {
		config: DashboardConfiguration
		store: DashboardReportStore
		assets: DashboardAssets
		/** The public explainer. Without it, the signed-out page shows no player. */
		explainer?: ExplainerAssets
		githubFetch?: typeof globalThis.fetch
		now?: () => number
	}) {
		this.#config = options.config
		this.#store = options.store
		this.#assets = options.assets
		this.#now = options.now ?? Date.now
		this.#explainer = options.explainer
		this.#auth = new DashboardAuth(options.config, {
			fetch: options.githubFetch,
			now: this.#now,
		})
	}

	async fetch(request: Request, url: URL): Promise<Response> {
		if (url.pathname === '/assets/dashboard.css') {
			return request.method === 'GET'
				? response(this.#assets.css, 200, 'text/css; charset=utf-8')
				: methodNotAllowed('GET')
		}
		if (url.pathname === '/assets/dashboard.js') {
			return request.method === 'GET'
				? response(this.#assets.javascript, 200, 'text/javascript; charset=utf-8')
				: methodNotAllowed('GET')
		}
		if (url.pathname === '/assets/favicon.svg') {
			return request.method === 'GET'
				? response(FAVICON, 200, 'image/svg+xml; charset=utf-8')
				: methodNotAllowed('GET')
		}
		const explainer = this.#explainer
		if (explainer) {
			if (url.pathname === EXPLAINER_ROUTES.video) return media(request, explainer.video, 'video/mp4')
			if (url.pathname === EXPLAINER_ROUTES.poster) return media(request, explainer.poster, 'image/png')
			if (url.pathname === EXPLAINER_ROUTES.captions) {
				return media(request, new Blob([explainer.captions]), 'text/vtt; charset=utf-8')
			}
			if (url.pathname === EXPLAINER_ROUTES.transcript) {
				return request.method === 'GET' ? html(explainer.transcriptHtml) : methodNotAllowed('GET')
			}
		}
		if (url.pathname === '/auth/github') {
			if (request.method !== 'GET') return methodNotAllowed('GET')
			const start = this.#auth.start()
			return redirect(start.location, [start.cookie])
		}
		if (url.pathname === '/auth/github/callback') {
			if (request.method !== 'GET') return methodNotAllowed('GET')
			const completion = await this.#auth.complete(
				url.searchParams,
				request.headers.get('cookie'),
			)
			if (!completion) {
				return html(
					renderMessagePage('Sign in failed', 'The account could not be authorized.'),
					401,
					[this.#auth.clearOAuthCookie()],
				)
			}
			return redirect('/', [completion.sessionCookie, completion.clearedOAuthCookie])
		}
		if (url.pathname === '/logout') {
			if (request.method !== 'POST') return methodNotAllowed('POST')
			if (!isSameOriginBrowserRequest(request, this.#config.hostname)) {
				return json({ error: 'invalid_request' }, 400)
			}
			return redirect('/', [this.#auth.clearSessionCookie(), this.#auth.clearOAuthCookie()])
		}
		if (url.pathname === '/dashboard/report') {
			return this.#report(request)
		}
		if (url.pathname === '/') {
			if (request.method !== 'GET') return methodNotAllowed('GET')
			if (!this.#auth.hasValidSession(request.headers.get('cookie'))) {
				// Only this page embeds media, so only it may load same-origin media.
				return html(renderLandingPage({ explainer: this.#explainer }), 200, [], undefined, {
					'content-security-policy': contentSecurityPolicy(undefined, { media: Boolean(this.#explainer) }),
				})
			}
			const nonce = randomBytes(18).toString('base64url')
			const report = buildDashboardReport(this.#store, initialSelection, this.#now())
			return html(renderDashboardDocument(report, initialSelection, nonce), 200, [], nonce)
		}
		return json({ error: 'not_found' }, 404)
	}

	async #report(request: Request): Promise<Response> {
		if (request.method !== 'POST') return methodNotAllowed('POST')
		if (!this.#auth.hasValidSession(request.headers.get('cookie'))) {
			return json({ error: 'unauthorized' }, 401)
		}
		if (!isSameOriginBrowserRequest(request, this.#config.hostname)) {
			return json({ error: 'invalid_request' }, 400)
		}
		if (mediaType(request.headers.get('content-type')) !== 'application/json') {
			return json({ error: 'unsupported_media_type' }, 415)
		}
		const body = await readJson(request)
		if (body.outcome === 'too_large') return json({ error: 'payload_too_large' }, 413)
		if (body.outcome === 'invalid') return json({ error: 'invalid_request' }, 400)
		let labels
		try {
			labels = availableDashboardLabels(this.#store)
		} catch {
			return json({ error: 'report_unavailable' }, 503)
		}
		const selection = parseDashboardSelection(body.value, labels)
		if (!selection) return json({ error: 'invalid_request' }, 400)
		return json(buildDashboardReport(this.#store, selection, this.#now()))
	}
}

function isSameOriginBrowserRequest(request: Request, hostname: string): boolean {
	const origin = request.headers.get('origin')
	// A same-origin form navigation from a `Referrer-Policy: no-referrer` document
	// serializes its origin opaquely as the literal `null`. That is an absent origin,
	// not an explicitly cross-origin one, so it is decided by Sec-Fetch-Site below.
	// A genuine cross-site post carries `Sec-Fetch-Site: cross-site`, and framing is
	// already refused by `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
	if (origin !== null && origin !== 'null' && origin !== `https://${hostname}`) return false
	const fetchSite = request.headers.get('sec-fetch-site')
	if (origin === 'null' && fetchSite !== 'same-origin') return false
	return fetchSite === null || fetchSite === 'same-origin'
}

async function readJson(
	request: Request,
): Promise<
	| { outcome: 'valid'; value: unknown }
	| { outcome: 'invalid' }
	| { outcome: 'too_large' }
> {
	const contentLength = Number(request.headers.get('content-length'))
	if (Number.isFinite(contentLength) && contentLength > MAX_REPORT_REQUEST_BYTES) {
		return { outcome: 'too_large' }
	}
	const text = await request.text()
	if (Buffer.byteLength(text) > MAX_REPORT_REQUEST_BYTES) return { outcome: 'too_large' }
	try {
		return { outcome: 'valid', value: JSON.parse(text) }
	} catch {
		return { outcome: 'invalid' }
	}
}

function mediaType(value: string | null): string | undefined {
	return value?.split(';', 1)[0]?.trim().toLowerCase()
}

function renderMessagePage(title: string, message: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/dashboard.css"></head><body><main class="centered"><section><p class="eyebrow">Cukup</p><h1>${title}</h1><p class="guidance">${message}</p><p><a class="button" href="/">Return to sign in</a></p></section></main></body></html>`
}

function redirect(location: string, cookies: readonly string[]): Response {
	return response('', 303, 'text/plain; charset=utf-8', cookies, undefined, { location })
}

function html(
	body: string,
	status = 200,
	cookies: readonly string[] = [],
	nonce?: string,
	extraHeaders: Record<string, string> = {},
): Response {
	return response(body, status, 'text/html; charset=utf-8', cookies, nonce, extraHeaders)
}

/**
 * A public, fixed media file with byte-range support, so browsers can seek.
 * Media may be cached briefly; it changes only with a new service image.
 */
function media(request: Request, file: Blob, contentType: string): Response {
	if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD')
	const size = file.size
	const common = { 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=3600' }
	const range = parseByteRange(request.headers.get('range'), size)
	if (range === 'unsatisfiable') {
		return response('', 416, contentType, [], undefined, { ...common, 'content-range': `bytes */${size}` })
	}
	const head = request.method === 'HEAD'
	if (!range) {
		return response(head ? '' : file, 200, contentType, [], undefined, { ...common, 'content-length': String(size) })
	}
	const length = range.end - range.start + 1
	return response(head ? '' : file.slice(range.start, range.end + 1), 206, contentType, [], undefined, {
		...common,
		'content-length': String(length),
		'content-range': `bytes ${range.start}-${range.end}/${size}`,
	})
}

function json(body: unknown, status = 200): Response {
	return response(JSON.stringify(body), status, 'application/json; charset=utf-8')
}

function methodNotAllowed(allow: string): Response {
	return response(
		JSON.stringify({ error: 'method_not_allowed' }),
		405,
		'application/json; charset=utf-8',
		[],
		undefined,
		{ allow },
	)
}

function response(
	body: BodyInit,
	status: number,
	contentType: string,
	cookies: readonly string[] = [],
	nonce?: string,
	extraHeaders: Record<string, string> = {},
): Response {
	const headers = new Headers({
		'cache-control': 'no-store',
		'content-security-policy': contentSecurityPolicy(nonce),
		'content-type': contentType,
		'cross-origin-opener-policy': 'same-origin',
		'cross-origin-resource-policy': 'same-origin',
		'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
		'referrer-policy': 'no-referrer',
		'x-content-type-options': 'nosniff',
		'x-frame-options': 'DENY',
		...extraHeaders,
	})
	for (const cookie of cookies) headers.append('set-cookie', cookie)
	return new Response(body, { status, headers })
}

function contentSecurityPolicy(nonce?: string, options: { media?: boolean } = {}): string {
	const scripts = nonce ? `'self' 'nonce-${nonce}'` : "'self'"
	return [
		"default-src 'none'",
		`script-src ${scripts}`,
		"style-src 'self'",
		"connect-src 'self'",
		"img-src 'self'",
		...(options.media ? ["media-src 'self'"] : []),
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"object-src 'none'",
	].join('; ')
}
