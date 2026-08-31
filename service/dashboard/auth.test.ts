import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { DashboardConfiguration } from '../config.ts'
import {
	DashboardAuth,
	OAUTH_COOKIE_NAME,
	SESSION_COOKIE_NAME,
	SESSION_LIFETIME_SECONDS,
} from './auth.ts'

const initialNow = Date.parse('2026-08-31T05:00:00.000Z')
const oldKey = Buffer.alloc(32, 1)
const newKey = Buffer.alloc(32, 2)

function configuration(keys: readonly Uint8Array[] = [oldKey]): DashboardConfiguration {
	return {
		hostname: 'cukup.dev',
		callbackUrl: 'https://cukup.dev/auth/github/callback',
		githubClientId: 'client-id',
		githubClientSecret: 'client-secret',
		allowedGithubUserId: '12345678',
		sessionKeys: keys,
	}
}

function cookiePair(setCookie: string): string {
	return setCookie.split(';', 1)[0]!
}

function githubFetch(userId = 12_345_678): {
	fetcher: typeof fetch
	requests: Array<{ url: string; init: RequestInit | undefined }>
} {
	const requests: Array<{ url: string; init: RequestInit | undefined }> = []
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		requests.push({ url, init })
		if (url === 'https://github.com/login/oauth/access_token') {
			return Response.json({ access_token: 'github-access-token', token_type: 'bearer' })
		}
		if (url === 'https://api.github.com/user') return Response.json({ id: userId, login: 'ignored' })
		return new Response(null, { status: 404 })
	}) as typeof fetch
	return { fetcher, requests }
}

async function signIn(auth: DashboardAuth): Promise<{
	sessionCookie: string
	startCookie: string
	location: URL
}> {
	const start = auth.start()
	const location = new URL(start.location)
	const completion = await auth.complete(
		new URLSearchParams({ code: 'one-time-code', state: location.searchParams.get('state')! }),
		cookiePair(start.cookie),
	)
	if (!completion) throw new Error('Expected OAuth completion')
	return { sessionCookie: completion.sessionCookie, startCookie: start.cookie, location }
}

describe('GitHub dashboard authentication', () => {
	test('uses exact callback, state, and S256 PKCE before accepting the configured numeric identity', async () => {
		const github = githubFetch()
		const auth = new DashboardAuth(configuration(), {
			fetch: github.fetcher,
			now: () => initialNow,
		})
		const signedIn = await signIn(auth)
		expect(signedIn.location.origin + signedIn.location.pathname).toBe(
			'https://github.com/login/oauth/authorize',
		)
		expect(signedIn.location.searchParams.get('redirect_uri')).toBe(
			'https://cukup.dev/auth/github/callback',
		)
		expect(signedIn.location.searchParams.get('code_challenge_method')).toBe('S256')
		const exchange = new URLSearchParams(String(github.requests[0]?.init?.body))
		expect(exchange.get('redirect_uri')).toBe('https://cukup.dev/auth/github/callback')
		expect(exchange.get('code')).toBe('one-time-code')
		expect(signedIn.location.searchParams.get('code_challenge')).toBe(
			createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url'),
		)
		expect(github.requests[1]?.init?.headers).toMatchObject({
			authorization: 'Bearer github-access-token',
		})
		expect(auth.hasValidSession(cookiePair(signedIn.sessionCookie))).toBeTrue()
	})

	test('fails generically before exchange on state mismatch and after exchange on account mismatch', async () => {
		const github = githubFetch(87_654_321)
		const auth = new DashboardAuth(configuration(), {
			fetch: github.fetcher,
			now: () => initialNow,
		})
		const start = auth.start()
		expect(
			await auth.complete(
				new URLSearchParams({ code: 'code', state: 'incorrect-state' }),
				cookiePair(start.cookie),
			),
		).toBeUndefined()
		expect(github.requests).toHaveLength(0)

		const location = new URL(start.location)
		expect(
			await auth.complete(
				new URLSearchParams({ code: 'code', state: location.searchParams.get('state')! }),
				cookiePair(start.cookie),
			),
		).toBeUndefined()
		expect(github.requests).toHaveLength(2)
	})

	test('issues host-only seven-day cookies, survives key rotation, and rejects tampering and expiry', async () => {
		let now = initialNow
		const github = githubFetch()
		const oldAuth = new DashboardAuth(configuration([oldKey]), {
			fetch: github.fetcher,
			now: () => now,
		})
		const signedIn = await signIn(oldAuth)
		for (const cookie of [signedIn.startCookie, signedIn.sessionCookie]) {
			expect(cookie).toContain('Path=/')
			expect(cookie).toContain('Secure')
			expect(cookie).toContain('HttpOnly')
			expect(cookie).toContain('SameSite=Lax')
			expect(cookie).not.toMatch(/Domain=/i)
		}
		expect(signedIn.startCookie).toStartWith(`${OAUTH_COOKIE_NAME}=`)
		expect(signedIn.sessionCookie).toStartWith(`${SESSION_COOKIE_NAME}=`)
		expect(signedIn.sessionCookie).toContain(`Max-Age=${SESSION_LIFETIME_SECONDS}`)

		const rotated = new DashboardAuth(configuration([newKey, oldKey]), { now: () => now })
		const sessionPair = cookiePair(signedIn.sessionCookie)
		expect(rotated.hasValidSession(sessionPair)).toBeTrue()
		const separator = sessionPair.indexOf('=')
		const value = sessionPair.slice(separator + 1)
		const tampered = `${sessionPair.slice(0, separator + 1)}${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`
		expect(rotated.hasValidSession(tampered)).toBeFalse()

		now += SESSION_LIFETIME_SECONDS * 1_000
		expect(rotated.hasValidSession(sessionPair)).toBeFalse()
		expect(rotated.clearSessionCookie()).toContain('Max-Age=0')
		expect(rotated.clearSessionCookie()).not.toMatch(/Domain=/i)
	})
})
