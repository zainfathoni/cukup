export const EVENT_SCHEMA_VERSION_V1 = 1 as const
export const EVENT_SCHEMA_VERSION_V2 = 2 as const
export const SUMMARY_SCHEMA_VERSION = 1 as const
export const CAPABILITIES_SCHEMA_VERSION = 1 as const
export const MAX_CLIENT_CLOCK_SKEW_MS = 10 * 60 * 1_000
export const REQUEST_TIMEOUT_MS = 10_000

export type EventKind = 'agent.start' | 'agent.end'

type OutboxEventBase = {
	event_id: string
	source_instance_id: string
	source_sequence: number
	session_id: string
	kind: EventKind
	occurred_at: string
	monotonic_duration_ms?: number
}

export type OutboxEvent =
	| (OutboxEventBase & { schema_version: typeof EVENT_SCHEMA_VERSION_V1 })
	| (OutboxEventBase & {
			schema_version: typeof EVENT_SCHEMA_VERSION_V2
			project_slug?: string
		})

export type DeliveryStatus = 'accepted' | 'duplicate' | 'conflict' | 'rejected'

export type DeliveryResult = {
	event_id: string
	status: DeliveryStatus
}

export type SummaryPeriod = {
	status: 'UNDER' | 'COMPLETE' | 'OVER'
	worked_minutes: number
	target_minutes: number
	difference_minutes: number
}

export type AuthoritativeSummary = {
	schema_version: typeof SUMMARY_SCHEMA_VERSION
	as_of: string
	daily: SummaryPeriod
	weekly: SummaryPeriod
}

export type Track = 'work' | 'play' | 'all'

export type LimitPeriod = {
	status: 'WITHIN' | 'TOLERANCE' | 'EXCEEDED'
	worked_minutes: number
	target_minutes: number
	upper_limit_minutes: number
	difference_minutes: number
}

export type TrackSummary = {
	schema_version: typeof SUMMARY_SCHEMA_VERSION
	track: Track
	timezone: 'Asia/Jakarta'
	as_of: string
	daily: SummaryPeriod | LimitPeriod
	weekly: SummaryPeriod | LimitPeriod
}

export type ServiceCapabilities = {
	acceptedEventSchemaVersions: Array<1 | 2>
	preferredNewEventSchemaVersion: 1 | 2
}

export type TargetOverride = {
	date: string
	target_minutes: 0 | 240
}

export type ClockSample = {
	offsetMs: number
	roundTripMs: number
	sampledAtMs: number
}

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>

export class ServiceRequestError extends Error {
	constructor(
		readonly kind: 'authentication' | 'network' | 'protocol' | 'service',
		readonly retryable: boolean,
	) {
		super(serviceErrorMessage(kind))
		this.name = 'ServiceRequestError'
	}
}

export class CukupServiceClient {
	readonly #baseURL: URL
	readonly #fetch: Fetcher
	readonly #now: () => number

	constructor(serviceURL: string, fetcher: Fetcher = fetch, now: () => number = Date.now) {
		this.#baseURL = validateServiceURL(serviceURL)
		this.#fetch = fetcher
		this.#now = now
	}

	async sampleTime(token: string): Promise<ClockSample> {
		const startedAtMs = this.#now()
		const response = await this.#request('/v1/time', token, { method: 'GET' })
		const finishedAtMs = this.#now()
		const body = await responseJSON(response)
		if (!isRecord(body) || typeof body.server_time !== 'string') {
			throw new ServiceRequestError('protocol', false)
		}
		const serverTimeMs = parseTimestamp(body.server_time)
		return {
			offsetMs: serverTimeMs - (startedAtMs + finishedAtMs) / 2,
			roundTripMs: Math.max(0, finishedAtMs - startedAtMs),
			sampledAtMs: finishedAtMs,
		}
	}

	async fetchCapabilities(token: string): Promise<ServiceCapabilities | undefined> {
		const response = await this.#request('/v1/capabilities', token, { method: 'GET' }, true)
		if (response.status === 404) return undefined
		const body = await responseJSON(response)
		const acceptedEventSchemaVersions = isRecord(body)
			? body.accepted_event_schema_versions
			: undefined
		if (
			!isRecord(body) ||
			body.schema_version !== CAPABILITIES_SCHEMA_VERSION ||
			!Array.isArray(acceptedEventSchemaVersions) ||
			!acceptedEventSchemaVersions.every(isEventSchemaVersion) ||
			!isEventSchemaVersion(body.preferred_new_event_schema_version)
		) {
			throw new ServiceRequestError('protocol', false)
		}
		return {
			acceptedEventSchemaVersions: [...acceptedEventSchemaVersions],
			preferredNewEventSchemaVersion: body.preferred_new_event_schema_version,
		}
	}

