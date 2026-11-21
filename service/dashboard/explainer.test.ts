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
	EXPLAINER_FILES,
	EXPLAINER_ROUTES,
	loadExplainerAssets,
	parseByteRange,
	renderTranscriptPage,
	type ExplainerAssets,
} from './explainer.ts'

const now = Date.parse('2026-08-31T05:00:00.000Z')
const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'cukup-explainer-'))
	directories.push(directory)
	return directory
}

/** A small, well-formed stand-in for the four shipped files. */
function writeExplainerFiles(directory: string, videoBytes = 1000): Uint8Array {
	const video = new Uint8Array(videoBytes)
	video.set([0, 0, 0, 24, ...new TextEncoder().encode('ftypisom')])
	for (let index = 12; index < videoBytes; index++) video[index] = index % 251
	writeFileSync(join(directory, EXPLAINER_FILES.video), video)
	writeFileSync(join(directory, EXPLAINER_FILES.poster), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))
	writeFileSync(
		join(directory, EXPLAINER_FILES.captions),
		'WEBVTT\n\n1\n00:00:00.400 --> 00:00:03.700\nAI was supposed to save us time.\n\n2\n00:01:32.434 --> 00:01:38.898\nRead why at cukup.dev.\n',
	)
	writeFileSync(
		join(directory, EXPLAINER_FILES.transcript),
		'# Cukup: enough — transcript\n\nThe video has narration.\n\n## A shared concern (0:00.0–0:08.0)\n\n*Conceptual illustration. <b>not html</b>*\n\n*End card:* **cukup.dev**.\n',
	)
	return video
}

