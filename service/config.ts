import { join } from 'node:path'

export const SERVICE_TIMEZONE = 'Asia/Jakarta'
export const WEEK_START = 'monday'
export const DAILY_TARGET_MINUTES = [0, 480, 480, 480, 480, 480, 0] as const
export const IDLE_GRACE_MS = 15 * 60 * 1_000
export const CRASH_CAP_MS = IDLE_GRACE_MS
export const MAX_CLOCK_SKEW_MS = 10 * 60 * 1_000
export const OIDC_ISSUER = 'https://ampcode.com/api/workload-identity'
export const OIDC_AUDIENCE = 'https://cukup.dev'
export const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type DashboardConfiguration = {
	hostname: string
	callbackUrl: string
	githubClientId: string
	githubClientSecret: string
	allowedGithubUserId: string
	sessionKeys: readonly Uint8Array[]
}

const RESERVED_EXECUTOR_LABELS = new Set(['amp-orb', 'unassigned-executor'])
const HOSTNAME_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function defaultServiceDatabasePath(): string {
	return process.env.CUKUP_DATABASE_PATH?.trim() || join('data', 'cukup.sqlite')
}

export function configuredAllowedOidcUserId(): string {
	const userId = process.env.CUKUP_OIDC_ALLOWED_USER_ID?.trim()
	if (!userId) throw new Error('CUKUP_OIDC_ALLOWED_USER_ID is required')
	return userId
}

export function configuredApiHostname(
	value = process.env.CUKUP_API_HOSTNAME,
): string {
	return configuredHostname(value, 'CUKUP_API_HOSTNAME')
}

export function configuredDashboardHostname(
	value = process.env.CUKUP_DASHBOARD_HOSTNAME,
): string {
	return configuredHostname(value, 'CUKUP_DASHBOARD_HOSTNAME')
}

export function configuredDashboard(
	environment: Readonly<Record<string, string | undefined>>,
	hostname: string,
): DashboardConfiguration | undefined {
	const githubClientId = environment.CUKUP_GITHUB_OAUTH_CLIENT_ID?.trim()
	const githubClientSecret = environment.CUKUP_GITHUB_OAUTH_CLIENT_SECRET?.trim()
	const allowedGithubUserId = environment.CUKUP_GITHUB_ALLOWED_USER_ID?.trim()
	const encodedKeys = environment.CUKUP_DASHBOARD_SESSION_KEYS?.trim()
	if (!githubClientId || !githubClientSecret || !allowedGithubUserId || !encodedKeys) {
		return undefined
	}
	if (
		githubClientId.length > 256 ||
		githubClientSecret.length > 512 ||
		/\s/.test(githubClientId) ||
		!/^[1-9][0-9]{0,19}$/.test(allowedGithubUserId) ||
		BigInt(allowedGithubUserId) > BigInt(Number.MAX_SAFE_INTEGER)
	) {
		return undefined
	}
	const sessionKeys = encodedKeys.split(',').map(decodeSessionKey)
	if (sessionKeys.length === 0 || sessionKeys.some((key) => key === undefined)) {
		return undefined
	}
	return {
		hostname,
		callbackUrl: `https://${hostname}/auth/github/callback`,
		githubClientId,
		githubClientSecret,
		allowedGithubUserId,
		sessionKeys: sessionKeys as Uint8Array[],
	}
}

export function configuredFleetHostnames(value = process.env.CUKUP_FLEET_HOSTNAMES): ReadonlySet<string> {
	if (value === undefined || value === '') return new Set()
	const hostnames = value.split(',').map((hostname) => hostname.trim())
	if (hostnames.some((hostname) => !isCanonicalFleetHostname(hostname))) {
		throw new Error('CUKUP_FLEET_HOSTNAMES must contain comma-separated canonical hostnames')
	}
	return new Set(hostnames)
}

export function configuredNewTurnEventSchemaVersion(
	value = process.env.CUKUP_NEW_TURN_EVENT_SCHEMA_VERSION,
): 1 | 2 {
	if (value === undefined || value.trim() === '' || value.trim() === '1') return 1
	if (value.trim() === '2') return 2
	throw new Error('CUKUP_NEW_TURN_EVENT_SCHEMA_VERSION must be 1 or 2')
}

export function configuredWorkProjects(value = process.env.CUKUP_WORK_PROJECTS): ReadonlySet<string> {
	if (!value?.trim()) return new Set()
	const projects = value.split(',').map((slug) => slug.trim())
	if (projects.some((slug) => !isCanonicalProjectSlug(slug))) {
		throw new Error('CUKUP_WORK_PROJECTS must contain comma-separated canonical project slugs')
	}
	return new Set(projects)
}

export function isCanonicalProjectSlug(value: string): boolean {
	return value.length <= 64 && PROJECT_SLUG_PATTERN.test(value)
}

export function isCanonicalFleetHostname(value: string): boolean {
	return (
		value.length <= 253 &&
		!RESERVED_EXECUTOR_LABELS.has(value) &&
		value.split('.').every((label) => HOSTNAME_LABEL_PATTERN.test(label))
	)
}

function configuredHostname(
	value: string | undefined,
	name: string,
): string {
	const hostname = value?.trim()
	if (!hostname || !isCanonicalHttpHostname(hostname)) throw new Error(`${name} must be a canonical hostname`)
	return hostname
}

function isCanonicalHttpHostname(value: string): boolean {
	return (
		value.length <= 253 &&
		value === value.toLowerCase() &&
		value.split('.').every((label) => HOSTNAME_LABEL_PATTERN.test(label))
	)
}

function decodeSessionKey(value: string): Uint8Array | undefined {
	const encoded = value.trim()
	if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return undefined
	const key = Buffer.from(encoded, 'base64url')
	return key.byteLength === 32 && key.toString('base64url') === encoded ? key : undefined
}
