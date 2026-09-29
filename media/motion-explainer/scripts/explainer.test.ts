import { describe, expect, test } from 'bun:test'
import { narration } from '../src/generated/narration.js'
import { narrationFingerprint as recorded } from '../src/generated/narration-fingerprint.js'
import { endCard, scenes } from '../src/scenes.js'
import { copyProblems } from './copy-checks.ts'
import { assertNarrationCurrent, narrationCues } from './narration-cues.ts'

const edited = (change: (copy: typeof scenes) => void): typeof scenes => {
	const copy = structuredClone(scenes)
	change(copy)
	return copy
}

describe('narration fingerprint', () => {
	test('matches the committed narration for the current copy and timing', () => {
		expect(() => assertNarrationCurrent(recorded, narrationCues(), narration)).not.toThrow()
	})

	test('rejects stale audio after a copy-only edit at the same length', () => {
		const copy = edited((source) => {
			source[0]!.lines[0]!.text = 'AI was supposed to save us effort.'
		})
		expect(narrationCues(copy).at(-1)!.until).toBe(narrationCues().at(-1)!.until)
		expect(() => assertNarrationCurrent(recorded, narrationCues(copy), narration)).toThrow('does not match')
	})

	test('rejects stale audio after a spoken-form or timing edit', () => {
		const spoken = edited((source) => {
			source[6]!.lines[2]!.say = 'Across this synthetic day, that gives eight hours and seven minutes.'
		})
		const timing = edited((source) => {
			source[0]!.lead += 0.5
		})
		expect(() => assertNarrationCurrent(recorded, narrationCues(spoken), narration)).toThrow()
		expect(() => assertNarrationCurrent(recorded, narrationCues(timing), narration)).toThrow()
	})
})

describe('copy checks', () => {
	test('pass for the current copy, including the end card', () => {
		expect(copyProblems()).toEqual([])
	})

	test('catch an end card that no longer has time to be read', () => {
		const invitation = `${endCard.invitation} ${'More words to read on the final card.'.repeat(3)}`
		const problems = copyProblems(scenes, { ...endCard, invitation })
		expect(problems.some((problem) => problem.startsWith('End card invitation'))).toBe(true)
	})
})
