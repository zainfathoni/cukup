/**
 * The single source of truth for the explainer's story and timing.
 *
 * The animation, captions, transcript, storyboard, and contact sheet all read
 * this file. Change copy or timing here. Then, from the repository root, run
 * scripts/voice.ts, scripts/docs.ts, and scripts/render.ts, in that order.
 * Speech durations change the timeline, so the voice comes first.
 *
 * Each scene starts where the previous one ends. Within a scene, `lead` is the
 * time before the first line, each line holds for `hold` seconds, and `tail`
 * is the time after the last line.
 *
 * Narration: each line is spoken as `say`, or as `text` when `say` is absent.
 * scripts/voice.ts measures every clip. A line then holds at least as long as
 * its speech plus a short pause, so the captions and the voice stay in step.
 *
 * `kind` separates what is invented for the story from what the product does:
 * - conceptual: an illustration of an idea. Cukup does not do or show this.
 * - product: the current Cukup Working Time rule or view, with synthetic data.
 * - title: words only.
 */

import { narration } from './generated/narration.js'

export const video = { width: 1920, height: 1080, fps: 30 }

/** Speech starts this long after its line appears. */
export const speechDelay = 0.2
/** The minimum silence after a line's speech, before the next line. */
const speechGap = 0.6

export const audience =
	'Developers and technical leads who use AI coding agents, and people who care about them. They may never install Cukup.'

export const idea = 'AI can do more work. People still decide what is enough.'

export const scenes = [
	{
		id: 'hook',
		title: 'A shared concern',
		kind: 'conceptual',
		purpose: 'Start with an experience the viewer already knows.',
		action:
			'Calm paper. A person node sends a prompt card along a connector to an agent node. The card enters the agent, and the agent starts to work.',
		transition: 'The same agent node starts to send out result cards.',
		lead: 0.4,
		lines: [
			{ text: 'AI was supposed to save us time.', hold: 3.3 },
			{ text: 'So why can coding with it still feel so tiring?', hold: 4.2 },
		],
		tail: 0.1,
	},
	{
		id: 'output',
		title: 'Output multiplies',
		kind: 'conceptual',
		purpose: 'Show that generation is fast and parallel.',
		action:
			'Result cards leave the agent along connectors and fill a grid. Two more agents branch from the first one. Each sends more cards. Every connector stays on its agent and its card.',
		transition: 'The connectors to the agents fade after each card arrives. The cards stay in place.',
		lead: 0,
		lines: [
			// The comma keeps “in” audible.
			{ text: 'An agent can write code in minutes.', say: 'An agent can write code, in minutes.', hold: 3.3 },
			{ text: 'It can run many tasks at once.', hold: 3.4 },
		],
		tail: 0.2,
	},
	{
		id: 'attention',
		title: 'Attention stays the same size',
		kind: 'conceptual',
		purpose: 'Show the choices and review that remain after generation.',
		action:
			'A question tag grows under each card: “Correct?”, “Safe?”, “Reversible?”. A connector runs from each tag to the person. A dashed ring around the person marks their attention. The ring does not grow. More cards arrive behind the grid.',
		transition: 'The tags stay attached to their cards when the next scene sorts them.',
		lead: 0.1,
		lines: [
			{ text: 'Each result still asks something of a person.', hold: 4.3 },
			{ text: 'More output does not give us more attention.', hold: 4.2 },
		],
		tail: 0.1,
	},
	{
		id: 'delegate',
		title: 'Delegate, keep judgment',
		kind: 'conceptual',
		purpose: 'Separate the work AI can help with from the judgment that stays human.',
		action:
			'A divider appears. The question tags move to the person’s side, under “Stays with you”. The result cards stay with the agents, under “AI can help”. Each card keeps its connector to its own tag, so the work and its judgment stay linked.',
		transition: 'The load returns: the agents send more cards toward the edges.',
		lead: 0.1,
		lines: [
			{ text: 'What can we hand off? What must stay ours?', hold: 3.8 },
			{ text: 'Let AI help with drafts, tests, and ideas.', hold: 3.7 },
			{ text: 'Keep the judgment: what matters, what is good enough, and who owns it.', hold: 5.2 },
		],
		tail: 0.1,
	},
	{
		id: 'compassion',
		title: 'Self-compassion',
		kind: 'conceptual',
		purpose: 'Offer a kinder response to overload than pushing harder.',
		action:
			'More cards crowd in. Then every card, tag, and agent drifts outward and fades. The person moves to the center, and their ring becomes a soft solid circle. Three labels grow from the person on short connectors: Notice, Remember, Be kind. The scene holds on space.',
		transition: 'The three labels return into the person. The person moves aside for the name.',
		lead: 0.1,
		lines: [
			{ text: 'When there is always more, it is easy to push harder.', hold: 4.4 },
			{ text: 'Notice it: “I am tired, and there is a lot to review.”', hold: 4.6 },
			{ text: 'Remember: struggling is not a private failure. Many people feel this.', hold: 4.6 },
			{ text: 'Be kind: choose a limit, as you would for a friend.', hold: 4.4 },
		],
		tail: 1.3,
	},
	{
		id: 'cukup',
		title: 'Cukup means enough',
		kind: 'title',
		purpose: 'Introduce the name and why the tool exists.',
		action: 'The wordmark “Cukup” writes in beside the person, with an “enough” tag and a pronunciation line.',
		transition: 'The wordmark moves to the top-right corner and stays as a small label.',
		lead: 0.2,
		lines: [{ text: 'Tools that help us do more need a partner that helps us pause.', hold: 5.2 }],
		tail: 0.5,
	},
	{
		id: 'working-time',
		title: 'One prompt to pause',
		kind: 'product',
		purpose: 'Show the verified Working Time rule and view, briefly and accurately.',
		action:
			'Three synthetic Amp turns draw on a 09:00–12:00 axis. Each grows a 15-minute extension. The bars drop into one Working Time row and merge. A note says the overlap counts once: 1h 22m. The axis zooms out to the full synthetic day, and the rest of the turns join the row. A connector carries the day total to the real Today card: 8h 7m, OVER, 7m over target. Last, a conceptual “Next task” card arrives at the person, and the person moves it to a “Tomorrow · your choice” slot. The chip changes to “Real Cukup view + conceptual choice”.',
		transition: 'Everything but the person clears.',
		lead: 0.2,
		lines: [
			{ text: 'Cukup counts each Amp turn, plus 15 minutes after it.', hold: 4.4 },
			{
				text: 'Across this synthetic day, that gives 8h 7m. The target is 8h 0m.',
				say: 'Across this synthetic day, that gives eight hours and seven minutes. The target is eight hours.',
				hold: 5.0,
			},
			{ text: 'It is an estimate, not measured attention.', hold: 3.4 },
			{ text: 'It is one prompt to ask: is this enough for today?', hold: 4.4 },
			{ text: 'Cukup does not decide. You do.', hold: 3.4 },
		],
		tail: 0.3,
	},
	{
		id: 'close',
		title: 'Invitation',
		kind: 'title',
		purpose: 'Leave one line to remember and an accurate destination.',
		action:
			'The closing line appears in large type. Then the end card shows cukup.dev and the current status: a personal dashboard, Amp only, and an open-source release in preparation.',
		transition: 'Hold on the end card, which is also the poster.',
		lead: 0.3,
		lines: [
			{ text: 'Let AI help you do the work.', hold: 3.1 },
			{ text: 'Keep the decision to say: cukup.', hold: 3.4 },
		],
		tail: 4.2,
	},
]

