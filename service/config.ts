import { join } from 'node:path'

export const SERVICE_TIMEZONE = 'Asia/Jakarta'
export const WEEK_START = 'monday'
export const DAILY_TARGET_MINUTES = [0, 480, 480, 480, 480, 480, 0] as const
export const IDLE_GRACE_MS = 15 * 60 * 1_000
export const CRASH_CAP_MS = IDLE_GRACE_MS
export const MAX_CLOCK_SKEW_MS = 10 * 60 * 1_000
export const OIDC_ISSUER = 'https://ampcode.com/api/workload-identity'
export const OIDC_AUDIENCE = 'https://cukup.dev'

export function defaultServiceDatabasePath(): string {
	return process.env.CUKUP_DATABASE_PATH?.trim() || join('data', 'cukup.sqlite')
}

export function configuredAllowedOidcUserId(): string {
	const userId = process.env.CUKUP_OIDC_ALLOWED_USER_ID?.trim()
	if (!userId) throw new Error('CUKUP_OIDC_ALLOWED_USER_ID is required')
	return userId
}
