/**
 * The public link-preview image for the signed-out page, and the text that
 * describes it in Open Graph and Twitter/X metadata.
 *
 * The route maps to one fixed file that is loaded at start-up. No request
 * path ever becomes a filesystem path.
 */

export const SOCIAL_IMAGE_ROUTE = '/assets/og-image.png'

/** The file that the build copies next to the service. */
export const SOCIAL_IMAGE_FILE = 'og-image.png'

export const SOCIAL_IMAGE_WIDTH = 1200
export const SOCIAL_IMAGE_HEIGHT = 630

/** Describes the image itself, for people who cannot see it. Keep it in step with media/og-image/src/index.html. */
export const SOCIAL_IMAGE_ALT =
	'The Cukup wordmark with an “enough” tag above the words “AI can do more. You still decide what is enough.” The word “enough.” is highlighted in yellow. Below it: cukup.dev.'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * Loads and checks the image. Returns undefined when it is missing, is not a
 * PNG, or is not 1200 × 630, so the metadata can never state the wrong size.
 */
export async function loadSocialImage(directory: string): Promise<Blob | undefined> {
	const file = Bun.file(`${directory}/${SOCIAL_IMAGE_FILE}`)
	if (!(await file.exists())) return undefined
	const head = new Uint8Array(await file.slice(0, 24).arrayBuffer())
	if (head.length < 24 || !PNG_SIGNATURE.every((byte, index) => head[index] === byte)) return undefined
	// The first chunk is IHDR: width and height are big-endian at bytes 16 and 20.
	const view = new DataView(head.buffer)
	const isIhdr = new TextDecoder().decode(head.slice(12, 16)) === 'IHDR'
	if (!isIhdr || view.getUint32(16) !== SOCIAL_IMAGE_WIDTH || view.getUint32(20) !== SOCIAL_IMAGE_HEIGHT) return undefined
	return file
}
