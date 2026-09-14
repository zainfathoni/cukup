import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app.ts'
import type { DashboardConfiguration } from '../config.ts'
import { ServiceLogger } from '../logger.ts'
import { ServiceStore } from '../store.ts'
import { DashboardBackend } from './backend.ts'
import { OAUTH_COOKIE_NAME, SESSION_COOKIE_NAME } from './auth.ts'

const now = Date.parse('2026-08-31T05:00:00.000Z')
const temporaryDirectories: string[] = []

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

function store(): ServiceStore {
	const directory = mkdtempSync(join(tmpdir(), 'cukup-dashboard-backend-'))
	temporaryDirectories.push(directory)
	return new ServiceStore(join(directory, 'service.sqlite'))
}

function configuration(): DashboardConfiguration {
	return {
		hostname: 'cukup.dev',
		callbackUrl: 'https://cukup.dev/auth/github/callback',
		githubClientId: 'client-id',
		githubClientSecret: 'client-secret',
		allowedGithubUserId: '12345678',
		sessionKeys: [Buffer.alloc(32, 3)],
	}
}

function githubFetch(): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = String(input)
		if (url === 'https://github.com/login/oauth/access_token') {
			return Response.json({ access_token: 'access-token', token_type: 'bearer' })
		}
		if (url === 'https://api.github.com/user') return Response.json({ id: 12_345_678 })
		return new Response(null, { status: 404 })
	}) as typeof fetch
}

function fixture(options: { dashboard?: boolean; trustTlsProxy?: boolean } = {}) {
	const serviceStore = store()
	const issued = serviceStore.issueBearer(now)
	const logs: string[] = []
	const dashboard = options.dashboard === false
		? undefined
		: new DashboardBackend({
				config: configuration(),
				store: serviceStore,
				assets: { css: 'body { color: CanvasText; }', javascript: 'export {}' },
				githubFetch: githubFetch(),
				now: () => now,
			})
	const app = createApp({
		store: serviceStore,
		oidcVerifier: { verify: async () => false },
		now: () => now,
		logger: new ServiceLogger((line) => logs.push(line)),
		apiHostname: 'api.cukup.dev',
		dashboardHostname: 'cukup.dev',
		dashboard,
		trustTlsProxy: options.trustTlsProxy,
	})
	return { app, store: serviceStore, token: issued.token, logs }
}

function request(
	hostname: string,
	path: string,
	options: RequestInit & { protocol?: 'http' | 'https' } = {},
): Request {
	const { protocol = 'https', ...init } = options
	return new Request(`${protocol}://${hostname}${path}`, init)
}

function cookiePair(setCookie: string, name: string): string {
	const match = new RegExp(`${name}=([^;,]+)`).exec(setCookie)
	if (!match) throw new Error(`Missing ${name}`)
	return `${name}=${match[1]}`
}

async function dashboardSession(app: ReturnType<typeof createApp>): Promise<string> {
	const start = await app.fetch(request('cukup.dev', '/auth/github'))
	const location = new URL(start.headers.get('location')!)
	const oauthCookie = cookiePair(start.headers.get('set-cookie')!, OAUTH_COOKIE_NAME)
	const callback = await app.fetch(
		request(
			'cukup.dev',
			`/auth/github/callback?code=one-time-code&state=${encodeURIComponent(location.searchParams.get('state')!)}`,
			{ headers: { cookie: oauthCookie } },
		),
	)
	expect(callback.status).toBe(303)
	return cookiePair(callback.headers.get('set-cookie')!, SESSION_COOKIE_NAME)
}

