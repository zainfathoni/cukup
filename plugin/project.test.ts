import { describe, expect, test } from 'bun:test'
import {
	ampProjectAttributionFromJSON,
	MAX_PROJECT_SLUG_LENGTH,
	normalizeProjectSlug,
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

	test('accepts only the exact Amp Project identity and a normalizable project name', () => {
		expect(
			ampProjectAttributionFromJSON(
				JSON.stringify({ id: 'project-1', name: 'BookThatApp React' }),
				'project-1',
			),
		).toEqual({ id: 'project-1', name: 'BookThatApp React', slug: 'bookthatapp-react' })
		expect(
			ampProjectAttributionFromJSON(JSON.stringify({ id: 'other', name: 'Cukup' }), 'project-1'),
		).toBeUndefined()
		expect(
			ampProjectAttributionFromJSON(JSON.stringify({ id: 'project-1', name: 'Cukup!' }), 'project-1'),
		).toBeUndefined()
		expect(ampProjectAttributionFromJSON('not-json', 'project-1')).toBeUndefined()
	})
})
