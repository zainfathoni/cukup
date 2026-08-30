import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const CUKUP_OIDC_AUDIENCE = 'https://cukup.dev'

export interface TokenProvider {
	getToken(): Promise<string>
}

export class TokenProviderError extends Error {
	constructor(readonly kind: 'missing' | 'unsafe' | 'mint-failed') {
		super(tokenErrorMessage(kind))
		this.name = 'TokenProviderError'
	}
}

export function createFileTokenProvider(path: string | undefined): TokenProvider {
	return {
		async getToken() {
			if (!path || !isAbsolute(path)) throw new TokenProviderError('missing')
			let descriptor: number
			try {
				descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
			} catch {
				throw new TokenProviderError('missing')
			}
			try {
				const stat = fstatSync(descriptor)
				const currentUID = typeof process.getuid === 'function' ? process.getuid() : undefined
				if (
					!stat.isFile() ||
					(stat.mode & 0o777) !== 0o600 ||
					(currentUID !== undefined && stat.uid !== currentUID) ||
					stat.size > 16 * 1_024
				) {
					throw new TokenProviderError('unsafe')
				}
				return validateToken(readFileSync(descriptor, 'utf8').trim(), 'missing')
			} catch (error) {
				if (error instanceof TokenProviderError) throw error
				throw new TokenProviderError('missing')
			} finally {
				closeSync(descriptor)
			}
		},
	}
}

type AmpShell = (
	strings: TemplateStringsArray,
	...values: unknown[]
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export function createOidcTokenProvider(shell: AmpShell): TokenProvider {
	return {
		async getToken() {
			let result: Awaited<ReturnType<AmpShell>>
			try {
				result = await shell`amp orb id-token --audience ${CUKUP_OIDC_AUDIENCE}`
			} catch {
				throw new TokenProviderError('mint-failed')
			}
			if (result.exitCode !== 0) throw new TokenProviderError('mint-failed')
			return validateToken(result.stdout.trim(), 'mint-failed')
		},
	}
}

export function unavailableTokenProvider(): TokenProvider {
	return {
		async getToken() {
			throw new TokenProviderError('missing')
		},
	}
}

function validateToken(token: string, kind: TokenProviderError['kind']): string {
	if (token.length < 32 || token.length > 16 * 1_024 || /\s/.test(token)) {
		throw new TokenProviderError(kind)
	}
	return token
}

function tokenErrorMessage(kind: TokenProviderError['kind']): string {
	switch (kind) {
		case 'missing':
			return 'Cukup credentials are unavailable.'
		case 'unsafe':
			return 'The Cukup token file must be owner-only (0600).'
		case 'mint-failed':
			return 'Amp workload identity minting failed.'
	}
}
