/**
 * Generates the storyboard, captions, and transcript from src/scenes.js, and
 * checks the copy. Run it after every change to the story.
 *
 *   bun media/motion-explainer/scripts/docs.ts
 */
import { audience, duration, endCard, idea, timeline, video } from '../src/scenes.js'

const root = new URL('..', import.meta.url).pathname
const scenes = timeline()

/* ---------- Checks ---------- */

const problems: string[] = []
const words = (text: string) => text.split(/\s+/).filter((word) => /\w/.test(word)).length

for (const scene of scenes) {
	for (const line of scene.lines) {
		// Reading time: 0.3 s per word, plus 1 s to find the line.
		const needed = words(line.text) * 0.3 + 1
		if (line.hold + 1e-9 < needed) {
			problems.push(`"${line.text}" holds ${line.hold}s; it needs ${needed.toFixed(1)}s`)
		}
		if (words(line.text) > 14) problems.push(`"${line.text}" has more than 14 words`)
	}
}

// Claims the explainer must not make. Adapted from the landing-page tests.
const forbidden = [
	/sign up|join the|get started|download|install cukup|clone|self-host now|try it/i,
	/measures? (your )?(attention|focus|productivity|wellbeing|quality)/i,
	/(reduces|prevents|cures) (burnout|stress)|improves? (your )?(wellbeing|productivity)/i,
	/open[- ]source (now|today)|now open source|available to everyone/i,
]
const allCopy = [
	...scenes.flatMap((scene) => scene.lines.map((line) => line.text)),
	endCard.url,
	endCard.invitation,
	endCard.status,
]
for (const text of allCopy) {
	for (const pattern of forbidden) if (pattern.test(text)) problems.push(`"${text}" matches ${pattern}`)
}

if (problems.length > 0) {
	console.error(problems.join('\n'))
	process.exit(1)
}

/* ---------- Formats ---------- */

const stamp = (seconds: number) => {
	const ms = Math.round(seconds * 1000)
	const h = String(Math.floor(ms / 3_600_000)).padStart(2, '0')
	const m = String(Math.floor(ms / 60_000) % 60).padStart(2, '0')
	const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0')
	return `${h}:${m}:${s}.${String(ms % 1000).padStart(3, '0')}`
}
const short = (seconds: number) =>
	`${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`
const kindLabel = { conceptual: 'Conceptual illustration', product: 'Product behavior · synthetic data', title: 'Title' }

/* ---------- Captions ---------- */

const close = scenes.at(-1)!
const endStart = close.lines.at(-1)!.end
const cues = [
	...scenes.flatMap((scene) => scene.lines.map((line) => ({ start: line.start, end: line.end, text: line.text }))),
	{ start: endStart, end: duration, text: `${endCard.url}\n${endCard.status}` },
]
await Bun.write(
	`${root}captions.en.vtt`,
	`WEBVTT\n\nNOTE The video has no audio. These cues repeat the on-screen text. Generated from src/scenes.js.\n\n${cues
		.map((cue, index) => `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}`)
		.join('\n\n')}\n`,
)

/* ---------- Transcript ---------- */

const transcript = `# Cukup: enough — transcript and text equivalent

This is a text equivalent of the motion explainer. The video has no audio. Every line below also appears on screen. Descriptions in italics explain the visuals.

All data is synthetic. Illustrations marked *conceptual* show ideas, not Cukup features.

${scenes
	.map(
		(scene) =>
			`## ${scene.title} (${short(scene.start)}–${short(scene.end)})\n\n*${kindLabel[scene.kind as keyof typeof kindLabel]}. ${scene.action}*\n\n${scene.lines.map((line) => line.text).join('\n\n')}`,
	)
	.join('\n\n')}

*End card:* **${endCard.url}**. ${endCard.invitation} ${endCard.status}.
`
await Bun.write(`${root}transcript.md`, transcript)

/* ---------- Storyboard ---------- */

const escape = (text: string) => text.replaceAll('|', '\\|')
const storyboard = `# Storyboard: Cukup motion explainer

Generated from [\`src/scenes.js\`](src/scenes.js). Edit that file, then run \`bun media/motion-explainer/scripts/docs.ts\`.

- **Audience:** ${audience}
- **The one idea to remember:** ${idea}
- **Format:** ${video.width} × ${video.height}, ${video.fps} fps, ${duration.toFixed(1)} s, no audio. The story is told in on-screen text.
- **Kinds:** *Conceptual* scenes illustrate ideas. Cukup does not count, detect, or show them. *Product* scenes show the current Working Time rule and the real Today card, with synthetic data. *Title* scenes are words only.

Review the whole sequence in the [contact sheet](contact-sheet.png) before rendering.

## Scenes

| # | Scene | Time | Duration | Kind | Purpose | On-screen copy | Action | Transition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${scenes
	.map(
		(scene, index) =>
			`| ${index + 1} | ${scene.title} | ${short(scene.start)}–${short(scene.end)} | ${(scene.end - scene.start).toFixed(1)} s | ${kindLabel[scene.kind as keyof typeof kindLabel]} | ${escape(scene.purpose)} | ${scene.lines.map((line) => `“${escape(line.text)}”`).join('<br>')} | ${escape(scene.action)} | ${escape(scene.transition)} |`,
	)
	.join('\n')}

End card: **${endCard.url}** · ${endCard.invitation} · ${endCard.status}

## What is conceptual, and what is product behavior?

| Element | Kind | Source |
| --- | --- | --- |
| Person, agents, result cards, question tags | Conceptual | Invented for the story. Cukup does not see prompts, results, or reviews. |
| Attention ring | Conceptual | A metaphor. Nothing measures attention. |
| “AI can help” and “Stays with you” sort | Conceptual | A human practice. Cukup has no delegation feature. |
| Notice, Remember, Be kind | Conceptual | Self-compassion in everyday words. Not a feature, not therapy. |
| Turn bars, 15-minute extension, union row, 1h 22m | Product rule | [\`service/aggregation.ts\`](../../service/aggregation.ts), the same example as the landing page. |
| Full-day row and 8h 7m | Product rule | Synthetic events in [\`product/synthetic-day.ts\`](product/synthetic-day.ts), computed by the service code. |
| Today card: 8h 7m, OVER, 7m over target, target 8h 0m | Product view | A screenshot of the real renderer and CSS, from [\`scripts/prepare.ts\`](scripts/prepare.ts). |
| “Next task” card moved to “Tomorrow” | Conceptual | The person decides. Cukup has no button that stops agents, approves work, or enforces limits. |

## Factual limits kept in the copy

- Working Time is an estimate from Amp turns. The video says it is not measured attention.
- The video does not treat agent runtime as human effort. Parallel turns count once.
- The video claims no change in quality, productivity, stress, burnout, or wellbeing, and shows no testimonials.
- Status: a personal dashboard, Amp only, and an open-source release in preparation. There is no public signup.
- The close sends people to cukup.dev to read. It does not offer access.
`
await Bun.write(`${root}storyboard.md`, storyboard)

console.log(`Duration ${duration.toFixed(1)} s · ${scenes.length} scenes · ${cues.length} cues · checks passed`)
