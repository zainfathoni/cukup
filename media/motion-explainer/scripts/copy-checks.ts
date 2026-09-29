/**
 * Checks the explainer copy: reading time and claims it must not make.
 * docs.ts runs these before it writes anything; a test runs them in `bun run check`.
 */
import { endCard, scenes, timeline } from '../src/scenes.js'

const words = (text: string) => text.split(/\s+/).filter((word) => /\w/.test(word)).length
/** Reading time: 0.3 s per word, plus 1 s to find the text. */
const needed = (text: string) => words(text) * 0.3 + 1

// Claims the explainer must not make. Adapted from the landing-page tests.
const forbidden = [
	/sign up|join the|get started|download|install cukup|clone|self-host now|try it/i,
	/measures? (your )?(attention|focus|productivity|wellbeing|quality)/i,
	/(reduces|prevents|cures) (burnout|stress)|improves? (your )?(wellbeing|productivity)/i,
	/open[- ]source (now|today)|now open source|available to everyone/i,
]

export function copyProblems(source: typeof scenes = scenes, card: typeof endCard = endCard): string[] {
	const problems: string[] = []
	const timed = timeline(source)

	for (const scene of timed) {
		for (const line of scene.lines) {
			if (line.hold + 1e-9 < needed(line.text)) {
				problems.push(`"${line.text}" holds ${line.hold}s; it needs ${needed(line.text).toFixed(1)}s`)
			}
			if (words(line.text) > 14) problems.push(`"${line.text}" has more than 14 words`)
		}
	}

	// End-card text is fully visible from the end of its fade until the video ends.
	const close = timed.at(-1)!
	const lastLineEnd = close.lines.at(-1)!.end
	for (const item of ['url', 'invitation', 'status'] as const) {
		const { at, fade } = card.reveal[item]
		const hold = close.end - (lastLineEnd + at + fade)
		if (hold + 1e-9 < needed(card[item])) {
			problems.push(`End card ${item} "${card[item]}" holds ${hold.toFixed(2)}s; it needs ${needed(card[item]).toFixed(1)}s`)
		}
	}

	const allCopy = [
		...timed.flatMap((scene) => scene.lines.flatMap((line) => [line.text, ...(line.say ? [line.say] : [])])),
		card.url,
		card.invitation,
		card.status,
		card.caption,
		card.say,
	]
	for (const text of allCopy) {
		for (const pattern of forbidden) if (pattern.test(text)) problems.push(`"${text}" matches ${pattern}`)
	}
	return problems
}
