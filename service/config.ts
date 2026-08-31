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
