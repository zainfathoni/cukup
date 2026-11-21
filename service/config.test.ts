import { describe, expect, test } from 'bun:test'
import {
	configuredApiHostname,
	configuredDashboard,
	configuredDashboardHostname,
	configuredFleetHostnames,
	configuredNewTurnEventSchemaVersion,
	configuredWorkProjects,
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

	test('accepts a Work list, leaves blank lists empty, and rejects malformed entries', () => {
		expect([...configuredWorkProjects('client-portal, docs,client-portal')]).toEqual(['client-portal', 'docs'])
		expect(configuredWorkProjects(' ').size).toBe(0)
		for (const value of ['client-portal,', 'client-portal,,docs', 'Client-Portal', 'a'.repeat(65)]) {
			expect(() => configuredWorkProjects(value)).toThrow('CUKUP_WORK_PROJECTS')
		}
	})
})

describe('dashboard configuration', () => {
	test('derives the exact callback and decodes a primary-first session key ring', () => {
		const first = Buffer.alloc(32, 1).toString('base64url')
		const second = Buffer.alloc(32, 2).toString('base64url')
		const value = configuredDashboard({
			CUKUP_GITHUB_OAUTH_CLIENT_ID: 'client-id',
			CUKUP_GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
			CUKUP_GITHUB_ALLOWED_USER_ID: '12345678',
			CUKUP_DASHBOARD_SESSION_KEYS: `${first},${second}`,
		}, 'dashboard.example.test')
		expect(value).toMatchObject({
			hostname: 'dashboard.example.test',
			callbackUrl: 'https://dashboard.example.test/auth/github/callback',
			allowedGithubUserId: '12345678',
		})
		expect(value?.sessionKeys).toEqual([Buffer.alloc(32, 1), Buffer.alloc(32, 2)])
	})

	test('disables missing or invalid OAuth/session inputs instead of throwing', () => {
		const valid = {
			CUKUP_GITHUB_OAUTH_CLIENT_ID: 'client-id',
			CUKUP_GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
			CUKUP_GITHUB_ALLOWED_USER_ID: '12345678',
			CUKUP_DASHBOARD_SESSION_KEYS: Buffer.alloc(32, 1).toString('base64url'),
		}
		expect(configuredDashboard({}, 'dashboard.example.test')).toBeUndefined()
		for (const overrides of [
			{ CUKUP_GITHUB_ALLOWED_USER_ID: 'login-name' },
			{ CUKUP_GITHUB_ALLOWED_USER_ID: '9007199254740992' },
			{ CUKUP_GITHUB_OAUTH_CLIENT_ID: 'contains whitespace' },
			{ CUKUP_DASHBOARD_SESSION_KEYS: 'too-short' },
		]) {
			expect(configuredDashboard({ ...valid, ...overrides }, 'dashboard.example.test')).toBeUndefined()
		}
	})

	test('uses canonical exact hostnames for host-first routing', () => {
		expect(configuredApiHostname(' api.example.test ')).toBe('api.example.test')
		expect(configuredDashboardHostname('dashboard.example.test')).toBe('dashboard.example.test')
		expect(() => configuredApiHostname('')).toThrow('CUKUP_API_HOSTNAME')
		expect(() => configuredDashboardHostname(' ')).toThrow('CUKUP_DASHBOARD_HOSTNAME')
		expect(() => configuredApiHostname('API.cukup.dev')).toThrow()
		expect(() => configuredDashboardHostname('cukup.dev:443')).toThrow()
	})
})