	async bindExecutorProfile(token: string, hostname: string): Promise<void> {
		if (!hostname || hostname.length > 255 || /\s/.test(hostname)) {
			throw new ServiceRequestError('protocol', false)
		}
		const response = await this.#request('/v1/executor-profile', token, {
			method: 'PUT',
			body: JSON.stringify({ hostname }),
		})
		const body = await responseJSON(response)
		if (!isRecord(body) || body.executor_label !== hostname) {
			throw new ServiceRequestError('protocol', false)
		}
	}

	async uploadBatch(token: string, events: readonly OutboxEvent[]): Promise<DeliveryResult[]> {
		const response = await this.#request('/v1/events:batch', token, {
			method: 'POST',
			body: JSON.stringify({ events }),
		})
		const body = await responseJSON(response)
		if (!isRecord(body) || !Array.isArray(body.results)) {
			throw new ServiceRequestError('protocol', false)
		}

		const sent = new Set(events.map((event) => event.event_id))
		const seen = new Set<string>()
		return body.results.map((value) => {
			if (!isRecord(value) || typeof value.event_id !== 'string' || !sent.has(value.event_id)) {
				throw new ServiceRequestError('protocol', false)
			}
			if (seen.has(value.event_id) || !isDeliveryStatus(value.status)) {
				throw new ServiceRequestError('protocol', false)
			}
			seen.add(value.event_id)
			return { event_id: value.event_id, status: value.status }
		})
	}

	async fetchSummary(token: string): Promise<AuthoritativeSummary> {
		const response = await this.#request('/v1/summary', token, { method: 'GET' })
		return parseSummary(await responseJSON(response))
	}

	async fetchTrackSummary(token: string, track: Track): Promise<TrackSummary> {
		const response = await this.#request(`/v1/summary?track=${track}`, token, { method: 'GET' })
		const body = await responseJSON(response)
		if (
			!isRecord(body) || body.schema_version !== SUMMARY_SCHEMA_VERSION ||
			body.track !== track || body.timezone !== 'Asia/Jakarta' || typeof body.as_of !== 'string'
		) throw new ServiceRequestError('protocol', false)
		parseTimestamp(body.as_of)
		return {
			schema_version: SUMMARY_SCHEMA_VERSION,
			track,
			timezone: 'Asia/Jakarta',
			as_of: body.as_of,
			daily: track === 'work' ? parseSummaryPeriod(body.daily) : parseLimitPeriod(body.daily),
			weekly: track === 'work' ? parseSummaryPeriod(body.weekly) : parseLimitPeriod(body.weekly),
		}
	}

	async putTargetOverride(
		token: string,
		date: string,
		targetMinutes: TargetOverride['target_minutes'] = 0,
	): Promise<TargetOverride> {
		if (!isTargetOverrideDate(date)) throw new ServiceRequestError('protocol', false)
		const response = await this.#request(`/v1/target-overrides/${date}`, token, {
			method: 'PUT',
			body: JSON.stringify({ target_minutes: targetMinutes }),
		})
		const body = await responseJSON(response)
		if (
			!isRecord(body) ||
			Object.keys(body).length !== 2 ||
			body.date !== date ||
			body.target_minutes !== targetMinutes
		) {
			throw new ServiceRequestError('protocol', false)
		}
		return { date, target_minutes: targetMinutes }
	}

	async clearTargetOverride(token: string, date: string): Promise<void> {
		if (!isTargetOverrideDate(date)) throw new ServiceRequestError('protocol', false)
		const response = await this.#request(`/v1/target-overrides/${date}`, token, {
			method: 'DELETE',
		})
		if (response.status !== 204) throw new ServiceRequestError('protocol', false)
	}

	async #request(
		path: string,
		token: string,
		init: RequestInit,
		allowNotFound = false,
	): Promise<Response> {
		let response: Response
		try {
			response = await this.#fetch(new URL(path, this.#baseURL).toString(), {
				...init,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				headers: {
					accept: 'application/json',
					authorization: `Bearer ${token}`,
					...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
				},
			})
		} catch {
			throw new ServiceRequestError('network', true)
		}

		if (response.ok || (allowNotFound && response.status === 404)) return response
		if (response.status === 401 || response.status === 403) {
			throw new ServiceRequestError('authentication', false)
		}
		if (response.status === 408 || response.status === 425 || response.status === 429) {
			throw new ServiceRequestError('service', true)
		}
		if (response.status >= 500) throw new ServiceRequestError('service', true)
		throw new ServiceRequestError('protocol', false)
	}
}

