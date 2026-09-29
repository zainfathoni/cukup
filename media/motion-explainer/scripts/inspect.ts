/**
 * Inspects the final MP4, not the source: decoded frames, not renders.
 *
 * - out/inspect-sheet-N.png: two frames per second, 24 per sheet.
 * - out/inspect-boundary-N.png: frames from 0.5 s before to 0.5 s after each scene boundary.
 * - A report of container facts and of every abrupt change between frames.
 *
 *   bun media/motion-explainer/scripts/inspect.ts
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { timeline } from '../src/scenes.js'

const root = new URL('..', import.meta.url).pathname
const input = `${root}cukup-explainer.mp4`
const out = `${root}out`
mkdirSync(out, { recursive: true })

async function capture(command: string[]): Promise<string> {
	const process = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
	const [stdout, stderr] = [await new Response(process.stdout).text(), await new Response(process.stderr).text()]
	if ((await process.exited) !== 0) throw new Error(`${command[0]} failed:\n${stderr}`)
	return stdout + stderr
}

const probe = JSON.parse(
	await capture(['ffprobe', '-v', 'error', '-show_entries', 'format=duration,size,bit_rate:stream=codec_name,width,height,r_frame_rate,pix_fmt,nb_frames', '-of', 'json', input]),
)
const stream = probe.streams[0]
console.log(
	`Container: ${stream.codec_name} ${stream.width}×${stream.height} ${stream.pix_fmt} ${stream.r_frame_rate} fps, ${stream.nb_frames} frames, ${Number(probe.format.duration).toFixed(2)} s, ${(Number(probe.format.size) / 1_048_576).toFixed(2)} MiB, ${probe.streams.length} stream(s)`,
)

// Two frames per second, in sheets.
const sampled = `${out}/sampled`
rmSync(sampled, { recursive: true, force: true })
mkdirSync(sampled)
await capture(['ffmpeg', '-v', 'error', '-i', input, '-vf', 'fps=2,scale=480:-1', `${sampled}/%04d.png`])
const frames = readdirSync(sampled).sort()
for (let sheet = 0; sheet * 24 < frames.length; sheet += 1) {
	const batch = frames.slice(sheet * 24, sheet * 24 + 24)
	await capture([
		'magick', 'montage',
		...batch.flatMap((file) => ['-label', `${((Number(file.slice(0, 4)) - 1) / 2).toFixed(1)} s`, `${sampled}/${file}`]),
		'-pointsize', '14', '-geometry', '+4+18', '-tile', '6x', '-background', '#1c1814', '-fill', '#f5e7d2',
		`${out}/inspect-sheet-${sheet + 1}.png`,
	])
}
console.log(`Sheets: ${Math.ceil(frames.length / 24)} (${frames.length} frames at 2 fps)`)

// Dense frames around each scene boundary.
const boundaries = timeline().slice(1).map((scene) => scene.start)
for (const [index, at] of boundaries.entries()) {
	const dir = `${out}/boundary-${index + 1}`
	rmSync(dir, { recursive: true, force: true })
	mkdirSync(dir)
	await capture(['ffmpeg', '-v', 'error', '-ss', String(Math.max(0, at - 0.5)), '-i', input, '-t', '1', '-vf', 'fps=10,scale=480:-1', `${dir}/%02d.png`])
	const files = readdirSync(dir).sort()
	await capture([
		'magick', 'montage',
		...files.flatMap((file, i) => ['-label', `${(at - 0.5 + i / 10).toFixed(1)} s`, `${dir}/${file}`]),
		'-pointsize', '14', '-geometry', '+4+18', '-tile', '5x', '-background', '#1c1814', '-fill', '#f5e7d2',
		`${out}/inspect-boundary-${index + 1}.png`,
	])
}
console.log(`Boundaries: ${boundaries.map((at) => at.toFixed(1)).join(', ')} s`)

// Abrupt changes. The explainer has no hard cuts, so each one is a candidate jump.
const log = await capture(['ffmpeg', '-v', 'info', '-i', input, '-vf', "select='gt(scene,0.12)',showinfo", '-f', 'null', '-'])
const jumps = [...log.matchAll(/pts_time:([\d.]+)/g)].map((match) => Number(match[1]))
console.log(jumps.length === 0 ? 'Abrupt changes (scene score > 0.12): none' : `Abrupt changes (scene score > 0.12) at: ${jumps.map((t) => t.toFixed(2)).join(', ')} s`)
