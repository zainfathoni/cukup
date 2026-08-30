import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	CUKUP_OIDC_AUDIENCE,
	TokenProviderError,
	createFileTokenProvider,
	createOidcTokenProvider,
} from './auth.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

describe('token providers', () => {
	test('rereads a rotated owner-only physical-machine credential each cycle', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'cukup-auth-test-'))
		temporaryDirectories.push(directory)
		const path = join(directory, 'token')
		const first = 'first-token-abcdefghijklmnopqrstuvwxyz'
		const second = 'second-token-abcdefghijklmnopqrstuvwxyz'
		writeFileSync(path, first, { mode: 0o600 })
		const provider = createFileTokenProvider(path)
		expect(await provider.getToken()).toBe(first)
		writeFileSync(path, second, { mode: 0o600 })
		expect(await provider.getToken()).toBe(second)
	})

	test('rejects missing, relative, and broadly readable token files without exposing contents', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'cukup-auth-test-'))
		temporaryDirectories.push(directory)
		const path = join(directory, 'token')
		const secret = 'secret-token-abcdefghijklmnopqrstuvwxyz'
		writeFileSync(path, secret, { mode: 0o600 })
		chmodSync(path, 0o640)

		for (const provider of [
			createFileTokenProvider(undefined),
			createFileTokenProvider('relative-token'),
			createFileTokenProvider(path),
		]) {
			try {
				await provider.getToken()
				throw new Error('expected token failure')
			} catch (error) {
				expect(error).toBeInstanceOf(TokenProviderError)
				expect(String(error)).not.toContain(secret)
			}
		}
	})

	test('mints a new workload token per call without placing a token in argv or logs', async () => {
		const calls: Array<{ strings: readonly string[]; values: unknown[] }> = []
		let tokenNumber = 0
		const provider = createOidcTokenProvider(async (strings, ...values) => {
			calls.push({ strings: [...strings], values })
			tokenNumber += 1
			return {
				exitCode: 0,
				stdout: `oidc-token-${tokenNumber}-abcdefghijklmnopqrstuvwxyz`,
				stderr: '',
			}
		})

		expect(await provider.getToken()).toContain('token-1')
		expect(await provider.getToken()).toContain('token-2')
		expect(calls).toHaveLength(2)
		expect(calls[0]?.strings.join('${value}')).toBe('amp orb id-token --audience ${value}')
		expect(calls[0]?.values).toEqual([CUKUP_OIDC_AUDIENCE])
		expect(JSON.stringify(calls)).not.toContain('oidc-token-')
	})

	test('surfaces workload token mint failure generically', async () => {
		const provider = createOidcTokenProvider(async () => ({
			exitCode: 1,
			stdout: '',
			stderr: 'provider-specific sensitive detail',
		}))
		await expect(provider.getToken()).rejects.toThrow('Amp workload identity minting failed.')
	})
})