/** The end card. It is on screen, not a caption line. */
export const endCard = {
	url: 'cukup.dev',
	invitation: 'Read why Cukup exists, and what it can and cannot tell you.',
	status: 'A personal dashboard · Amp only · Open-source release in preparation',
	// Spoken over the end card, which appears after the last line.
	caption: 'Read why Cukup exists, and what it can and cannot tell you, at cukup.dev.',
	say: 'Read why Cukup exists, and what it can and cannot tell you, at cukup dot dev.',
	/** Seconds after the last line ends. */
	speechAt: 0.6,
	/** When each end-card element starts to fade in, after the last line ends, and for how long. */
	reveal: {
		url: { at: 0.1, fade: 0.8 },
		invitation: { at: 0.4, fade: 0.6 },
		status: { at: 0.7, fade: 0.6 },
	},
}

/** The narration key of a line. */
export const lineKey = (sceneId, index) => `${sceneId}-${index + 1}`
export const endKey = 'end-card'

const spoken = (key) => narration.durations[key] ?? 0

/**
 * Scenes and lines with absolute start and end times, in seconds.
 * `source` defaults to the scenes above. Tests pass an edited copy.
 */
export function timeline(source = scenes) {
	let clock = 0
	return source.map((scene) => {
		const start = clock
		let cursor = start + scene.lead
		const lines = scene.lines.map((line, index) => {
			const key = lineKey(scene.id, index)
			const hold = Math.max(line.hold, speechDelay + spoken(key) + speechGap)
			const timed = { ...line, key, hold, start: cursor, end: cursor + hold }
			cursor = timed.end
			return timed
		})
		const last = scene.id === source.at(-1).id
		const tail = last ? Math.max(scene.tail, endCard.speechAt + spoken(endKey) + 1.6) : scene.tail
		clock = cursor + tail
		return { ...scene, start, end: clock, lines }
	})
}

export const duration = timeline().at(-1).end
