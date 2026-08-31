export const PROJECT_SLUG_CONFIG_KEY = 'cukup.project-slug'
export const MAX_PROJECT_SLUG_LENGTH = 64

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

export function projectSlugFromConfiguration(configuration: Record<string, unknown>): string | null {
	const value = configuration[PROJECT_SLUG_CONFIG_KEY]
	return typeof value === 'string' && isProjectSlug(value) ? value : null
}
