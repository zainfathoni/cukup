export const MAX_PROJECT_SLUG_LENGTH = 64

export type AmpProjectAttribution = {
	id: string
	name: string
	slug: string
}

const projectSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const supportedInputPattern = /^[a-zA-Z0-9 _-]+$/

export function normalizeProjectSlug(input: string): string | undefined {
	const trimmed = input.trim()
	if (!trimmed || !supportedInputPattern.test(trimmed)) return undefined
	const normalized = trimmed.toLowerCase().replace(/[ _]+/g, '-').replace(/-+/g, '-')
	return isProjectSlug(normalized) ? normalized : undefined
}

export function isProjectSlug(value: string): boolean {
	return value.length <= MAX_PROJECT_SLUG_LENGTH && projectSlugPattern.test(value)
}

export function ampProjectAttributionFromJSON(
	json: string,
	expectedProjectID: string,
): AmpProjectAttribution | undefined {
	try {
		const project = JSON.parse(json) as unknown
		if (
			!project ||
			typeof project !== 'object' ||
			!('id' in project) ||
			project.id !== expectedProjectID ||
			!('name' in project) ||
			typeof project.name !== 'string'
		) {
			return undefined
		}
		const slug = normalizeProjectSlug(project.name)
		return slug ? { id: expectedProjectID, name: project.name, slug } : undefined
	} catch {
		return undefined
	}
}
