import { describe, expect, test } from 'bun:test'
import {
	MAX_PROJECT_SLUG_LENGTH,
	PROJECT_SLUG_CONFIG_KEY,
	normalizeProjectSlug,
	projectSlugFromConfiguration,
} from './project.ts'

describe('Project Slug', () => {
	test('normalizes accepted input to lowercase kebab-case', () => {
		expect(normalizeProjectSlug('  My_Project   Name  ')).toBe('my-project-name')
		expect(normalizeProjectSlug('already---canonical')).toBe('already-canonical')
		expect(normalizeProjectSlug('project42')).toBe('project42')
	})

	test('rejects punctuation, empty segments, and overlong values', () => {
		expect(normalizeProjectSlug('project/name')).toBeUndefined()
		expect(normalizeProjectSlug('-project')).toBeUndefined()
		expect(normalizeProjectSlug('project_')).toBeUndefined()
		expect(normalizeProjectSlug(' '.repeat(3))).toBeUndefined()
		expect(normalizeProjectSlug('a'.repeat(MAX_PROJECT_SLUG_LENGTH + 1))).toBeUndefined()
	})

	test('uses only an already-canonical configured value', () => {
		expect(projectSlugFromConfiguration({ [PROJECT_SLUG_CONFIG_KEY]: 'cukup-plugin' })).toBe(
			'cukup-plugin',
		)
		expect(projectSlugFromConfiguration({ [PROJECT_SLUG_CONFIG_KEY]: 'Cukup Plugin' })).toBeNull()
		expect(projectSlugFromConfiguration({ workspaceRoot: '/private/path' })).toBeNull()
	})
})
