/**
 * Checks the explainer player on the signed-out page in Chromium, through the
 * real backend served by the local preview.
 *
 *   PORT=4173 bun run service/dashboard/preview.ts &
 *   bun media/motion-explainer/scripts/verify-landing.ts
 *
 * Writes screenshots to docs/tests/landing-explainer/assets/ and prints one
 * line per check. Exits non-zero when a check fails.
 */
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EXPLAINER_ROUTES } from '../../../service/dashboard/explainer.ts'
import { launchChromium } from './browser.ts'

const base = process.env.PREVIEW_URL ?? 'http://localhost:4173'
const assets = fileURLToPath(new URL('../../../docs/tests/landing-explainer/assets/', import.meta.url))
mkdirSync(assets, { recursive: true })

const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => {
	results.push({ name, ok, detail })
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchChromium>>['newPage']>>

/** Records CSP violations and console errors on a page. */
async function watch(page: Page) {
	const problems: string[] = []
	page.on('console', (message) => {
		if (message.type() === 'error') problems.push(message.text())
	})
	page.on('pageerror', (error) => problems.push(error.message))
	await page.addInitScript(() => {
		document.addEventListener('securitypolicyviolation', (event) => {
			console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`)
		})
	})
	return problems
}

const video = (page: Page) => page.locator('#explainer video')

/* ---------- Default launch: no autoplay, poster, layout ---------- */

{
	const browser = await launchChromium()
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' })
	const page = await context.newPage()
	const problems = await watch(page)
	const statuses = new Map<string, number>()
	page.on('response', (response) => statuses.set(new URL(response.url()).pathname, response.status()))
	await page.goto(`${base}/signed-out`, { waitUntil: 'networkidle' })

	const codec = await page.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"'))
	check('Chromium can play H.264 with AAC', codec === 'probably' || codec === 'maybe', `canPlayType = "${codec}"`)

	await page.waitForTimeout(3000)
	const idle = await video(page).evaluate((element: HTMLVideoElement) => ({
		paused: element.paused,
		time: element.currentTime,
		autoplay: element.autoplay,
		muted: element.muted,
		loop: element.loop,
	}))
	check('Does not autoplay, loop, or start muted', idle.paused && idle.time === 0 && !idle.autoplay && !idle.loop && !idle.muted, JSON.stringify(idle))
	const posterStatus = statuses.get(EXPLAINER_ROUTES.poster)
	check('Poster loads', posterStatus === 200, `poster status ${posterStatus}`)
	check('Metadata loads without playback', (await video(page).evaluate((element: HTMLVideoElement) => element.duration)) > 98)

	await page.locator('#explainer').screenshot({ path: `${assets}desktop-light.png` })
	await context.close()

	for (const [name, options] of [
		['desktop-dark', { viewport: { width: 1280, height: 900 }, colorScheme: 'dark' as const }],
		['mobile-light', { viewport: { width: 390, height: 844 }, colorScheme: 'light' as const, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
		['mobile-dark', { viewport: { width: 390, height: 844 }, colorScheme: 'dark' as const, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
		['reduced-motion', { viewport: { width: 1280, height: 900 }, colorScheme: 'light' as const, reducedMotion: 'reduce' as const }],
	] as const) {
		const other = await browser.newContext(options)
		const view = await other.newPage()
		const viewProblems = await watch(view)
		await view.goto(`${base}/signed-out`, { waitUntil: 'networkidle' })
		await view.waitForTimeout(1500)
		const state = await video(view).evaluate((element: HTMLVideoElement) => ({
			paused: element.paused,
			width: element.getBoundingClientRect().width,
			height: element.getBoundingClientRect().height,
		}))
		const overflow = await view.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
		const ratio = state.width / state.height
		check(`${name}: paused, 16:9, no horizontal overflow`, state.paused && Math.abs(ratio - 16 / 9) < 0.02 && overflow === 0, `ratio ${ratio.toFixed(3)}, overflow ${overflow}px`)
		check(`${name}: no CSP violation or console error`, viewProblems.length === 0, viewProblems.join(' | '))
		await view.locator('#explainer').screenshot({ path: `${assets}${name}.png` })
		await other.close()
	}

	// Narrow screen with 200% text, measured on the whole page after layout settles.
	// Font metrics differ between machines, so a wide stress font runs too.
	const narrow = await browser.newContext({ viewport: { width: 320, height: 800 }, colorScheme: 'light' })
	const narrowPage = await narrow.newPage()
	await narrowPage.goto(`${base}/signed-out`, { waitUntil: 'networkidle' })
	for (const font of [null, 'Noto Sans Mono']) {
		// CSSOM, not a style tag: the page's CSP rightly blocks injected inline styles.
		await narrowPage.evaluate((family) => {
			document.documentElement.style.setProperty('font-size', '200%', 'important')
			if (family) document.body.style.setProperty('font-family', family, 'important')
		}, font)
		await narrowPage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
		await narrowPage.waitForTimeout(500)
		const measured = await narrowPage.evaluate(() => {
			const width = document.documentElement.clientWidth
			const outside = [...document.querySelectorAll('body *')]
				.filter((element) => element.getBoundingClientRect().right > width + 0.5)
				.slice(0, 5)
				.map((element) => `${element.tagName.toLowerCase()}.${element.className} to ${element.getBoundingClientRect().right.toFixed(1)}`)
			return { overflow: document.documentElement.scrollWidth - width, outside }
		})
		const label = font ? `320px, 200% text, ${font}` : '320px, 200% text'
		check(`${label}: no horizontal overflow on the whole page`, measured.overflow === 0 && measured.outside.length === 0, `overflow ${measured.overflow}px${measured.outside.length ? `; outside: ${measured.outside.join(', ')}` : ''}`)
		const suffix = font ? '-wide-font' : ''
		await narrowPage.locator('#explainer').screenshot({ path: `${assets}320-text-200${suffix}.png` })
		await narrowPage.locator('#status').screenshot({ path: `${assets}320-text-200-status${suffix}.png` })
	}
	await narrow.close()

	check('Default launch: no CSP violation or console error', problems.length === 0, problems.join(' | '))
	await browser.close()
}

/* ---------- Playback, pause, seeking, captions ---------- */

{
	// Headless Chromium refuses unmuted play() without a gesture; this flag stands in for the click.
	process.env.CHROMIUM_EXTRA_ARGS = '--autoplay-policy=no-user-gesture-required'
	const browser = await launchChromium()
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
	const problems = await watch(page)
	const ranges: string[] = []
	page.on('response', (response) => {
		if (response.url().endsWith('.mp4') && response.status() === 206) ranges.push(response.headers()['content-range'] ?? '')
	})
	await page.goto(`${base}/signed-out`, { waitUntil: 'networkidle' })
	const player = video(page)

	await player.evaluate((element: HTMLVideoElement) => element.play())
	await page.waitForFunction(() => document.querySelector<HTMLVideoElement>('#explainer video')!.currentTime > 1.5, null, { timeout: 15_000 })
	check('Plays', true, `currentTime ${(await player.evaluate((element: HTMLVideoElement) => element.currentTime)).toFixed(2)} s`)
	check('Has an audio track', await player.evaluate((element: HTMLVideoElement & { webkitAudioDecodedByteCount?: number }) => (element.webkitAudioDecodedByteCount ?? 0) > 0))

	await player.evaluate((element: HTMLVideoElement) => element.pause())
	const pausedAt = await player.evaluate((element: HTMLVideoElement) => element.currentTime)
	await page.waitForTimeout(800)
	const stillAt = await player.evaluate((element: HTMLVideoElement) => element.currentTime)
	check('Pauses', pausedAt === stillAt, `${pausedAt.toFixed(3)} s → ${stillAt.toFixed(3)} s`)

	const seeked = await player.evaluate(
		(element: HTMLVideoElement) =>
			new Promise<{ time: number; readyState: number }>((resolve) => {
				element.addEventListener('seeked', () => resolve({ time: element.currentTime, readyState: element.readyState }), { once: true })
				element.currentTime = 72
			}),
	)
	check('Seeks to 72 s', Math.abs(seeked.time - 72) < 0.5 && seeked.readyState >= 2, JSON.stringify(seeked))
	check('Uses byte-range responses', ranges.length > 0, `${ranges.length} responses with 206, e.g. ${ranges.at(-1)}`)

	const cue = await player.evaluate(
		(element: HTMLVideoElement) =>
			new Promise<string>((resolve) => {
				const track = element.textTracks[0]!
				track.mode = 'showing'
				const read = () => {
					const active = track.activeCues
					if (active && active.length > 0) resolve((active[0] as VTTCue).text)
				}
				track.addEventListener('cuechange', read)
				element.addEventListener('seeked', () => setTimeout(read, 200), { once: true })
				element.currentTime = 9
			}),
	)
	check('Shows English captions', cue === 'An agent can write code in minutes.', `active cue at 9 s: "${cue}"`)
	await player.evaluate((element: HTMLVideoElement) => element.pause())
	await page.waitForTimeout(500)
	await page.locator('#explainer').screenshot({ path: `${assets}captions-showing.png` })
	check('Playback: no CSP violation or console error', problems.length === 0, problems.join(' | '))
	await browser.close()
}

/* ---------- Keyboard and transcript ---------- */

{
	const browser = await launchChromium()
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
	const problems = await watch(page)
	await page.goto(`${base}/signed-out`, { waitUntil: 'networkidle' })
	const stops: string[] = []
	for (let index = 0; index < 20; index++) {
		await page.keyboard.press('Tab')
		stops.push(await page.evaluate(() => {
			const active = document.activeElement as HTMLElement
			return active.tagName === 'VIDEO' ? 'video' : active.getAttribute('href') ?? active.tagName.toLowerCase()
		}))
		if (stops.at(-1) === '/explainer/transcript') break
	}
	check('Keyboard reaches the player and the transcript link', stops.includes('video') && stops.includes('/explainer/transcript'), stops.join(' → '))
	await page.locator('#explainer figcaption').screenshot({ path: `${assets}transcript-link-focus.png` })
	const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)
	check('Focused link shows an outline', outline !== 'none', `outline-style ${outline}`)

	await page.keyboard.press('Enter')
	await page.waitForURL('**/explainer/transcript')
	const heading = await page.locator('h1').innerText()
	check('Transcript opens with its heading', heading.startsWith('Cukup: enough'), heading)
	const transcriptOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
	check('Transcript has no horizontal overflow', transcriptOverflow === 0)
	await page.screenshot({ path: `${assets}transcript.png` })
	check('Keyboard and transcript: no CSP violation or console error', problems.length === 0, problems.join(' | '))
	await browser.close()
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exit(1)
