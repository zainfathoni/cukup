/**
 * The Cukup motion explainer. `seek(t)` draws the frame at `t` seconds.
 *
 * Every property is a pure function of `t`: no CSS transitions, no timers, no
 * clock. Positions come from keyframes tied to the caption cues in scenes.js,
 * so timing edits move the motion with the copy. Every connector is recomputed
 * each frame from the current centers of its two nodes, so it cannot detach.
 */
import { data } from './generated/data.js'
import { duration, endCard, timeline, video } from './scenes.js'

/* ---------- Time ---------- */

const T = timeline()
const S = Object.fromEntries(T.map((scene) => [scene.id, scene]))
const L = (id, index) => S[id].lines[index].start
const E = (id, index) => S[id].lines[index].end

/* ---------- Math ---------- */

const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value))
const inOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2)
const out = (x) => 1 - (1 - x) ** 3
const back = (x) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2
/** Eased progress from 0 to 1 over `span` seconds, starting at `from`. */
const ramp = (t, from, span, curve = inOut) => curve(clamp((t - from) / span))
const mix = (a, b, k) => a + (b - a) * k
const mixPoint = (a, b, k) => ({ x: mix(a.x, b.x, k), y: mix(a.y, b.y, k) })

/** Interpolates keyframes `[time, {x, y, s}, curve?]`; holds before and after. */
function keys(t, frames) {
	if (t <= frames[0][0]) return frames[0][1]
	for (let i = 0; i < frames.length - 1; i += 1) {
		const [t0, a] = frames[i]
		const [t1, b, curve = inOut] = frames[i + 1]
		if (t < t1) {
			const k = curve(clamp((t - t0) / (t1 - t0)))
			return Object.fromEntries(Object.keys(b).map((key) => [key, mix(a[key] ?? b[key], b[key], k)]))
		}
	}
	return frames.at(-1)[1]
}

/* ---------- DOM ---------- */

const stage = document.getElementById('stage')
const svgNs = 'http://www.w3.org/2000/svg'
const wireLayer = document.createElementNS(svgNs, 'svg')
wireLayer.setAttribute('class', 'wires')
wireLayer.setAttribute('viewBox', `0 0 ${video.width} ${video.height}`)
stage.append(wireLayer)
const layer = document.createElement('div')
layer.className = 'layer'
stage.append(layer)

function node(className, html = '', parent = layer) {
	const element = document.createElement('div')
	element.className = `node ${className}`
	element.innerHTML = html
	parent.append(element)
	element.style.visibility = 'hidden'
	return element
}