async function explainer(): Promise<{ assets: ExplainerAssets; video: Uint8Array }> {
	const directory = temporaryDirectory()
	const video = writeExplainerFiles(directory)
	const assets = await loadExplainerAssets(directory)
	if (!assets) throw new Error('fixture explainer did not load')
	return { assets, video }
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

function fixture(assets?: ExplainerAssets) {
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
			explainer: assets,
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

describe('byte ranges', () => {
	test('parse single ranges and reject what cannot be satisfied', () => {
		expect(parseByteRange(null, 1000)).toBeUndefined()
		expect(parseByteRange('bytes=0-1', 1000)).toEqual({ start: 0, end: 1 })
		expect(parseByteRange('bytes=100-', 1000)).toEqual({ start: 100, end: 999 })
		expect(parseByteRange('bytes=-500', 1000)).toEqual({ start: 500, end: 999 })
		expect(parseByteRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
		expect(parseByteRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
		expect(parseByteRange('bytes=1000-', 1000)).toBe('unsatisfiable')
		expect(parseByteRange('bytes=-0', 1000)).toBe('unsatisfiable')
		// Malformed or multiple ranges fall back to the whole file.
		expect(parseByteRange('bytes=5-2', 1000)).toBeUndefined()
		expect(parseByteRange('bytes=0-1,5-6', 1000)).toBeUndefined()
		expect(parseByteRange('items=0-1', 1000)).toBeUndefined()
	})
})

describe('public explainer routes', () => {
	test('serve the video with byte ranges, so browsers can seek', async () => {
		const { assets, video } = await explainer()
		const { app, store } = fixture(assets)

		const whole = await get(app, EXPLAINER_ROUTES.video)
		expect(whole.status).toBe(200)
		expect(whole.headers.get('content-type')).toBe('video/mp4')
		expect(whole.headers.get('accept-ranges')).toBe('bytes')
		expect([...new Uint8Array(await whole.arrayBuffer())]).toEqual([...video])

		for (const [range, start, end] of [
			['bytes=0-1', 0, 1],
			['bytes=100-', 100, 999],
			['bytes=-500', 500, 999],
		] as const) {
			const partial = await get(app, EXPLAINER_ROUTES.video, { headers: { range } })
			expect(partial.status).toBe(206)
			expect(partial.headers.get('content-range')).toBe(`bytes ${start}-${end}/1000`)
			expect(partial.headers.get('content-length')).toBe(String(end - start + 1))
			expect([...new Uint8Array(await partial.arrayBuffer())]).toEqual([...video.slice(start, end + 1)])
		}

		const unsatisfiable = await get(app, EXPLAINER_ROUTES.video, { headers: { range: 'bytes=1000-' } })
		expect(unsatisfiable.status).toBe(416)
		expect(unsatisfiable.headers.get('content-range')).toBe('bytes */1000')

		const head = await get(app, EXPLAINER_ROUTES.video, { method: 'HEAD' })
		expect(head.status).toBe(200)
		expect(head.headers.get('accept-ranges')).toBe('bytes')

		const post = await get(app, EXPLAINER_ROUTES.video, { method: 'POST' })
		expect(post.status).toBe(405)
		expect(post.headers.get('allow')).toBe('GET, HEAD')
		store.close()
	})

	test('serve the poster and captions with exact types and the usual security headers', async () => {
		const { assets } = await explainer()
		const { app, store } = fixture(assets)
		const poster = await get(app, EXPLAINER_ROUTES.poster)
		expect(poster.status).toBe(200)
		expect(poster.headers.get('content-type')).toBe('image/png')
		const captions = await get(app, EXPLAINER_ROUTES.captions)
		expect(captions.headers.get('content-type')).toBe('text/vtt; charset=utf-8')
		expect(await captions.text()).toStartWith('WEBVTT')
		for (const response of [poster, captions]) {
			expect(response.headers.get('x-content-type-options')).toBe('nosniff')
			expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
			expect(response.headers.get('x-frame-options')).toBe('DENY')
		}
		store.close()
	})

	test('render the transcript as an escaped, static page with a way back', async () => {
		const { assets } = await explainer()
		const { app, store } = fixture(assets)
		const transcript = await get(app, EXPLAINER_ROUTES.transcript)
		expect(transcript.status).toBe(200)
		expect(transcript.headers.get('content-type')).toBe('text/html; charset=utf-8')
		expect(transcript.headers.get('content-security-policy')).toContain("default-src 'none'")
		const page = await transcript.text()
		expect(page.match(/<h1[\s>]/g)).toHaveLength(1)
		expect(page).toContain('<h2>A shared concern (0:00.0–0:08.0)</h2>')
		expect(page).toContain('<em>Conceptual illustration. &lt;b&gt;not html&lt;/b&gt;</em>')
		expect(page).toContain('<strong>cukup.dev</strong>')
		expect(page).toContain('href="/#explainer"')
		expect(page).not.toMatch(/<script|<form|<iframe|style=|github\.com/i)
		expect((await get(app, EXPLAINER_ROUTES.transcript, { method: 'POST' })).status).toBe(405)
		store.close()
	})

	test('stay on the dashboard host and leave authentication boundaries alone', async () => {
		const { assets } = await explainer()
		const { app, store } = fixture(assets)
		for (const path of Object.values(EXPLAINER_ROUTES)) {
			expect((await get(app, path)).status).toBeLessThan(300)
			expect((await get(app, path, {}, 'api.cukup.dev')).status).toBe(404)
			expect((await get(app, path, {}, 'fleet.cukup.dev')).status).toBe(404)
		}
		// Nothing else under the explainer prefix is served, and no path reaches the filesystem.
		for (const path of ['/assets/explainer/', '/assets/explainer/transcript.md', '/assets/explainer/poster.png.bak', '/assets/explainer/CUKUP-EXPLAINER.MP4']) {
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

	test('are absent when the explainer files are missing or malformed', async () => {
		const empty = temporaryDirectory()
		expect(await loadExplainerAssets(empty)).toBeUndefined()
		const broken = temporaryDirectory()
		writeExplainerFiles(broken)
		writeFileSync(join(broken, EXPLAINER_FILES.captions), 'not captions')
		expect(await loadExplainerAssets(broken)).toBeUndefined()

		const { app, store } = fixture(undefined)
		for (const path of Object.values(EXPLAINER_ROUTES)) expect((await get(app, path)).status).toBe(404)
		const page = await (await get(app, '/')).text()
		expect(page).not.toMatch(/<video|\/assets\/explainer/)
		store.close()
	})
})

describe('signed-out player', () => {
	test('embeds the video without autoplay and keeps the page useful without it', async () => {
		const { assets } = await explainer()
		const { app, store } = fixture(assets)
		const landing = await get(app, '/')
		const policy = landing.headers.get('content-security-policy')!
		expect(policy).toContain("media-src 'self'")
		expect(policy).toContain("default-src 'none'")
		const page = await landing.text()

		const player = /<video[^>]*>/.exec(page)![0]
		for (const attribute of ['controls', 'playsinline', 'preload="metadata"', `poster="${EXPLAINER_ROUTES.poster}"`]) {
			expect(player).toContain(attribute)
		}
		expect(player).not.toMatch(/autoplay|loop|muted/)
		const track = /<track[^>]*>/.exec(page)![0]
		expect(track).toContain('kind="captions"')
		expect(track).toContain('srclang="en"')
		expect(track).not.toContain('default')
		expect(page).toContain(`href="${EXPLAINER_ROUTES.transcript}"`)
		expect(page).toContain('Watch · 1 min 38 s')

		// The full text argument and restricted sign-in remain.
		expect(page).toContain('It is not measured attention.')
		expect(page).toContain('<a class="button" href="/auth/github">Sign in with GitHub</a>')
		expect(page).not.toMatch(/<script|<form|<iframe|style=/i)
		expect(page).not.toMatch(/sign up now|join the|get started|download|install cukup|clone/i)

		// External links are allowed, but media and styles must stay local.
		const ids = new Set([...page.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]))
		for (const [, attribute, value] of page.matchAll(/ (href|src|poster)="([^"]+)"/g)) {
			if (value!.startsWith('#')) expect(ids).toContain(value!.slice(1))
			else {
				expect([
					'/auth/github',
					'/assets/favicon.svg',
					'/assets/dashboard.css',
					'https://ampcode.com/',
					// The canonical link, which must be absolute.
					'https://cukup.dev/',
					...(attribute === 'href' ? ['https://github.com/zainfathoni/cukup'] : []),
					...Object.values(EXPLAINER_ROUTES),
				]).toContain(value!)
			}
			expect(attribute).toBeDefined()
		}
		const levels = [...page.matchAll(/<h([1-6])[\s>]/g)].map((match) => Number(match[1]))
		for (let index = 1; index < levels.length; index++) {
			expect(levels[index]!).toBeLessThanOrEqual(levels[index - 1]! + 1)
		}
		store.close()
	})

	test('leaves the signed-in dashboard policy without media', async () => {
		const { assets } = await explainer()
		const { app, store } = fixture(assets)
		const session = await signIn(app)
		const dashboard = await get(app, '/', { headers: { cookie: session } })
		expect(dashboard.status).toBe(200)
		const policy = dashboard.headers.get('content-security-policy')!
		expect(policy).not.toContain('media-src')
		expect(policy).toContain("'nonce-")
		expect(await dashboard.text()).not.toContain('<video')
		store.close()
	})
})

describe('shipped explainer files', () => {
	test('load from the repository with the expected formats', async () => {
		const assets = await loadExplainerAssets(fileURLToPath(new URL('../../media/motion-explainer', import.meta.url)))
		expect(assets).toBeDefined()
		expect(assets!.video.size).toBeGreaterThan(1_000_000)
		expect(assets!.durationLabel).toBe('1 min 38 s')
		expect(assets!.transcriptHtml).not.toMatch(/github\.com|<script/i)
	})

	test('keep the transcript renderer to headings, paragraphs, emphasis, and strong text', () => {
		const page = renderTranscriptPage('# Title\n\n[link](https://example.com) <img src=x>\n')
		expect(page).toContain('<p>[link](https://example.com) &lt;img src=x&gt;</p>')
		expect(page).not.toContain('<a href="https://example.com"')
	})
})
