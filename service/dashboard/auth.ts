import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from 'node:crypto'
import type { DashboardConfiguration } from '../config.ts'

export const SESSION_COOKIE_NAME = '__Host-cukup_session'
export const OAUTH_COOKIE_NAME = '__Host-cukup_oauth'
export const SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60
export const OAUTH_LIFETIME_SECONDS = 10 * 60
const GITHUB_REQUEST_TIMEOUT_MS = 10_000

const githubAuthorizeUrl = 'https://github.com/login/oauth/authorize'
const githubTokenUrl = 'https://github.com/login/oauth/access_token'
const githubUserUrl = 'https://api.github.com/user'

type OAuthState = {
	type: 'oauth'
	state: string
	verifier: string
	expires_at: number
}

type DashboardSession = {
	type: 'session'
	subject: string
	issued_at: number
	expires_at: number
}

type OAuthStart = { location: string; cookie: string }
type OAuthCompletion = { sessionCookie: string; clearedOAuthCookie: string }

export class EncryptedCookieCodec {
	readonly #keys: readonly Uint8Array[]
	readonly #hostname: string

	constructor(keys: readonly Uint8Array[], hostname: string) {
		if (keys.length === 0 || keys.some((key) => key.byteLength !== 32)) {
			throw new Error('At least one 32-byte dashboard session key is required')
		}
		this.#keys = keys
		this.#hostname = hostname
	}

	seal(purpose: 'oauth' | 'session', value: OAuthState | DashboardSession): string {
		const nonce = randomBytes(12)
		const cipher = createCipheriv('aes-256-gcm', this.#keys[0]!, nonce)
		cipher.setAAD(this.#additionalData(purpose))
		const ciphertext = Buffer.concat([
			cipher.update(JSON.stringify(value), 'utf8'),
			cipher.final(),
		])
		return [
			'v1',
			nonce.toString('base64url'),
			ciphertext.toString('base64url'),
			cipher.getAuthTag().toString('base64url'),
		].join('.')
	}

	open(purpose: 'oauth' | 'session', value: string): unknown | undefined {
		if (value.length > 4096) return undefined
		const parts = value.split('.')
		if (parts.length !== 4 || parts[0] !== 'v1') return undefined
		try {
			const nonce = Buffer.from(parts[1]!, 'base64url')
			const ciphertext = Buffer.from(parts[2]!, 'base64url')
			const tag = Buffer.from(parts[3]!, 'base64url')
			if (nonce.byteLength !== 12 || ciphertext.byteLength === 0 || tag.byteLength !== 16) {
				return undefined
			}
			for (const key of this.#keys) {
				try {
					const decipher = createDecipheriv('aes-256-gcm', key, nonce)
					decipher.setAAD(this.#additionalData(purpose))
					decipher.setAuthTag(tag)
					const plaintext = Buffer.concat([
						decipher.update(ciphertext),
						decipher.final(),
					])
					return JSON.parse(plaintext.toString('utf8')) as unknown
				} catch {
					// A key ring permits old cookies to survive a primary-key rotation.
				}
			}
		} catch {
			return undefined
		}
		return undefined
	}

	#additionalData(purpose: 'oauth' | 'session'): Buffer {
		return Buffer.from(`cukup-dashboard\u0000${this.#hostname}\u0000${purpose}`)
	}
}

export class DashboardAuth {
	readonly #config: DashboardConfiguration
	readonly #codec: EncryptedCookieCodec
	readonly #fetch: typeof globalThis.fetch
	readonly #now: () => number

	constructor(
		config: DashboardConfiguration,
		options: { fetch?: typeof globalThis.fetch; now?: () => number } = {},
	) {
		this.#config = config
		this.#codec = new EncryptedCookieCodec(config.sessionKeys, config.hostname)
		this.#fetch = options.fetch ?? globalThis.fetch
		this.#now = options.now ?? Date.now
	}

	start(): OAuthStart {
		const state = randomBytes(32).toString('base64url')
		const verifier = randomBytes(32).toString('base64url')
		const challenge = createHash('sha256').update(verifier).digest('base64url')
		const location = new URL(githubAuthorizeUrl)
		location.searchParams.set('client_id', this.#config.githubClientId)
		location.searchParams.set('redirect_uri', this.#config.callbackUrl)
		location.searchParams.set('state', state)
		location.searchParams.set('code_challenge', challenge)
		location.searchParams.set('code_challenge_method', 'S256')
		const oauthState: OAuthState = {
			type: 'oauth',
			state,
			verifier,
			expires_at: this.#now() + OAUTH_LIFETIME_SECONDS * 1_000,
		}
		return {
			location: location.href,
			cookie: setCookie(
				OAUTH_COOKIE_NAME,
				this.#codec.seal('oauth', oauthState),
				OAUTH_LIFETIME_SECONDS,
			),
		}
	}

	async complete(searchParams: URLSearchParams, cookieHeader: string | null): Promise<OAuthCompletion | undefined> {
		const stateValues = searchParams.getAll('state')
		const codeValues = searchParams.getAll('code')
		if (stateValues.length !== 1 || codeValues.length !== 1 || searchParams.has('error')) {
			return undefined
		}
		const state = stateValues[0]!
		const code = codeValues[0]!
		if (state.length > 256 || code.length > 2048) return undefined
		const encryptedState = readCookie(cookieHeader, OAUTH_COOKIE_NAME)
		if (!encryptedState) return undefined
		const oauth = this.#codec.open('oauth', encryptedState)
		if (!isOAuthState(oauth) || oauth.expires_at <= this.#now() || oauth.state !== state) {
			return undefined
		}

		try {
			const accessToken = await this.#exchangeCode(code, oauth.verifier)
			if (!accessToken || !(await this.#isAllowedGithubUser(accessToken))) return undefined
			const issuedAt = this.#now()
			const session: DashboardSession = {
				type: 'session',
				subject: this.#config.allowedGithubUserId,
				issued_at: issuedAt,
				expires_at: issuedAt + SESSION_LIFETIME_SECONDS * 1_000,
			}
			return {
				sessionCookie: setCookie(
					SESSION_COOKIE_NAME,
					this.#codec.seal('session', session),
					SESSION_LIFETIME_SECONDS,
				),
				clearedOAuthCookie: clearCookie(OAUTH_COOKIE_NAME),
			}
		} catch {
			return undefined
		}
	}

	hasValidSession(cookieHeader: string | null): boolean {
		const encrypted = readCookie(cookieHeader, SESSION_COOKIE_NAME)
		if (!encrypted) return false
		const session = this.#codec.open('session', encrypted)
		return (
			isDashboardSession(session) &&
			session.subject === this.#config.allowedGithubUserId &&
			session.issued_at <= this.#now() &&
			session.expires_at > this.#now() &&
			session.expires_at - session.issued_at === SESSION_LIFETIME_SECONDS * 1_000
		)
	}

	clearSessionCookie(): string {
		return clearCookie(SESSION_COOKIE_NAME)
	}

	clearOAuthCookie(): string {
		return clearCookie(OAUTH_COOKIE_NAME)
	}

	async #exchangeCode(code: string, verifier: string): Promise<string | undefined> {
		const body = new URLSearchParams({
			client_id: this.#config.githubClientId,
			client_secret: this.#config.githubClientSecret,
			code,
			redirect_uri: this.#config.callbackUrl,
			code_verifier: verifier,
		})
		const response = await this.#fetch(githubTokenUrl, {
			method: 'POST',
			redirect: 'error',
			signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
			headers: {
				accept: 'application/json',
				'content-type': 'application/x-www-form-urlencoded',
			},
			body,
		})
		if (!response.ok) return undefined
		const value: unknown = await response.json()
		if (!isRecord(value)) return undefined
		return typeof value.access_token === 'string' &&
			value.access_token.length <= 2048 &&
			!/[\s]/.test(value.access_token) &&
			typeof value.token_type === 'string' &&
			value.token_type.toLowerCase() === 'bearer'
			? value.access_token
			: undefined
	}

	async #isAllowedGithubUser(accessToken: string): Promise<boolean> {
		const response = await this.#fetch(githubUserUrl, {
			redirect: 'error',
			signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
			headers: {
				accept: 'application/vnd.github+json',
				authorization: `Bearer ${accessToken}`,
				'x-github-api-version': '2022-11-28',
			},
		})
		if (!response.ok) return false
		const value: unknown = await response.json()
		return (
			isRecord(value) &&
			typeof value.id === 'number' &&
			Number.isSafeInteger(value.id) &&
			value.id > 0 &&
			String(value.id) === this.#config.allowedGithubUserId
		)
	}
}

