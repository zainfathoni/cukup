import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../app.ts'
import type { DashboardConfiguration } from '../config.ts'
import { ServiceLogger } from '../logger.ts'
import { ServiceStore } from '../store.ts'
import { OAUTH_COOKIE_NAME, SESSION_COOKIE_NAME } from './auth.ts'
import { DashboardBackend } from './backend.ts'
import {
	SOCIAL_IMAGE_ALT,
	SOCIAL_IMAGE_FILE,
	SOCIAL_IMAGE_HEIGHT,
	SOCIAL_IMAGE_ROUTE,
	SOCIAL_IMAGE_WIDTH,
	loadSocialImage,
} from './social-image.ts'

const now = Date.parse('2026-09-29T05:00:00.000Z')
const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'cukup-social-image-'))
	directories.push(directory)
	return directory
}

/** A PNG signature and IHDR header with the given size, then filler bytes. */
function pngHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(64)
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...new TextEncoder().encode('IHDR')])
	const view = new DataView(bytes.buffer)
	view.setUint32(16, width)
	view.setUint32(20, height)
	for (let index = 24; index < bytes.length; index++) bytes[index] = index
	return bytes
}

async function socialImage(bytes = pngHeader(SOCIAL_IMAGE_WIDTH, SOCIAL_IMAGE_HEIGHT)) {
	const directory = temporaryDirectory()
	writeFileSync(join(directory, SOCIAL_IMAGE_FILE), bytes)
	return { image: await loadSocialImage(directory), bytes }
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

function fixture(image?: Blob) {
	const store = new ServiceStore(join(temporaryDirectory(), 'service.sqlite'))
	const app = createApp({
		store,
		oidcVerifier: { verify: async () => false },
		now: () => now,
		logger: new ServiceLogger(() => {}),
		apiHostname: 'api.cukup.dev',
		dashboardHostname: 'cukup.dev',
		fleetHostnames: new Set(['fleet.cukup.dev']),
		dashboard: new DashboardBackend({
			config: configuration(),
			store,
			assets: { css: 'body {}', javascript: 'export {}' },
			socialImage: image,
			githubFetch: githubFetch(),
			now: () => now,
		}),
	})
	return { app, store }
}

const get = (app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}, host = 'cukup.dev') =>
	app.fetch(new Request(`https://${host}${path}`, init))

function cookiePair(setCookie: string, name: string): string {
	const match = new RegExp(`${name}=([^;,]+)`).exec(setCookie)
	if (!match) throw new Error(`Missing ${name}`)
	return `${name}=${match[1]}`
}

async function signIn(app: ReturnType<typeof createApp>): Promise<string> {
	const start = await get(app, '/auth/github')
	const state = new URL(start.headers.get('location')!).searchParams.get('state')!
	const callback = await get(app, `/auth/github/callback?code=one-time-code&state=${encodeURIComponent(state)}`, {
		headers: { cookie: cookiePair(start.headers.get('set-cookie')!, OAUTH_COOKIE_NAME) },
	})
	return cookiePair(callback.headers.get('set-cookie')!, SESSION_COOKIE_NAME)
}

/** Every `<meta property|name="…" content="…">` in the page, by key. */
function metaTags(page: string): Map<string, string> {
	const tags = new Map<string, string>()
	for (const [, key, content] of page.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)">/g)) {
		expect(tags.has(key!)).toBe(false)
		tags.set(key!, content!)
	}
	return tags
}

describe('public link-preview image route', () => {
	test('serves the exact PNG without a session, and allows other sites to embed it', async () => {
		const { image, bytes } = await socialImage()
		const { app, store } = fixture(image)
		const response = await get(app, SOCIAL_IMAGE_ROUTE)
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe('image/png')
		expect(response.headers.get('content-length')).toBe(String(bytes.length))
		expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
		expect(response.headers.get('x-content-type-options')).toBe('nosniff')
		expect(response.headers.get('x-frame-options')).toBe('DENY')
		expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
		expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
		expect(response.headers.get('set-cookie')).toBeNull()
		expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...bytes])

		const head = await get(app, SOCIAL_IMAGE_ROUTE, { method: 'HEAD' })
		expect(head.status).toBe(200)
		expect(head.headers.get('content-type')).toBe('image/png')
		const post = await get(app, SOCIAL_IMAGE_ROUTE, { method: 'POST' })
		expect(post.status).toBe(405)
		expect(post.headers.get('allow')).toBe('GET, HEAD')
		store.close()
	})

	test('keeps the same-origin resource policy on every other route', async () => {
		const { image } = await socialImage()
		const { app, store } = fixture(image)
		for (const path of ['/', '/assets/dashboard.css', '/assets/favicon.svg']) {
			expect((await get(app, path)).headers.get('cross-origin-resource-policy')).toBe('same-origin')
		}
		store.close()
	})

	test('stays on the dashboard host and leaves authentication boundaries alone', async () => {
		const { image } = await socialImage()
		const { app, store } = fixture(image)
		expect((await get(app, SOCIAL_IMAGE_ROUTE, {}, 'api.cukup.dev')).status).toBe(404)
		expect((await get(app, SOCIAL_IMAGE_ROUTE, {}, 'fleet.cukup.dev')).status).toBe(404)
		for (const path of ['/assets/og-image.png.bak', '/assets/OG-IMAGE.PNG', '/assets/og-image.jpg', '/og-image.png']) {
			expect((await get(app, path)).status).toBe(404)
		}
		const report = await get(app, '/dashboard/report', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		})
		expect(report.status).toBe(401)
		store.close()
	})

	test('is absent when the file is missing, is not a PNG, or has the wrong size', async () => {
		expect(await loadSocialImage(temporaryDirectory())).toBeUndefined()
		expect((await socialImage(pngHeader(1920, 1080))).image).toBeUndefined()
		const notPng = pngHeader(SOCIAL_IMAGE_WIDTH, SOCIAL_IMAGE_HEIGHT)
		notPng[1] = 0
		expect((await socialImage(notPng)).image).toBeUndefined()
		expect((await socialImage(new Uint8Array(10))).image).toBeUndefined()

		const { app, store } = fixture(undefined)
		expect((await get(app, SOCIAL_IMAGE_ROUTE)).status).toBe(404)
		store.close()
	})
})

