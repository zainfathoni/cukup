import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose'
import { OIDC_AUDIENCE, OIDC_ISSUER } from './config.ts'

const TOKEN_PREFIX = 'cukup_v1_'
const TOKEN_PATTERN = /^cukup_v1_[A-Za-z0-9_-]{43}$/
const OIDC_CACHE_MS = 5 * 60 * 1_000

export type IssuedToken = { tokenId: string; token: string; tokenHash: string }

export function generateBearerToken(): IssuedToken {
	const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
	return { tokenId: randomUUID(), token, tokenHash: hashBearerToken(token) }
}

export function isBearerToken(value: string): boolean {
	return TOKEN_PATTERN.test(value)
}

export function hashBearerToken(token: string): string {
	return createHash('sha256').update(token).digest('hex')
}

type OidcVerifierOptions = {
	allowedUserId: string
	issuer?: string
	audience?: string
	fetch?: typeof globalThis.fetch
	now?: () => number
}

type CachedJwks = { value: JSONWebKeySet; expiresAtMs: number }

export class OidcVerifier {
	readonly #allowedUserId: string
	readonly #issuer: string
	readonly #audience: string
	readonly #fetch: typeof globalThis.fetch
	readonly #now: () => number
	#cachedJwks?: CachedJwks
	#loadingJwks?: Promise<JSONWebKeySet>

	constructor(options: OidcVerifierOptions) {
		if (!options.allowedUserId.trim()) throw new Error('An allowed OIDC user_id is required')
		this.#allowedUserId = options.allowedUserId
		this.#issuer = options.issuer ?? OIDC_ISSUER
		this.#audience = options.audience ?? OIDC_AUDIENCE
		this.#fetch = options.fetch ?? globalThis.fetch
		this.#now = options.now ?? Date.now
	}

	async verify(token: string): Promise<boolean> {
		if (token.length > 16_384 || token.split('.').length !== 3) return false
		try {
			return await this.#verifyWithJwks(token, await this.#jwks())
		} catch (error) {
			if (!isUnknownKeyError(error)) return false
			this.#cachedJwks = undefined
			this.#loadingJwks = undefined
			try {
				return await this.#verifyWithJwks(token, await this.#jwks())
			} catch {
				return false
			}
		}
	}

	async #verifyWithJwks(token: string, jwks: JSONWebKeySet): Promise<boolean> {
		const result = await jwtVerify(token, createLocalJWKSet(jwks), {
			algorithms: ['RS256'],
			issuer: this.#issuer,
			audience: this.#audience,
			currentDate: new Date(this.#now()),
		})
		return (
			typeof result.payload.exp === 'number' &&
			Number.isFinite(result.payload.exp) &&
			result.payload.token_use === 'exchanged' &&
			result.payload.user_id === this.#allowedUserId
		)
	}

	async #jwks(): Promise<JSONWebKeySet> {
		if (this.#cachedJwks && this.#cachedJwks.expiresAtMs > this.#now()) {
			return this.#cachedJwks.value
		}
		if (this.#loadingJwks) return this.#loadingJwks
		this.#loadingJwks = this.#discoverJwks()
		try {
			const value = await this.#loadingJwks
			this.#cachedJwks = { value, expiresAtMs: this.#now() + OIDC_CACHE_MS }
			return value
		} finally {
			this.#loadingJwks = undefined
		}
	}

	async #discoverJwks(): Promise<JSONWebKeySet> {
		const discoveryUrl = `${this.#issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
		const discovery = await getJson(this.#fetch, discoveryUrl)
		if (discovery.issuer !== this.#issuer || typeof discovery.jwks_uri !== 'string') {
			throw new Error('Invalid OIDC discovery document')
		}
		const jwksUrl = new URL(discovery.jwks_uri)
		if (jwksUrl.protocol !== 'https:') throw new Error('OIDC JWKS must use HTTPS')
		const jwks = await getJson(this.#fetch, jwksUrl.href)
		if (!Array.isArray(jwks.keys)) throw new Error('Invalid OIDC JWKS')
		return jwks as unknown as JSONWebKeySet
	}
}

async function getJson(fetcher: typeof globalThis.fetch, url: string): Promise<Record<string, unknown>> {
	const response = await fetcher(url, { headers: { accept: 'application/json' } })
	if (!response.ok) throw new Error('OIDC metadata unavailable')
	const value: unknown = await response.json()
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Invalid OIDC metadata')
	}
	return value as Record<string, unknown>
}

function isUnknownKeyError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === 'ERR_JWKS_NO_MATCHING_KEY'
	)
}
