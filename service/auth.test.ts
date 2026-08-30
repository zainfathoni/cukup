import { beforeAll, describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { OidcVerifier } from './auth.ts'
import { OIDC_AUDIENCE, OIDC_ISSUER } from './config.ts'

const nowSeconds = 1_788_174_000
const allowedUserId = 'allowed-user-id'
const jwksUri = 'https://identity.test/jwks'
let privateKey: CryptoKey
let otherPrivateKey: CryptoKey
let publicJwk: JWK

beforeAll(async () => {
	const primary = await generateKeyPair('RS256', { extractable: true })
	const other = await generateKeyPair('RS256', { extractable: true })
	privateKey = primary.privateKey
	otherPrivateKey = other.privateKey
	publicJwk = { ...(await exportJWK(primary.publicKey)), kid: 'primary', alg: 'RS256', use: 'sig' }
})

type Claims = {
	iss?: string
	aud?: string
	exp?: number
	token_use?: string
	user_id?: string
	thread_id?: string
}

async function token(claims: Claims = {}, key = privateKey): Promise<string> {
	const values = {
		iss: OIDC_ISSUER,
		aud: OIDC_AUDIENCE,
		exp: nowSeconds + 300,
		token_use: 'exchanged',
		user_id: allowedUserId,
		thread_id: 'T-auth-layer-only',
		...claims,
	}
	return new SignJWT(values)
		.setProtectedHeader({ alg: 'RS256', kid: 'primary' })
		.sign(key)
}

function verifier(discoveryIssuer = OIDC_ISSUER): { verifier: OidcVerifier; requests: string[] } {
	const requests: string[] = []
	const fetcher = (async (input: RequestInfo | URL) => {
		const url = input instanceof Request ? input.url : String(input)
		requests.push(url)
		if (url.endsWith('/.well-known/openid-configuration')) {
			return Response.json({ issuer: discoveryIssuer, jwks_uri: jwksUri })
		}
		if (url === jwksUri) return Response.json({ keys: [publicJwk] })
		return new Response(null, { status: 404 })
	}) as typeof fetch
	return {
		verifier: new OidcVerifier({
			allowedUserId,
			fetch: fetcher,
			now: () => nowSeconds * 1_000,
		}),
		requests,
	}
}

describe('Amp workload OIDC verification', () => {
	test('discovers and caches HTTPS JWKS while accepting the exact workload contract', async () => {
		const fixture = verifier()
		expect(await fixture.verifier.verify(await token())).toBeTrue()
		expect(await fixture.verifier.verify(await token())).toBeTrue()
		expect(fixture.requests).toEqual([
			`${OIDC_ISSUER}/.well-known/openid-configuration`,
			jwksUri,
		])
	})

	test('rejects invalid issuer, audience, signature, expiry, token_use, and user_id', async () => {
		const fixture = verifier()
		const invalidTokens = [
			await token({ iss: 'https://issuer.invalid' }),
			await token({ aud: 'https://audience.invalid' }),
			await token({}, otherPrivateKey),
			await token({ exp: nowSeconds - 1 }),
			await token({ exp: undefined }),
			await token({ token_use: 'access' }),
			await token({ user_id: 'other-user' }),
		]
		for (const value of invalidTokens) expect(await fixture.verifier.verify(value)).toBeFalse()
	})

	test('rejects discovery metadata that does not repeat the configured issuer', async () => {
		const fixture = verifier('https://issuer.invalid')
		expect(await fixture.verifier.verify(await token())).toBeFalse()
	})
})