describe('signed-out share metadata', () => {
	test('is in the initial HTML, absolute, and the same for Open Graph and Twitter/X', async () => {
		const { image } = await socialImage()
		const { app, store } = fixture(image)
		const page = await (await get(app, '/')).text()
		const head = page.slice(0, page.indexOf('</head>'))
		const tags = metaTags(head)

		expect(head).toContain('<link rel="canonical" href="https://cukup.dev/">')
		expect(head).toContain('<title>Cukup · Decide what is enough</title>')
		expect(tags.get('og:type')).toBe('website')
		expect(tags.get('og:site_name')).toBe('Cukup')
		expect(tags.get('og:url')).toBe('https://cukup.dev/')
		expect(tags.get('og:title')).toBe('Cukup · Decide what is enough')
		expect(tags.get('og:description')).toBe(tags.get('description'))
		expect(tags.get('og:image')).toBe(`https://cukup.dev${SOCIAL_IMAGE_ROUTE}`)
		expect(tags.get('og:image:type')).toBe('image/png')
		expect(tags.get('og:image:width')).toBe('1200')
		expect(tags.get('og:image:height')).toBe('630')
		expect(tags.get('og:image:alt')).toBe(SOCIAL_IMAGE_ALT)

		expect(tags.get('twitter:card')).toBe('summary_large_image')
		expect(tags.get('twitter:title')).toBe(tags.get('og:title'))
		expect(tags.get('twitter:description')).toBe(tags.get('og:description'))
		expect(tags.get('twitter:image')).toBe(tags.get('og:image'))
		expect(tags.get('twitter:image:alt')).toBe(tags.get('og:image:alt'))

		// Every URL names the configured public origin, not the request.
		for (const key of ['og:url', 'og:image', 'twitter:image']) expect(tags.get(key)).toStartWith('https://cukup.dev/')
		// The page stays static, and says nothing personal.
		expect(page).not.toMatch(/<script|<form|<iframe|style=/i)
		expect(head).not.toMatch(/12345678|client-id|report/i)
		store.close()
	})

	test('ignores a spoofed forwarded host when it builds URLs', async () => {
		const { image } = await socialImage()
		const { app, store } = fixture(image)
		const page = await (await get(app, '/', { headers: { 'x-forwarded-host': 'evil.example' } })).text()
		expect(page).not.toContain('evil.example')
		expect(page).toContain(`content="https://cukup.dev${SOCIAL_IMAGE_ROUTE}"`)
		store.close()
	})

	test('names no image when the image is not served', async () => {
		const { app, store } = fixture(undefined)
		const page = await (await get(app, '/')).text()
		const tags = metaTags(page.slice(0, page.indexOf('</head>')))
		expect(tags.get('og:title')).toBe('Cukup · Decide what is enough')
		expect(tags.get('twitter:card')).toBe('summary')
		expect(page).not.toMatch(/og:image|twitter:image|og-image\.png/)
		store.close()
	})

	test('is not added to the signed-in dashboard', async () => {
		const { image } = await socialImage()
		const { app, store } = fixture(image)
		const session = await signIn(app)
		const dashboard = await get(app, '/', { headers: { cookie: session } })
		expect(dashboard.status).toBe(200)
		expect(await dashboard.text()).not.toMatch(/og:|twitter:|rel="canonical"/)
		store.close()
	})
})

describe('shipped link-preview image', () => {
	test('loads from the repository at 1200 × 630, small enough for link previews', async () => {
		const image = await loadSocialImage(fileURLToPath(new URL('../../media/og-image', import.meta.url)))
		expect(image).toBeDefined()
		// Some platforms drop preview images above a few hundred kilobytes.
		expect(image!.size).toBeLessThan(300 * 1024)
	})
})