export function parseSummary(value: unknown): AuthoritativeSummary {
	if (
		!isRecord(value) ||
		value.schema_version !== SUMMARY_SCHEMA_VERSION ||
		typeof value.as_of !== 'string'
	) {
		throw new ServiceRequestError('protocol', false)
	}
	parseTimestamp(value.as_of)
	return {
		schema_version: SUMMARY_SCHEMA_VERSION,
		as_of: value.as_of,
		daily: parseSummaryPeriod(value.daily),
		weekly: parseSummaryPeriod(value.weekly),
	}
}

export function validateServiceURL(value: string): URL {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error('CUKUP_SERVICE_URL must be an absolute HTTPS URL.')
	}
	if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
		throw new Error('CUKUP_SERVICE_URL must be an origin without credentials, paths, queries, or fragments.')
	}
	const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
	if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
		throw new Error('CUKUP_SERVICE_URL must use HTTPS except for a loopback deployment proxy.')
	}
	return url
}

export function isTargetOverrideDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
	if (!match) return false
	const year = Number(match[1])
	const month = Number(match[2])
	const day = Number(match[3])
	if (year < 1 || month < 1 || month > 12) return false
	const daysInMonth = [
		31,
		year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	][month - 1]!
	return day >= 1 && day <= daysInMonth
}

function parseLimitPeriod(value: unknown): LimitPeriod {
	if (
		!isRecord(value) ||
		(value.status !== 'WITHIN' && value.status !== 'TOLERANCE' && value.status !== 'EXCEEDED') ||
		!isMinutes(value.worked_minutes) || !isMinutes(value.target_minutes) ||
		!isMinutes(value.upper_limit_minutes) || !isMinutes(value.difference_minutes) ||
		value.upper_limit_minutes < value.target_minutes
	) throw new ServiceRequestError('protocol', false)
	return {
		status: value.status,
		worked_minutes: value.worked_minutes,
		target_minutes: value.target_minutes,
		upper_limit_minutes: value.upper_limit_minutes,
		difference_minutes: value.difference_minutes,
	}
}

function parseSummaryPeriod(value: unknown): SummaryPeriod {
	if (
		!isRecord(value) ||
		(value.status !== 'UNDER' && value.status !== 'COMPLETE' && value.status !== 'OVER') ||
		!isMinutes(value.worked_minutes) ||
		!isMinutes(value.target_minutes) ||
		!isMinutes(value.difference_minutes)
	) {
		throw new ServiceRequestError('protocol', false)
	}
	return {
		status: value.status,
		worked_minutes: value.worked_minutes,
		target_minutes: value.target_minutes,
		difference_minutes: value.difference_minutes,
	}
}

function responseJSON(response: Response): Promise<unknown> {
	return response.json().catch(() => {
		throw new ServiceRequestError('protocol', false)
	})
}

function parseTimestamp(value: string): number {
	const parsed = Date.parse(value)
	if (!Number.isFinite(parsed) || !value.endsWith('Z')) {
		throw new ServiceRequestError('protocol', false)
	}
	return parsed
}

function isDeliveryStatus(value: unknown): value is DeliveryStatus {
	return value === 'accepted' || value === 'duplicate' || value === 'conflict' || value === 'rejected'
}

function isMinutes(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0
}

function isEventSchemaVersion(value: unknown): value is 1 | 2 {
	return value === EVENT_SCHEMA_VERSION_V1 || value === EVENT_SCHEMA_VERSION_V2
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function serviceErrorMessage(kind: ServiceRequestError['kind']): string {
	switch (kind) {
		case 'authentication':
			return 'Cukup authentication was rejected.'
		case 'network':
			return 'The Cukup service is unreachable.'
		case 'protocol':
			return 'The Cukup service returned an invalid response.'
		case 'service':
			return 'The Cukup service is temporarily unavailable.'
	}
}