/** Positions a node by its center. */
function place(element, x, y, { s = 1, o = 1, rot = 0 } = {}) {
	// `display`, not `visibility`: a visible child would show through a hidden parent.
	if (o <= 0.002 || s <= 0.002) {
		element.style.display = 'none'
		return
	}
	element.style.display = ''
	element.style.visibility = 'visible'
	element.style.opacity = String(Math.min(1, o))
	element.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${s}) rotate(${rot}deg)`
}

const wires = new Map()
const usedWires = new Set()

/**
 * Draws a connector between two points. `draw` reveals it from `a` to `b`.
 * `dir` sets the tangent at both ends: horizontal ('h') or vertical ('v').
 */
function wire(key, a, b, { o = 1, draw = 1, dir = 'h', className = '' } = {}) {
	if (o <= 0.002 || draw <= 0.002) return
	let path = wires.get(key)
	if (!path) {
		path = document.createElementNS(svgNs, 'path')
		path.setAttribute('pathLength', '1')
		wireLayer.append(path)
		wires.set(key, path)
	}
	usedWires.add(key)
	const c1 = dir === 'h' ? { x: mix(a.x, b.x, 0.5), y: a.y } : { x: a.x, y: mix(a.y, b.y, 0.5) }
	const c2 = dir === 'h' ? { x: mix(a.x, b.x, 0.5), y: b.y } : { x: b.x, y: mix(a.y, b.y, 0.5) }
	path.setAttribute('d', `M${a.x.toFixed(2)} ${a.y.toFixed(2)} C${c1.x.toFixed(2)} ${c1.y.toFixed(2)} ${c2.x.toFixed(2)} ${c2.y.toFixed(2)} ${b.x.toFixed(2)} ${b.y.toFixed(2)}`)
	path.setAttribute('class', className)
	path.style.strokeDasharray = draw < 1 ? '1 1' : ''
	path.style.strokeDashoffset = draw < 1 ? String(1 - draw) : ''
	path.style.opacity = String(Math.min(1, o))
	path.style.display = ''
}

const ring = document.createElementNS(svgNs, 'circle')
const disc = document.createElementNS(svgNs, 'circle')
ring.setAttribute('class', 'ring')
disc.setAttribute('class', 'disc')
wireLayer.append(disc, ring)

function circle(element, x, y, radius, o) {
	element.style.display = o <= 0.002 ? 'none' : ''
	element.setAttribute('cx', x.toFixed(2))
	element.setAttribute('cy', y.toFixed(2))
	element.setAttribute('r', Math.max(0, radius).toFixed(2))
	element.style.opacity = String(o)
}

/* ---------- Story objects ---------- */

const center = { x: 960, y: 470 }

/** In the compassion scene, everything but the person drifts out and fades. */
const spaceStart = L('compassion', 1) - 1.7
const space = (t) => ramp(t, spaceStart, 1.5)
function drift(t, point, o = 1) {
	const k = space(t)
	if (k === 0) return { ...point, o }
	const dx = point.x - center.x
	const dy = point.y - center.y
	const length = Math.hypot(dx, dy) || 1
	return { x: point.x + (dx / length) * 110 * k, y: point.y + (dy / length) * 110 * k, o: o * (1 - k) }
}

const you = node('you', 'You')
const ringLabel = node('ring-label', 'Your attention')

const agents = ['A', 'B', 'C'].map(() =>
	node('agent', 'Agent<span class="agent-dots"><span></span><span></span><span></span></span>'),
)
const agentHome = [
	{ x: 1000, y: 470 },
	{ x: 1000, y: 230 },
	{ x: 1000, y: 710 },
]

const prompt = node('prompt', 'Add CSV export')

const results = [
	['Diff +214 −38', 'Correct?', '--sky'],
	['New package', 'Trust it?', '--mint'],
	['Schema change', 'Reversible?', '--rose'],
	['3 tests failing', 'Why failing?', '--peach'],
	['Refactor plan', 'Right plan?', '--sun'],
	['Retry logic', 'Edge cases?', '--sky'],
	['Docs update', 'Accurate?', '--mint'],
	['Error handling', 'Safe?', '--rose'],
	['Config change', 'Secure?', '--peach'],
].map(([label, question, stripe], index) => {
	const row = Math.floor(index / 3)
	const col = index % 3
	const card = node('result', label)
	card.style.setProperty('--stripe', `var(${stripe})`)
	const ghosts = [0, 1].map(() => {
		const ghost = node('ghost')
		ghost.style.setProperty('--stripe', `var(${stripe})`)
		layer.insertBefore(ghost, layer.firstChild)
		return ghost
	})
	const tag = node('tag', `<div class="tag-fill"></div><span>${question}</span>`)
	const source = row === 0 ? 1 : row === 1 ? 0 : 2
	const emit = row === 1 ? S.output.start + 0.3 + col * 0.7 : L('output', 1) + 0.9 + (row === 0 ? 0 : 0.25) + col * 0.5
	return {
		card,
		tag,
		ghosts,
		source,
		emit,
		slot: { x: 1300 + col * 220, y: 230 + row * 240 },
		side: { x: 420 + col * 185, y: 330 + row * 140 },
		tagAt: S.attention.start + 0.35 + index * 0.18,
	}
})

const extras = [
	['Hotfix', { x: 1190, y: 110 }, -5],
	['Review me', { x: 1480, y: 118 }, 4],
	['Another diff', { x: 1760, y: 380 }, -3],
	['New branch', { x: 1160, y: 600 }, 6],
	['Follow-up', { x: 1640, y: 610 }, -6],
	['Rerun tests', { x: 1380, y: 820 }, 3],
	['Changelog', { x: 1760, y: 830 }, -4],
	['One more', { x: 760, y: 790 }, 5],
].map(([label, target, rot], index) => ({
	card: node('result', label),
	target,
	rot,
	source: index % 3,
	emit: L('compassion', 0) + 0.2 + index * 0.36,
}))

const divider = node('divider')
const headingHuman = node('heading', 'Stays with you')
const headingAi = node('heading', 'AI can help')

const pills = [
	['Notice', '--sky', { x: 590, y: 290 }],
	['Remember', '--rose', { x: 1330, y: 290 }],
	['Be kind', '--peach', { x: 960, y: 700 }],
].map(([label, color, target], index) => {
	const pill = node('pill', label)
	pill.style.background = `var(${color})`
	return { pill, target, at: L('compassion', index + 1) + 0.1 }
})

const wordmark = node('wordmark', '<span class="wordmark-word">Cukup</span><span class="wordmark-tag">enough</span>')
const wordmarkWord = wordmark.querySelector('.wordmark-word')
const wordmarkTag = wordmark.querySelector('.wordmark-tag')
const subline = node('subline', 'Indonesian for “enough” · say “CHOO-koop”')

/* Working Time panel: children use local coordinates inside the panel. */

const panel = node('panel')
panel.style.overflow = 'hidden'
const local = (className, html = '') => {
	const element = document.createElement('div')
	element.className = className
	element.innerHTML = html
	panel.append(element)
	return element
}
const minutesOf = (clock) => {
	const [h, m] = clock.split(':').map(Number)
	return h * 60 + m
}
const formatMinutes = (minutes) => {
	const hours = Math.floor(minutes / 60)
	return hours === 0 ? `${minutes % 60}m` : `${hours}h ${minutes % 60}m`
}
const trackLeft = 260
const trackWidth = 1030
const rowY = [80, 145, 210]
const unionY = 300
const axisY = 418

const turnRows = data.morning.turns.map((turn, index) => ({
	label: local('row-label', `Turn ${index + 1}`),
	turn: local('bar turn'),
	grace: local('bar grace'),
	drop: local('bar union'),
	start: minutesOf(turn.start),
	end: minutesOf(turn.end),
	counted: minutesOf(turn.countedUntil),
	y: rowY[index],
}))
const unionLabel = local('row-label total-label', 'Working Time')
const unionBlocks = data.day.union.map((interval) => ({
	bar: local('bar union'),
	start: minutesOf(interval.start),
	end: minutesOf(interval.end),
}))
const morningBlocks = data.morning.union.length
const bracket = local('bracket')
const bracketLabel = local('bracket-label', 'Overlap counts once')
const overlapStart = turnRows[1].start
const overlapEnd = turnRows[0].counted
const morningTotal = local('total', formatMinutes(data.morning.minutes))
const dayTotal = local('total', formatMinutes(data.day.minutes))
const ticks = [
	...['09:00', '10:00', '11:00', '12:00'].map((clock) => ({ element: local('tick', clock), minutes: minutesOf(clock), day: false })),
	...['09:00', '12:00', '15:00', '18:00', '21:00'].map((clock) => ({ element: local('tick', clock), minutes: minutesOf(clock), day: true })),
]
local(
	'legend',
	'<span><i class="swatch-turn"></i>Amp turn</span><span><i class="swatch-grace"></i>15 minutes after it</span><span><i class="swatch-union"></i>Working Time</span>',
)
panel.querySelector('.swatch-turn').style.background = 'var(--sky)'
panel.querySelector('.swatch-grace').style.background = 'var(--peach)'
panel.querySelector('.swatch-union').style.background = 'var(--over-fill)'

const todayCard = node('card-wrap', '<img class="today-card" src="generated/today-card.png" alt="">')
const estimateNote = node('note', 'Estimate from Amp turns · not measured attention')
const nextTask = node('next-task', 'Next task')
const nextLabel = node('note', 'Your choice · conceptual')
const slot = node('slot', 'Tomorrow · your choice')

const closeOne = node('close-line', 'Let AI help you do the work.')
const closeTwo = node('close-line', 'Keep the decision to say: <mark>cukup.</mark>')
const url = node('url', endCard.url)
const invitation = node('invitation', endCard.invitation)
const status = node('status', endCard.status)

// New cards and labels emerge from behind the node that sends them.
for (const agent of agents) layer.append(agent)
layer.append(you)

/* Kind chips separate illustration from product behavior. */

const L1 = L('working-time', 1)
const cardAt = L1 + 3.6
const kinds = [
	[0.3, S.compassion.end, 'Conceptual illustration'],
	[S['working-time'].start + 0.2, cardAt, 'Working Time rule · synthetic data'],
	[cardAt, L('working-time', 3) + 0.2, 'Real Cukup view · synthetic data'],
	// The decision that follows is the person's, not a Cukup feature.
	[L('working-time', 3) + 0.2, S['working-time'].end, 'Real Cukup view + conceptual choice'],
].map(([from, to, text]) => ({ chip: node('kind', text), from, to }))
for (const kind of kinds) kind.chip.style.transform = 'none'

/* Captions: one element per line, crossfaded. */

const caption = node('caption')
const captionLines = T.flatMap((scene) =>
	scene.id === 'close'
		? []
		: scene.lines.map((line) => {
				const element = document.createElement('div')
				element.className = 'caption-line'
				element.textContent = line.text
				caption.append(element)
				return { element, line }
			}),
)

/* ---------- Frame ---------- */

let wordmarkWidth = 0

function seek(t) {
	usedWires.clear()

	/* The person */
	const Lc1 = L('compassion', 1)
	const Lw3 = L('working-time', 3)
	const wt = S['working-time']
	const me = keys(t, [
		[0.2, { x: 300, y: 470, s: 0 }],
		[0.9, { x: 300, y: 470, s: 1 }, back],
		[L('delegate', 1), { x: 300, y: 470, s: 1 }],
		[L('delegate', 1) + 1, { x: 170, y: 470, s: 1 }],
		[spaceStart + 0.2, { x: 170, y: 470, s: 1 }],
		[Lc1 - 0.1, { x: 960, y: 430, s: 1.1 }],
		[S.cukup.start + 0.3, { x: 960, y: 430, s: 1.1 }],
		[S.cukup.start + 1.3, { x: 520, y: 450, s: 1 }],
		[S.cukup.end - 1.0, { x: 520, y: 450, s: 1 }],
		[S.cukup.end, { x: 290, y: 820, s: 0.75 }],
		[Lw3, { x: 290, y: 820, s: 0.75 }],
		[Lw3 + 0.6, { x: 290, y: 820, s: 1 }],
		[wt.end - 0.2, { x: 290, y: 820, s: 1 }],
		[wt.end + 0.9, { x: 960, y: 190, s: 0.8 }],
	])
	place(you, me.x, me.y, { s: me.s })

	/* Attention ring: dashed, then a soft breathing circle, then gone. */
	const ringIn = ramp(t, S.attention.start + 1.2, 0.6)
	const breathe = 1 + 0.035 * Math.sin(((t - spaceStart) / 4) * Math.PI * 2) * space(t)
	const radius = 150 * me.s * breathe
	const ringGone = 1 - ramp(t, S.cukup.start, 0.8)
	circle(ring, me.x, me.y, radius, ringIn * (1 - space(t)))
	circle(disc, me.x, me.y, radius, space(t) * ringGone * 0.9)
	place(ringLabel, me.x, me.y - radius - 34, { o: ringIn * (1 - space(t)) })

	/* Agents */
	const spawn = ramp(t, L('output', 1), 0.8, out)
	const agentPoints = agentHome.map((home, index) => {
		if (index === 0) {
			const pop = ramp(t, 0.8, 0.6, back)
			const pulse = 1 + 0.1 * Math.sin(clamp((t - 5.0) / 0.45) * Math.PI)
			return { ...drift(t, home, pop > 0 ? 1 : 0), s: pop * pulse }
		}
		return { ...drift(t, mixPoint(agentHome[0], home, spawn), spawn > 0 ? 1 : 0), s: mix(0.5, 1, spawn) }
	})
	agents.forEach((agent, index) => {
		const point = agentPoints[index]
		place(agent, point.x, point.y, { s: point.s, o: point.o })
		const working = t > 5 && t < S.compassion.end
		agent.querySelectorAll('.agent-dots span').forEach((dot, j) => {
			dot.style.transform = `translateY(${working ? -7 * Math.max(0, Math.sin(t * 7 - j * 0.9)) : 0}px)`
			dot.style.opacity = working ? '1' : '0.35'
		})
	})
	if (spawn > 0.02) {
		for (const index of [1, 2]) {
			wire(`agent-${index}`, agentPoints[0], agentPoints[index], { dir: 'v', o: agentPoints[index].o })
		}
	}

	/* Prompt: from the person, along the connector, into the agent. */
	wire('you-agent', me, agentPoints[0], {
		draw: ramp(t, 1.4, 0.9),
		o: 1 - ramp(t, S.attention.start + 1.4, 0.5),
	})
	const promptPop = ramp(t, 2.3, 0.5, back)
	const promptTravel = ramp(t, 3.4, 1.6)
	const promptPoint = mixPoint({ x: 620, y: 470 }, agentHome[0], promptTravel)
	place(prompt, promptPoint.x, promptPoint.y, {
		s: promptPop * mix(1, 0.3, promptTravel),
		o: 1 - ramp(t, 4.7, 0.3, (x) => x),
	})

	/* Results, their question tags, and their connectors */
	results.forEach((item, index) => {
		const from = agentPoints[item.source]
		const travel = ramp(t, item.emit, 0.75, out)
		const visible = t >= item.emit ? 1 : 0
		const cardPoint = drift(t, mixPoint(from, item.slot, travel), visible)
		place(item.card, cardPoint.x, cardPoint.y, { s: mix(0.3, 1, travel), o: cardPoint.o })
		// The connector fades as the card lands, so it never reads as a link between cards.
		wire(`emit-${index}`, from, cardPoint, { o: visible * cardPoint.o * (1 - ramp(t, item.emit + 0.5, 0.35)) })

		item.ghosts.forEach((ghost, g) => {
			const start = L('attention', 1) + 0.15 + index * 0.1 + g * 0.35
			const k = ramp(t, start, 0.5, out)
			const target = { x: item.slot.x + (g + 1) * 14, y: item.slot.y - (g + 1) * 14 }
			const point = drift(t, mixPoint(from, target, k), t >= start ? 1 : 0)
			place(ghost, point.x, point.y, { s: mix(0.3, 1, k), o: point.o })
		})

		const grow = ramp(t, item.tagAt, 0.5, out)
		const move = ramp(t, L('delegate', 1) + index * 0.07, 1)
		const under = { x: item.slot.x, y: item.slot.y + mix(40, 82, grow) }
		const tagPoint = drift(t, mixPoint(under, item.side, move), grow > 0 ? 1 : 0)
		place(item.tag, tagPoint.x, tagPoint.y, { s: mix(0.3, 1, grow), o: tagPoint.o })
		item.tag.querySelector('.tag-fill').style.opacity = String(ramp(t, L('delegate', 2) + 0.3 + index * 0.1, 0.35))
		if (grow > 0) wire(`link-${index}`, cardPoint, tagPoint, { dir: 'v', className: 'soft', o: tagPoint.o })
		wire(`ask-${index}`, tagPoint, me, {
			draw: ramp(t, S.attention.start + 1.9 + index * 0.12, 0.5),
			o: tagPoint.o * (1 - ramp(t, L('delegate', 1), 0.6)),
			className: 'soft',
		})
	})

	/* More output, crowding the space */
	extras.forEach((item, index) => {
		const from = agentPoints[item.source]
		const k = ramp(t, item.emit, 0.7, out)
		const visible = t >= item.emit ? 1 : 0
		const point = drift(t, mixPoint(from, item.target, k), visible)
		place(item.card, point.x, point.y, { s: mix(0.3, 1, k), o: point.o, rot: item.rot * k })
		wire(`extra-${index}`, from, point, { o: visible * point.o * (1 - ramp(t, item.emit + 0.5, 0.35)) })
	})

	/* Delegation divider and headings */
	const split = ramp(t, S.delegate.start + 0.3, 0.9)
	// The crowd in the compassion scene overruns the tidy split.
	const splitFade = 1 - ramp(t, L('compassion', 0) + 0.1, 0.8)
	if (split > 0 && splitFade > 0) {
		divider.style.visibility = 'visible'
		divider.style.opacity = String(splitFade)
		divider.style.transform = `translate(898px, 160px) scaleY(${split})`
	} else divider.style.visibility = 'hidden'
	const headings = ramp(t, S.delegate.start + 0.9, 0.5) * splitFade
	place(headingHuman, 500, 225, { o: headings })
	place(headingAi, 1400, 110, { o: headings })

	/* Self-compassion: three labels grow from the person, then return. */
	const returning = ramp(t, S.cukup.start, 0.8)
	pills.forEach((item, index) => {
		const k = ramp(t, item.at, 0.9, out) * (1 - returning)
		const point = mixPoint(me, item.target, k)
		place(item.pill, point.x, point.y, { s: mix(0.3, 1, k), o: k > 0.01 ? 1 : 0 })
		if (k > 0.01) wire(`pill-${index}`, me, point, { dir: 'h' })
	})

	/* The name */
	const reveal = ramp(t, S.cukup.start + 1.3, 1.0)
	const tagPop = ramp(t, S.cukup.start + 2.2, 0.5, back)
	// The name settles in the corner before the Working Time panel arrives.
	const toBrand = ramp(t, S.cukup.end - 1.1, 0.9)
	const markScale = mix(1, 0.24, toBrand)
	const markLeft = mix(700, video.width - 80 - wordmarkWidth * 0.24, toBrand)
	const markY = mix(420, 70, toBrand)
	if (reveal > 0) {
		wordmark.style.visibility = 'visible'
		wordmark.style.opacity = '1'
		wordmark.style.transform = `translate(${markLeft}px, ${markY}px) translateY(-50%) scale(${markScale})`
		wordmarkWord.style.clipPath = `inset(-20% ${(1 - reveal) * 100}% -20% 0)`
		wordmarkTag.style.transform = `scale(${tagPop})`
		wordmarkTag.style.opacity = tagPop > 0.01 ? '1' : '0'
	} else wordmark.style.visibility = 'hidden'
	const sub = ramp(t, S.cukup.start + 2.6, 0.6) * (1 - toBrand)
	if (sub > 0.002) {
		subline.style.visibility = 'visible'
		subline.style.opacity = String(sub)
		subline.style.transform = `translate(706px, 580px) translateY(-50%)`
	} else subline.style.visibility = 'hidden'

	/* Working Time panel */
	const L0 = L('working-time', 0)
	const panelPop = ramp(t, L0, 0.5, out)
	const panelMove = ramp(t, L1 + 3.0, 1.0)
	const panelFade = 1 - ramp(t, wt.end - 0.3, 0.6)
	const group = {
		x: mix(1000, 560, panelMove),
		y: mix(390, 330, panelMove),
		s: mix(0.94, 1, panelPop) * mix(1, 0.56, panelMove),
	}
	place(panel, group.x, group.y, { s: group.s, o: panelPop * panelFade })
	const zoom = ramp(t, L1 + 0.2, 1.2)
	const domainEnd = mix(720, 1260, zoom)
	const X = (minutes) => trackLeft + ((minutes - 540) / (domainEnd - 540)) * trackWidth
	const rowsFade = 1 - ramp(t, L1, 0.5)
	const setBar = (element, x0, x1, y, o = 1) => {
		element.style.left = `${x0.toFixed(2)}px`
		element.style.width = `${Math.max(0, x1 - x0).toFixed(2)}px`
		element.style.top = `${y}px`
		element.style.opacity = String(o)
		element.style.visibility = o > 0.002 && x1 - x0 > 0.5 ? 'visible' : 'hidden'
	}
	turnRows.forEach((row, index) => {
		row.label.style.top = `${row.y}px`
		row.label.style.opacity = String(rowsFade)
		const grow = ramp(t, L0 + 0.3 + index * 0.3, 0.6)
		const grace = ramp(t, L0 + 1.4 + index * 0.25, 0.5)
		setBar(row.turn, X(row.start), mix(X(row.start), X(row.end), grow), row.y, rowsFade)
		setBar(row.grace, X(row.end) - 3, mix(X(row.end), X(row.counted), grace), row.y, rowsFade * (grace > 0 ? 1 : 0))
		const drop = ramp(t, L0 + 2.4 + index * 0.2, 0.7)
		setBar(row.drop, X(row.start), X(row.counted), mix(row.y, unionY, drop), drop > 0 ? 1 - ramp(t, L0 + 3.3, 0.3) : 0)
		layerTop(row.drop)
	})
	unionLabel.style.top = `${unionY}px`
	unionBlocks.forEach((block, index) => {
		if (index < morningBlocks) {
			setBar(block.bar, X(block.start), X(block.end), unionY, ramp(t, L0 + 3.1, 0.3))
		} else {
			const grow = ramp(t, L1 + 1.3 + (index - morningBlocks) * 0.22, 0.4)
			setBar(block.bar, X(block.start), mix(X(block.start), X(block.end), grow), unionY, grow > 0 ? 1 : 0)
		}
	})
	const bracketOn = ramp(t, L0 + 3.3, 0.3) * (1 - ramp(t, L1, 0.4))
	bracket.style.left = `${X(overlapStart)}px`
	bracket.style.width = `${X(overlapEnd) - X(overlapStart)}px`
	bracket.style.top = `${unionY + 30}px`
	bracket.style.transform = 'scaleY(-1)'
	bracket.style.opacity = String(bracketOn)
	bracketLabel.style.left = `${(X(overlapStart) + X(overlapEnd)) / 2 + 60}px`
	bracketLabel.style.top = `${unionY + 72}px`
	bracketLabel.style.opacity = String(bracketOn)
	const blocksDone = L1 + 1.3 + (unionBlocks.length - morningBlocks - 1) * 0.22 + 0.4
	morningTotal.style.left = dayTotal.style.left = '1318px'
	morningTotal.style.top = dayTotal.style.top = `${unionY}px`
	morningTotal.style.opacity = String(ramp(t, L0 + 3.4, 0.3) * (1 - ramp(t, L1 + 0.2, 0.3)))
	dayTotal.style.opacity = String(ramp(t, blocksDone, 0.3))
	for (const tick of ticks) {
		const x = X(tick.minutes)
		const o = (tick.day ? zoom : 1 - zoom) * (x > trackLeft - 40 && x < trackLeft + trackWidth + 40 ? 1 : 0)
		tick.element.style.left = `${x.toFixed(2)}px`
		tick.element.style.top = `${axisY}px`
		tick.element.style.opacity = String(o)
	}

	/* The real Today card, fed by the day total */
	const totalPoint = { x: group.x + (1470 - 750) * group.s, y: group.y + (unionY - 245) * group.s }
	const cardIn = ramp(t, cardAt, 0.6, out)
	const cardPoint = { x: mix(1330, 1400, cardIn), y: 500 }
	place(todayCard, cardPoint.x, cardPoint.y, { s: mix(0.96, 1, cardIn), o: cardIn * panelFade })
	wire('total-card', totalPoint, { x: cardPoint.x - 360, y: cardPoint.y - 70 }, {
		draw: ramp(t, cardAt - 0.3, 0.5),
		o: panelFade,
	})
	place(estimateNote, 1400, 735, { o: ramp(t, L('working-time', 2), 0.4) * panelFade })

	/* A person's decision: the next task waits for tomorrow. */
	const Lw4 = L('working-time', 4)
	const arrive = ramp(t, Lw3 + 0.4, 1.2, out)
	const defer = ramp(t, Lw4 + 0.8, 1.0)
	const taskPoint = { x: mix(mix(2150, 780, arrive), 1250, defer), y: mix(830, 862, defer) }
	place(nextTask, taskPoint.x, taskPoint.y, { o: (t >= Lw3 + 0.4 ? 1 : 0) * panelFade })
	place(nextLabel, taskPoint.x, taskPoint.y - 66, { o: arrive * (1 - defer) * panelFade })
	place(slot, 1250, 830, { s: mix(0.9, 1, ramp(t, Lw4 + 0.3, 0.4, out)), o: ramp(t, Lw4 + 0.3, 0.4) * panelFade })
	wire('you-task', me, taskPoint, {
		draw: ramp(t, Lw4 + 0.1, 0.5),
		o: panelFade * (1 - ramp(t, Lw4 + 2.0, 0.4)),
	})

	/* Close and end card */
	const end = ramp(t, E('close', 1) + 0.1, 0.8)
	const one = ramp(t, L('close', 0), 0.5)
	const two = ramp(t, L('close', 1), 0.5)
	place(closeOne, 960, mix(420, 400, one) - end * 70, { o: one })
	place(closeTwo, 960, mix(540, 520, two) - end * 70, { o: two })
	place(url, 960, mix(680, 660, end), { o: end })
	place(invitation, 960, 765, { o: ramp(t, E('close', 1) + 0.4, 0.6) })
	place(status, 960, 850, { o: ramp(t, E('close', 1) + 0.7, 0.6) })

	/* Kind chips */
	for (const kind of kinds) {
		const o = ramp(t, kind.from, 0.4) * (1 - ramp(t, kind.to - 0.4, 0.4))
		kind.chip.style.visibility = o > 0.002 ? 'visible' : 'hidden'
		kind.chip.style.opacity = String(o)
	}

	/* Captions */
	// A line holds until the next starts, so the box is never empty between lines.
	let bar = 0
	for (const [index, { element, line }] of captionLines.entries()) {
		const next = captionLines[index + 1]?.line
		const until = next && next.start - line.end < 1 ? next.start : line.end
		const o = ramp(t, line.start - 0.1, 0.25) * (1 - ramp(t, until - 0.15, 0.15))
		bar = Math.max(bar, ramp(t, line.start - 0.2, 0.2) * (1 - ramp(t, until - 0.15, 0.25)))
		element.style.opacity = String(o)
		element.style.transform = `translateY(${(1 - ramp(t, line.start, 0.3, out)) * 14}px)`
	}
	place(caption, 960, 975, { o: bar })

	for (const [key, path] of wires) if (!usedWires.has(key)) path.style.display = 'none'
}

/** Keeps drop bars above the rows they leave. */
function layerTop(element) {
	element.style.zIndex = '2'
}

/* ---------- Boot ---------- */

async function ready() {
	const faces = ['400 40px "Explainer Sans"', '700 40px "Explainer Sans"', '900 40px "Explainer Sans"', '400 40px "Explainer Mono"', '700 40px "Explainer Mono"']
	for (const face of faces) {
		const loaded = await document.fonts.load(face)
		if (loaded.length === 0) throw new Error(`Font not available: ${face}. Install Noto Sans and Noto Sans Mono.`)
	}
	await todayCard.querySelector('img').decode()
	// Fit each caption on one line; allow two lines only below 40px.
	caption.style.display = ''
	for (const { element } of captionLines) {
		element.style.whiteSpace = 'nowrap'
		let size = 50
		element.style.fontSize = `${size}px`
		while (element.scrollWidth > element.clientWidth - 80 && size > 40) {
			size -= 1
			element.style.fontSize = `${size}px`
		}
		if (element.scrollWidth > element.clientWidth) element.style.whiteSpace = ''
	}
	wordmarkWidth = wordmark.offsetWidth
	seek(0)
}

const params = new URLSearchParams(location.search)
function fit() {
	const scale = Math.min(innerWidth / video.width, innerHeight / video.height)
	stage.style.transform = `scale(${scale})`
}
if (!params.has('render')) {
	addEventListener('resize', fit)
	fit()
}

window.explainer = { duration, fps: video.fps, seek, ready: ready() }

if (params.has('controls')) {
	await window.explainer.ready
	const controls = document.createElement('div')
	controls.className = 'controls'
	controls.innerHTML = `<button type="button">Play</button><input type="range" min="0" max="${duration}" step="0.0333" value="0"><output>0.0 s</output>`
	document.body.append(controls)
	const [button, range, readout] = controls.children
	let playing = false
	let origin = 0
	const show = (t) => {
		seek(t)
		range.value = String(t)
		readout.textContent = `${t.toFixed(2)} s`
	}
	range.addEventListener('input', () => show(Number(range.value)))
	button.addEventListener('click', () => {
		playing = !playing
		button.textContent = playing ? 'Pause' : 'Play'
		origin = performance.now() - Number(range.value) * 1000
		const tick = (now) => {
			if (!playing) return
			const t = (now - origin) / 1000
			if (t >= duration) {
				playing = false
				button.textContent = 'Play'
				return show(duration)
			}
			show(t)
			requestAnimationFrame(tick)
		}
		requestAnimationFrame(tick)
	})
	const start = Number(params.get('t') ?? 0)
	show(start)
}
