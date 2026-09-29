/**
 * The public motion explainer on the signed-out page: its video, poster,
 * captions, and transcript.
 *
 * Every route maps to one fixed file that is loaded at start-up. No request
 * path ever becomes a filesystem path.
 */

export const EXPLAINER_ROUTES = {
	video: '/assets/explainer/cukup-explainer.mp4',
	poster: '/assets/explainer/poster.png',
	captions: '/assets/explainer/captions.en.vtt',
	transcript: '/explainer/transcript',
} as const

/** The files that the build copies next to the service. */
export const EXPLAINER_FILES = {
	video: 'cukup-explainer.mp4',
	poster: 'poster.png',
	captions: 'captions.en.vtt',
	transcript: 'transcript.md',
} as const

export type ExplainerAssets = {
	video: Blob
	poster: Blob
	captions: string
	transcriptHtml: string
	/** For example “1 min 39 s”, from the last caption cue. */
	durationLabel: string
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Loads and checks the four files. Returns undefined when any is missing or malformed. */
export async function loadExplainerAssets(directory: string): Promise<ExplainerAssets | undefined> {
	const file = (name: string) => Bun.file(`${directory}/${name}`)
	const video = file(EXPLAINER_FILES.video)
	const poster = file(EXPLAINER_FILES.poster)
	const captionsFile = file(EXPLAINER_FILES.captions)
	const transcriptFile = file(EXPLAINER_FILES.transcript)
	for (const candidate of [video, poster, captionsFile, transcriptFile]) {
		if (!(await candidate.exists())) return undefined
	}
	const videoHead = new Uint8Array(await video.slice(0, 12).arrayBuffer())
	const posterHead = new Uint8Array(await poster.slice(0, 8).arrayBuffer())
	const captions = await captionsFile.text()
	const markdown = await transcriptFile.text()
	const isMp4 = new TextDecoder().decode(videoHead.slice(4, 8)) === 'ftyp'
	const isPng = PNG_SIGNATURE.every((byte, index) => posterHead[index] === byte)
	const lastCueEnd = captionsEnd(captions)
	if (!isMp4 || !isPng || !captions.startsWith('WEBVTT') || lastCueEnd === undefined) return undefined
	return {
		video,
		poster,
		captions,
		transcriptHtml: renderTranscriptPage(markdown),
		durationLabel: durationLabel(lastCueEnd),
	}
}

function captionsEnd(captions: string): number | undefined {
	const ends = [...captions.matchAll(/--> (\d{2}):(\d{2}):(\d{2})\.(\d{3})/g)].map(
		([, h, m, s, ms]) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000,
	)
	return ends.length === 0 ? undefined : Math.max(...ends)
}

function durationLabel(seconds: number): string {
	// Round down, as video players do, so the label matches the player's own display.
	const rounded = Math.floor(seconds)
	const minutes = Math.floor(rounded / 60)
	return minutes === 0 ? `${rounded} s` : `${minutes} min ${rounded % 60} s`
}

/* ---------- Byte ranges ---------- */

export type ByteRange = { start: number; end: number }

/**
 * Parses a single `bytes=` range against a file size.
 * Returns undefined to serve the whole file, and 'unsatisfiable' for a 416.
 * Multiple or malformed ranges are ignored, as RFC 9110 allows.
 */
export function parseByteRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | undefined {
	if (header === null) return undefined
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
	if (!match) return undefined
	const [, first, last] = match
	if (first === '' && last === '') return undefined
	if (first === '') {
		const suffix = Number(last)
		if (suffix === 0 || size === 0) return 'unsatisfiable'
		return { start: Math.max(0, size - suffix), end: size - 1 }
	}
	const start = Number(first)
	const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
	if (last !== '' && Number(last) < start) return undefined
	if (start >= size) return 'unsatisfiable'
	return { start, end }
}

/* ---------- Transcript ---------- */

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

/** Escape first, then allow only **strong** and *emphasis*. */
function inline(text: string): string {
	return escapeHtml(text)
		.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
		.replace(/\*(.+?)\*/g, '<em>$1</em>')
}

/**
 * Renders the committed transcript: `#` and `##` headings and paragraphs.
 * Its one `#` heading becomes the page's `h1`.
 */
export function renderTranscriptPage(markdown: string): string {
	const blocks = markdown
		.split(/\n{2,}/)
		.map((block) => block.trim().replace(/\s*\n\s*/g, ' '))
		.filter(Boolean)
	const body = blocks
		.map((block) => {
			if (block.startsWith('## ')) return `<h2>${inline(block.slice(3))}</h2>`
			if (block.startsWith('# ')) return `<h1 id="transcript-title">${inline(block.slice(2))}</h1>`
			return `<p>${inline(block)}</p>`
		})
		.join('')
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Transcript · Cukup explainer</title><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/dashboard.css"></head><body class="landing"><a class="skip-link" href="#content">Skip to content</a><header class="landing-top"><p class="landing-brand"><span class="landing-brand-name">Cukup</span> <span class="wordmark-tag">enough</span></p><nav aria-label="Page"><ul><li><a href="/#explainer">Back to the video</a></li></ul></nav></header><main id="content" tabindex="-1"><section class="landing-transcript" aria-labelledby="transcript-title"><div class="landing-prose">${body}</div></section></main><footer class="page-footer landing-footer"><p>Cukup · Indonesian for “enough”. The explainer uses synthetic data.</p></footer></body></html>`
}
