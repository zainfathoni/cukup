/**
 * Loads Playwright and a system Chromium. Neither is a project dependency.
 *
 * Set PLAYWRIGHT_MODULE to a Playwright package directory and CHROMIUM_PATH to
 * a Chromium binary when the defaults do not match your machine.
 * CHROMIUM_EXTRA_ARGS adds space-separated launch flags.
 */
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

type Chromium = typeof import('playwright').chromium

function playwrightModule(): string {
	if (process.env.PLAYWRIGHT_MODULE) return process.env.PLAYWRIGHT_MODULE
	const cli = Bun.which('playwright')
	if (cli) {
		const candidate = join(dirname(realpathSync(cli)), '..', 'playwright')
		if (existsSync(candidate)) return candidate
		const sibling = join(dirname(realpathSync(cli)), '..')
		if (existsSync(join(sibling, 'package.json'))) return sibling
	}
	throw new Error('Playwright not found. Install it globally or set PLAYWRIGHT_MODULE.')
}

export async function launchChromium() {
	const { chromium } = createRequire(import.meta.url)(playwrightModule()) as { chromium: Chromium }
	const executablePath = process.env.CHROMIUM_PATH ?? Bun.which('chromium') ?? undefined
	const extra = process.env.CHROMIUM_EXTRA_ARGS?.split(' ').filter(Boolean) ?? []
	return chromium.launch({ executablePath, args: ['--font-render-hinting=none', '--disable-lcd-text', ...extra] })
}