describe('host and authentication boundaries', () => {
	test('dispatches exact original hosts first and fails unknown or cross-host routes closed', async () => {
		const value = fixture()
		expect((await value.app.fetch(request('api.cukup.dev', '/healthz'))).status).toBe(200)
		expect((await value.app.fetch(request('cukup.dev', '/healthz'))).status).toBe(404)
		expect((await value.app.fetch(request('api.cukup.dev', '/'))).status).toBe(404)
		expect((await value.app.fetch(request('cukup.dev', '/'))).status).toBe(200)
		expect((await value.app.fetch(request('unknown.cukup.dev', '/healthz'))).status).toBe(404)
		expect((await value.app.fetch(request('cukup.dev:444', '/'))).status).toBe(404)

		const forwardedHost = await value.app.fetch(
			request('unknown.cukup.dev', '/', { headers: { 'x-forwarded-host': 'cukup.dev' } }),
		)
		expect(forwardedHost.status).toBe(404)
		value.store.close()
	})

	test('trusts only a single exact forwarded HTTPS proto in explicit proxy mode', async () => {
		const value = fixture({ trustTlsProxy: true })
		const secure = await value.app.fetch(
			request('cukup.dev', '/', {
				protocol: 'http',
				headers: { 'x-forwarded-proto': 'https' },
			}),
		)
		expect(secure.status).toBe(200)
		for (const proto of ['http', 'https,http', 'HTTPS']) {
			const rejected = await value.app.fetch(
				request('cukup.dev', '/', {
					protocol: 'http',
					headers: { 'x-forwarded-proto': proto },
				}),
			)
			expect(rejected.status).toBe(404)
		}
		value.store.close()
	})

	test('keeps ingestion healthy when dashboard configuration is disabled', async () => {
		const value = fixture({ dashboard: false })
		expect((await value.app.fetch(request('api.cukup.dev', '/healthz'))).status).toBe(200)
		expect((await value.app.fetch(request('cukup.dev', '/'))).status).toBe(404)
		const time = await value.app.fetch(
			request('api.cukup.dev', '/v1/time', {
				headers: { authorization: `Bearer ${value.token}` },
			}),
		)
		expect(time.status).toBe(200)
		value.store.close()
	})

	test('never accepts bearer/OIDC auth for dashboard or dashboard cookies for ingestion', async () => {
		const value = fixture()
		const bearerDashboard = await value.app.fetch(
			request('cukup.dev', '/dashboard/report', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${value.token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ projects: [], executors: [], range: { preset: 7 } }),
			}),
		)
		expect(bearerDashboard.status).toBe(401)
		const session = await dashboardSession(value.app)
		const cookieIngestion = await value.app.fetch(
			request('api.cukup.dev', '/v1/time', { headers: { cookie: session } }),
		)
		expect(cookieIngestion.status).toBe(401)
		expect((await value.app.fetch(request('cukup.dev', '/v1/time', {
			headers: { authorization: `Bearer ${value.token}` },
		}))).status).toBe(404)
		value.store.close()
	})
})

