/**
 * Places each narration clip at its line and writes narration.m4a.
 * Run through scripts/voice.ts.
 */
import { duration, endCard, endKey, speechDelay, timeline } from '../src/scenes.js'
import { narration } from '../src/generated/narration.js'

const root = new URL('..', import.meta.url).pathname
const voiceDir = `${root}out/voice`

const scenes = timeline()
const close = scenes.at(-1)!
const cues = [
	...scenes.flatMap((scene) => scene.lines.map((line) => ({ key: line.key, at: line.start + speechDelay, until: line.end }))),
	{ key: endKey, at: close.lines.at(-1)!.end + endCard.speechAt, until: duration },
]

// Speech must finish inside its line and never overlap the next clip.
for (const [index, cue] of cues.entries()) {
	const end = cue.at + narration.durations[cue.key]!
	const next = cues[index + 1]
	if (end > cue.until + 1e-6 || (next && end > next.at)) throw new Error(`${cue.key} overruns its line`)
}

const inputs = cues.flatMap((cue) => ['-i', `${voiceDir}/${cue.key}.wav`])
const delays = cues.map((cue, index) => `[${index}:a]adelay=${Math.round(cue.at * 1000)}:all=1[a${index}]`)
const filter = `${delays.join(';')};${cues.map((_, index) => `[a${index}]`).join('')}amix=inputs=${cues.length}:normalize=0:dropout_transition=0,apad,atrim=0:${duration.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[out]`

const ffmpeg = Bun.spawn(
	['ffmpeg', '-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[out]', '-ac', '1', '-c:a', 'aac', '-b:a', '128k', `${root}narration.m4a`],
	{ stdout: 'inherit', stderr: 'inherit' },
)
if ((await ffmpeg.exited) !== 0) throw new Error('ffmpeg mix failed')
console.log(`Wrote narration.m4a: ${cues.length} clips over ${duration.toFixed(1)} s`)