export function readCookie(cookieHeader: string | null, name: string): string | undefined {
	if (!cookieHeader || cookieHeader.length > 16_384) return undefined
	const values: string[] = []
	for (const part of cookieHeader.split(';')) {
		const separator = part.indexOf('=')
		if (separator < 0 || part.slice(0, separator).trim() !== name) continue
		values.push(part.slice(separator + 1).trim())
	}
	return values.length === 1 && values[0] ? values[0] : undefined
}

function setCookie(name: string, value: string, maxAgeSeconds: number): string {
	return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`
}

function clearCookie(name: string): string {
	return `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure; HttpOnly; SameSite=Lax`
}

function isOAuthState(value: unknown): value is OAuthState {
	return (
		isRecord(value) &&
		value.type === 'oauth' &&
		typeof value.state === 'string' &&
		value.state.length === 43 &&
		typeof value.verifier === 'string' &&
		value.verifier.length === 43 &&
		typeof value.expires_at === 'number' &&
		Number.isSafeInteger(value.expires_at)
	)
}

function isDashboardSession(value: unknown): value is DashboardSession {
	return (
		isRecord(value) &&
		value.type === 'session' &&
		typeof value.subject === 'string' &&
		typeof value.issued_at === 'number' &&
		Number.isSafeInteger(value.issued_at) &&
		typeof value.expires_at === 'number' &&
		Number.isSafeInteger(value.expires_at)
	)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
