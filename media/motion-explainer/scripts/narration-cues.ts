/**
 * Where each narration clip plays, and a fingerprint that ties narration.m4a
 * to the copy and timing it was mixed for. No side effects, so tests can
 * import it.
 */
import { createHash } from 'node:crypto'
import { endCard, endKey, scenes, speechDelay, timeline } from '../src/scenes.js'

export type NarrationCue = { key: string; spoken: string; at: number; until: number }
export type Narration = { voice: string | null; speed: number | null; durations: Record<string, number> }

/** One cue per spoken line, plus the end card. `source` defaults to the current scenes. */
export function narrationCues(source: typeof scenes = scenes): NarrationCue[] {
	const timed = timeline(source)
	const close = timed.at(-1)!
	const total = close.end
	return [
		...timed.flatMap((scene) =>
			scene.lines.map((line) => ({
				key: line.key,
				spoken: line.say ?? line.text,
				at: line.start + speechDelay,
				until: line.end,
			})),
		),
		{ key: endKey, spoken: endCard.say, at: close.lines.at(-1)!.end + endCard.speechAt, until: total },
	]
}

/** A hash of the spoken words, the voice, each clip's length, and each cue's timing. */
export function narrationFingerprint(cues: NarrationCue[], narration: Narration): string {
	const ms = (seconds: number) => Math.round(seconds * 1000)
	const facts = {
		voice: narration.voice,
		speed: narration.speed,
		cues: cues.map((cue) => [cue.key, cue.spoken, ms(narration.durations[cue.key] ?? -1), ms(cue.at), ms(cue.until)]),
	}
	return createHash('sha256').update(JSON.stringify(facts)).digest('hex')
}

/** Throws when narration.m4a was not mixed for the current copy and timing. */
export function assertNarrationCurrent(recorded: string | null, cues: NarrationCue[], narration: Narration): void {
	if (recorded !== narrationFingerprint(cues, narration)) {
		throw new Error('narration.m4a does not match the current copy or timing. Run scripts/voice.ts, then render again.')
	}
}