describe('dashboard HTTP contract', () => {
	test('serves authenticated same-origin reports, rejects malformed selections, and logs no body values', async () => {
		const value = fixture()
		const session = await dashboardSession(value.app)
		const report = (body: unknown, headers: Record<string, string> = {}) =>
			value.app.fetch(
				request('cukup.dev', '/dashboard/report', {
					method: 'POST',
					headers: {
						cookie: session,
						'content-type': 'application/json',
						origin: 'https://cukup.dev',
						'sec-fetch-site': 'same-origin',
						...headers,
					},
					body: JSON.stringify(body),
				}),
			)

		const accepted = await report({
			projects: [],
			executors: [],
			timeline_date: '2026-08-30',
			range: { preset: 7 },
		})
		expect(accepted.status).toBe(200)
		const acceptedReport = await accepted.json() as any
		expect(acceptedReport.schema_version).toBe(2)
		expect(acceptedReport.timeline.data.date).toBe('2026-08-30')
		expect(acceptedReport.shadow_disclosures).toEqual({
			state: 'ready',
			data: {
				start: '2026-08-24T17:00:00.000Z',
				end: '2026-08-31T05:00:00.000Z',
				lanes: [],
			},
		})
		for (const invalid of [
			{ projects: [], executors: [], timeline_date: 'not-a-date', range: { preset: 7 } },
			{ projects: ['private-label'], executors: [], range: { preset: 7 } },
			{ projects: [], executors: [], range: { preset: 365 } },
			{ projects: [], executors: [], range: { preset: 7 }, extra: true },
		]) {
			expect((await report(invalid)).status).toBe(400)
		}
		expect((await report(
			{ projects: [], executors: [], range: { preset: 7 } },
			{ origin: 'https://attacker.test' },
		)).status).toBe(400)
		expect(value.logs.join('\n')).not.toContain('private-label')
		expect(value.logs.join('\n')).not.toContain(SESSION_COOKIE_NAME)
		value.store.close()
	})

	test('serves only bundled local assets with CSP/security/no-store headers and clears sessions on logout', async () => {
		const value = fixture()
		const signIn = await value.app.fetch(request('cukup.dev', '/'))
		expect(await signIn.text()).toContain('Sign in with GitHub')
		expect(signIn.headers.get('content-security-policy')).toContain("default-src 'none'")
		expect(signIn.headers.get('content-security-policy')).not.toContain('unsafe-inline')
		expect(signIn.headers.get('cache-control')).toBe('no-store')

		const css = await value.app.fetch(request('cukup.dev', '/assets/dashboard.css'))
		const javascript = await value.app.fetch(request('cukup.dev', '/assets/dashboard.js'))
		expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
		expect(javascript.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
		expect(await css.text()).toBe('body { color: CanvasText; }')
		expect(await javascript.text()).toBe('export {}')

		const session = await dashboardSession(value.app)
		const dashboard = await value.app.fetch(request('cukup.dev', '/', { headers: { cookie: session } }))
		const dashboardHtml = await dashboard.text()
		expect(dashboardHtml).toContain('action="/logout"')
		expect(dashboardHtml).toContain('src="/assets/dashboard.js"')
		expect(dashboardHtml).not.toMatch(/https?:\/\/(?!cukup\.dev)/)
		const csp = dashboard.headers.get('content-security-policy')!
		expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9_-]+'/)
		expect(dashboard.headers.get('x-frame-options')).toBe('DENY')
		expect(dashboard.headers.get('referrer-policy')).toBe('no-referrer')

		const logout = await value.app.fetch(
			request('cukup.dev', '/logout', {
				method: 'POST',
				headers: { cookie: session, origin: 'https://cukup.dev' },
			}),
		)
		expect(logout.status).toBe(303)
		expect(logout.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=; Max-Age=0`)
		value.store.close()
	})

	test('accepts the opaque origin a no-referrer form navigation sends, and still refuses cross-site posts', async () => {
		const value = fixture()
		const session = await dashboardSession(value.app)

		// Chrome serializes the origin of a same-origin form POST as the literal
		// `null` when the document was served with `Referrer-Policy: no-referrer`,
		// which every dashboard response is. Sign out must still work.
		const signOut = await value.app.fetch(
			request('cukup.dev', '/logout', {
				method: 'POST',
				headers: { cookie: session, origin: 'null', 'sec-fetch-site': 'same-origin' },
			}),
		)
		expect(signOut.status).toBe(303)
		expect(signOut.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=; Max-Age=0`)

		// An opaque origin without a same-origin fetch site stays refused, as does a
		// cross-site post and a real foreign origin.
		const refusedHeaders: Array<Record<string, string>> = [
			{ origin: 'null' },
			{ origin: 'null', 'sec-fetch-site': 'cross-site' },
			{ origin: 'https://attacker.test', 'sec-fetch-site': 'same-origin' },
		]
		for (const headers of refusedHeaders) {
			const refused = await value.app.fetch(
				request('cukup.dev', '/logout', { method: 'POST', headers: { cookie: session, ...headers } }),
			)
			expect(refused.status).toBe(400)
		}

		const refusedReport = await value.app.fetch(
			request('cukup.dev', '/dashboard/report', {
				method: 'POST',
				headers: {
					cookie: session,
					origin: 'null',
					'sec-fetch-site': 'cross-site',
					'content-type': 'application/json',
				},
				body: JSON.stringify({ projects: [], executors: [], range: { preset: 7 } }),
			}),
		)
		expect(refusedReport.status).toBe(400)
		value.store.close()
	})

	test('serves a local favicon and links it from every dashboard document', async () => {
		const value = fixture()
		const favicon = await value.app.fetch(request('cukup.dev', '/assets/favicon.svg'))
		expect(favicon.status).toBe(200)
		expect(favicon.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
		const markup = await favicon.text()
		expect(markup).toStartWith('<svg')
		// The SVG namespace URI is not a fetch; nothing here loads a remote resource.
		expect(markup).not.toContain('url(')
		expect(markup).not.toContain('href')
		expect(markup).not.toContain('<image')

		const session = await dashboardSession(value.app)
		const signIn = await value.app.fetch(request('cukup.dev', '/'))
		const dashboard = await value.app.fetch(request('cukup.dev', '/', { headers: { cookie: session } }))
		for (const page of [await signIn.text(), await dashboard.text()]) {
			expect(page).toContain('<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">')
		}
		value.store.close()
	})

	test('paints the authenticated dashboard on the 30-day trend range', async () => {
		const value = fixture()
		const session = await dashboardSession(value.app)
		const dashboard = await value.app.fetch(request('cukup.dev', '/', { headers: { cookie: session } }))
		const html = await dashboard.text()
		expect(html).toContain('data-range="30" data-focus-key="range:30" aria-pressed="true"')
		expect(html).toContain('"preset":30')
		expect(html).not.toContain('data-range="7" data-focus-key="range:7" aria-pressed="true"')
		value.store.close()
	})

	test('keeps encrypted sessions and dashboard reads compatible across a store restart', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'cukup-dashboard-restart-'))
		temporaryDirectories.push(directory)
		const path = join(directory, 'service.sqlite')
		const create = (serviceStore: ServiceStore) => {
			const dashboard = new DashboardBackend({
				config: configuration(),
				store: serviceStore,
				assets: { css: 'body {}', javascript: 'export {}' },
				githubFetch: githubFetch(),
				now: () => now,
			})
			return createApp({
				store: serviceStore,
				oidcVerifier: { verify: async () => false },
				now: () => now,
				logger: new ServiceLogger(() => {}),
				dashboard,
			})
		}

		const firstStore = new ServiceStore(path)
		const session = await dashboardSession(create(firstStore))
		firstStore.close()
		const reopened = new ServiceStore(path)
		const app = create(reopened)
		const page = await app.fetch(request('cukup.dev', '/', { headers: { cookie: session } }))
		expect(page.status).toBe(200)
		expect(await page.text()).toContain('Authoritative as of')
		const report = await app.fetch(
			request('cukup.dev', '/dashboard/report', {
				method: 'POST',
				headers: { cookie: session, 'content-type': 'application/json' },
				body: JSON.stringify({ projects: [], executors: [], range: { preset: 7 } }),
			}),
		)
		expect(report.status).toBe(200)
		expect((await report.json() as any).overall.state).toBe('ready')
		reopened.close()
	})
})
