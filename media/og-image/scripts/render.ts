/**
 * Renders src/index.html to og-image.png at 1200 × 630, and writes review
 * previews at typical link-card sizes to out/.
 *
 *   bun media/og-image/scripts/render.ts
 *
 * Prerequisites: Chromium, Playwright, ImageMagick 7, and the Noto Sans Black
 * and Noto Sans Mono Bold fonts. See README.md.
 */
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { launchChromium } from '../../motion-explainer/scripts/browser.ts'

// fileURLToPath decodes the URL, so a checkout path with spaces works.
const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = `${root}out`
mkdirSync(outDir, { recursive: true })
const output = `${root}og-image.png`

const browser = await launchChromium()
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, colorScheme: 'light' })
const errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('requestfailed', (request) => errors.push(`${request.url()} failed`))
await page.goto(`file://${root}src/index.html`)
await page.evaluate(() => document.fonts.ready)

// A local() font that is not installed falls back silently. Refuse to render with a fallback.
const missing = await page.evaluate(() =>
	[...document.fonts].filter((face) => face.status !== 'loaded').map((face) => `${face.family} ${face.weight}`),
)
if (missing.length > 0) errors.push(`Fonts not loaded: ${missing.join(', ')}`)

// Refuse text that leaves the safe area: 80 px from the sides, 48 px from the top and bottom.
const outside = await page.evaluate(() => {
	const card = document.querySelector('#card')!.getBoundingClientRect()
	return [...document.querySelectorAll('#card > *, #card mark')]
		.filter((element) => {
			const box = element.getBoundingClientRect()
			return box.left < card.left + 80 || box.right > card.right - 80 || box.top < card.top + 48 || box.bottom > card.bottom - 48
		})
		.map((element) => element.className || element.tagName)
})
if (outside.length > 0) errors.push(`Outside the safe area: ${outside.join(', ')}`)
// Some apps crop to the center square. Keep the headline, with its tilted highlight, 8 px inside it.
const headline = await page.evaluate(() => {
	const box = document.querySelector('#card mark')!.closest('h1')!.getBoundingClientRect()
	const mark = document.querySelector('#card mark')!.getBoundingClientRect()
	return { left: Math.min(box.left, mark.left), right: Math.max(box.right, mark.right) }
})
const square = { left: (1200 - 630) / 2 + 8, right: (1200 + 630) / 2 - 8 }
if (headline.left < square.left || headline.right > square.right) errors.push('The headline is wider than the center square')
if (errors.length > 0) throw new Error(errors.join('\n'))

await page.locator('#card').screenshot({ path: output, type: 'png', animations: 'disabled', caret: 'hide' })
await browser.close()

async function run(command: string[]) {
	const process = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit' })
	if ((await process.exited) !== 0) throw new Error(`${command[0]} failed`)
}

// Flat colors compress well as an 8-bit palette. -strip drops timestamps, so a re-render is byte-identical.
await run(['magick', output, '-strip', '+dither', '-colors', '64', `PNG8:${output}`])
// Review previews: two common link-card widths, and the center square that some apps crop to.
for (const width of [600, 300]) {
	await run(['magick', output, '-resize', `${width}x`, `${outDir}/preview-${width}.png`])
}
await run(['magick', output, '-gravity', 'center', '-crop', '630x630+0+0', '+repage', '-resize', '200x200', `${outDir}/preview-square-200.png`])
console.log(`Wrote og-image.png (${Bun.file(output).size} bytes) and previews in out/`)
