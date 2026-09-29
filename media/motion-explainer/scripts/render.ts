/**
 * Renders the explainer from src/. Each frame is drawn by `seek(t)` and
 * captured by Chromium, so the output is the same on every run.
 *
 *   bun media/motion-explainer/scripts/render.ts video     # cukup-explainer.mp4
 *   bun media/motion-explainer/scripts/render.ts poster    # poster.png
 *   bun media/motion-explainer/scripts/render.ts contact   # contact-sheet.png
 *   bun media/motion-explainer/scripts/render.ts stills 12.5 40   # out/still-*.png
 *
 * Prerequisites: Chromium, Playwright, ffmpeg, ImageMagick, Noto Sans, and
 * Noto Sans Mono. The video also needs narration.m4a from scripts/voice.ts.
 * See README.md.
 */
import { mkdirSync } from 'node:fs'
import { duration, timeline, video } from '../src/scenes.js'
import { launchChromium } from './browser.ts'

const root = new URL('..', import.meta.url).pathname
const outDir = `${root}out`
mkdirSync(outDir, { recursive: true })

const types: Record<string, string> = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.png': 'image/png',
}
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname.replace(/^\/$/, '/index.html')
		if (path === '/favicon.ico') return new Response(null, { status: 204 })
		if (path.includes('..')) return new Response('Not found', { status: 404 })
		const file = Bun.file(`${root}src${path}`)
		if (!(await file.exists())) return new Response('Not found', { status: 404 })
		return new Response(file, { headers: { 'content-type': types[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream' } })
	},
})

const browser = await launchChromium()
const page = await browser.newPage({
	viewport: { width: video.width, height: video.height },
	deviceScaleFactor: 1,
	colorScheme: 'light',
})
const errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => {
	if (message.type() === 'error') errors.push(message.text())
})
await page.goto(`http://localhost:${server.port}/?render`)
await page.evaluate(() => (window as unknown as { explainer: { ready: Promise<void> } }).explainer.ready)
if (errors.length > 0) throw new Error(errors.join('\n'))

const stage = page.locator('#stage')
async function frame(t: number): Promise<Buffer> {
	await page.evaluate((time) => (window as unknown as { explainer: { seek(t: number): void } }).explainer.seek(time), t)
	return stage.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' })
}

async function run(command: string[]) {
	const process = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit' })
	if ((await process.exited) !== 0) throw new Error(`${command[0]} failed`)
}

const mode = Bun.argv[2] ?? 'video'

if (mode === 'video') {
	const frames = Math.round(duration * video.fps)
	const output = `${root}cukup-explainer.mp4`
	// The narration is mixed against the same timeline. A length mismatch means it is stale.
	const audio = `${root}narration.m4a`
	const probe = Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audio])
	const audioSeconds = Number(probe.stdout.toString().trim())
	if (!(Math.abs(audioSeconds - duration) < 0.05)) {
		throw new Error(`narration.m4a lasts ${audioSeconds} s, the timeline ${duration.toFixed(2)} s. Run scripts/voice.ts.`)
	}
	const ffmpeg = Bun.spawn(
		[
			'ffmpeg', '-y', '-loglevel', 'error',
			'-f', 'image2pipe', '-framerate', String(video.fps), '-c:v', 'png', '-i', '-',
			'-i', audio, '-map', '0:v', '-map', '1:a', '-c:a', 'copy',
			'-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-tune', 'animation',
			'-pix_fmt', 'yuv420p', '-r', String(video.fps), '-movflags', '+faststart',
			'-metadata', 'title=Cukup: enough',
			'-metadata', 'comment=Synthetic data. Conceptual illustrations are not Cukup features.',
			output,
		],
		{ stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' },
	)
	const started = performance.now()
	for (let index = 0; index < frames; index += 1) {
		ffmpeg.stdin.write(await frame(index / video.fps))
		if (index % (video.fps * 10) === 0) {
			console.log(`frame ${index}/${frames} · ${((performance.now() - started) / 1000).toFixed(0)} s`)
		}
	}
	await ffmpeg.stdin.end()
	if ((await ffmpeg.exited) !== 0) throw new Error('ffmpeg failed')
	console.log(`Wrote ${output}: ${frames} frames`)
} else if (mode === 'poster') {
	// The end card carries the idea, the name, and the destination on its own.
	await Bun.write(`${root}poster.png`, await frame(duration - 1 / video.fps))
	console.log('Wrote poster.png')
} else if (mode === 'stills') {
	for (const value of Bun.argv.slice(3)) {
		await Bun.write(`${outDir}/still-${Number(value).toFixed(2)}.png`, await frame(Number(value)))
	}
} else if (mode === 'contact') {
	// One panel per caption line, taken when its motion has settled, plus the end card.
	const shots = timeline().flatMap((scene, sceneIndex) =>
		scene.lines.map((line, lineIndex) => ({
			t: Math.min(line.end - 0.3, line.start + Math.max(2.2, line.hold * 0.75)),
			label: `${sceneIndex + 1}.${lineIndex + 1} ${scene.title} · ${scene.kind}`,
		})),
	)
	shots.push({ t: duration - 1 / video.fps, label: 'End card · title' })
	const files: string[] = []
	for (const [index, shot] of shots.entries()) {
		const file = `${outDir}/contact-${String(index).padStart(2, '0')}.png`
		await Bun.write(file, await frame(shot.t))
		files.push(file)
	}
	await run([
		'magick', 'montage',
		...shots.flatMap((shot, index) => ['-label', `${shot.t.toFixed(1)} s · ${shot.label}`, files[index]!]),
		'-font', 'Noto-Sans-Bold', '-pointsize', '15', '-geometry', '480x270+10+26', '-tile', '4x',
		'-background', '#fff4dd',
		`${root}contact-sheet.png`,
	])
	// Flat colors compress well as an 8-bit palette.
	await run(['magick', `${root}contact-sheet.png`, '+dither', '-colors', '128', `PNG8:${root}contact-sheet.png`])
	console.log(`Wrote contact-sheet.png: ${shots.length} panels`)
} else {
	throw new Error(`Unknown mode: ${mode}`)
}

await browser.close()
server.stop()
