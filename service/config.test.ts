import { describe, expect, test } from 'bun:test'
import {
	configuredFleetHostnames,
	configuredNewTurnEventSchemaVersion,
	isCanonicalFleetHostname,
	isCanonicalProjectSlug,
} from './config.ts'

describe('attribution configuration', () => {
	test('parses only canonical, non-reserved Fleet hostnames', () => {
		expect([...configuredFleetHostnames('workstation-a, backup-host.example.test')]).toEqual([
			'workstation-a',
			'backup-host.example.test',
		])
		for (const value of ['Workstation-A', '-machine', 'machine-', 'machine..test', 'amp-orb']) {
			expect(isCanonicalFleetHostname(value)).toBeFalse()
			expect(() => configuredFleetHostnames(value)).toThrow()
		}
	})

	test('defaults future turn starts to v1 and accepts only an explicit v2 preference', () => {
		expect(configuredNewTurnEventSchemaVersion(undefined)).toBe(1)
		expect(configuredNewTurnEventSchemaVersion('1')).toBe(1)
		expect(configuredNewTurnEventSchemaVersion('2')).toBe(2)
		expect(() => configuredNewTurnEventSchemaVersion('3')).toThrow()
	})

	test('recognizes only canonical project slugs within the length limit', () => {
		expect(isCanonicalProjectSlug('cukup-service')).toBeTrue()
		expect(isCanonicalProjectSlug('a'.repeat(64))).toBeTrue()
		expect(isCanonicalProjectSlug('a'.repeat(65))).toBeFalse()
		expect(isCanonicalProjectSlug('cukup_service')).toBeFalse()
	})
})
