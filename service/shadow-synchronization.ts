import type { Database } from 'bun:sqlite'
import { isUuidV4 } from './harness-evidence-protocol.ts'

const MAX_TIME = 253402300799999
export type SynchronizationObservation = {
	protocol_version: number
	collector_instance_id: string
	observation_sequence: number
	observed_at_ms: number
	state: 'clear' | 'queued' | 'retrying' | 'blocked'
	records: number
	bytes: number
	oldest_queued_at_ms: number | null
}
type Reason = 'invalid_record' | 'unsupported_version' | 'collector_not_registered' |
	'identity_conflict' | 'stale_observation' | 'invalid_observation_time'
export type SynchronizationOutcome = { status: 'accepted' | 'duplicate' } |
	{ status: 'rejected'; reason: Reason } |
	{ error: 'unauthorized' | 'executor_profile_required' | 'temporarily_unavailable' }
const rejected = (reason: Reason): SynchronizationOutcome => ({ status: 'rejected', reason })
const integer = (value: unknown, min: number, max: number): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max

export function parseSynchronization(value: unknown): SynchronizationObservation | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const v = value as Record<string, unknown>
	const fields = ['protocol_version', 'collector_instance_id', 'observation_sequence',
		'observed_at_ms', 'state', 'records', 'bytes', 'oldest_queued_at_ms']
	if (Object.keys(v).length !== 8 || !fields.every((field) => Object.hasOwn(v, field)) ||
		!integer(v.protocol_version, 1, Number.MAX_SAFE_INTEGER) ||
		typeof v.collector_instance_id !== 'string' || !isUuidV4(v.collector_instance_id) ||
		!integer(v.observation_sequence, 1, Number.MAX_SAFE_INTEGER) ||
		!integer(v.observed_at_ms, 0, MAX_TIME) ||
		!['clear', 'queued', 'retrying', 'blocked'].includes(v.state as string) ||
		!integer(v.records, 0, 10000) || !integer(v.bytes, 0, 8388608)) return undefined
	if (v.records === 0) {
		if (v.state !== 'clear' || v.bytes !== 0 || v.oldest_queued_at_ms !== null) return undefined
	} else if (v.state === 'clear' || v.bytes === 0 ||
		!integer(v.oldest_queued_at_ms, 0, MAX_TIME) ||
		v.oldest_queued_at_ms > v.observed_at_ms + 600000) return undefined
	// Fixed field order normalizes key order, whitespace, and numeric spelling.
	return Object.fromEntries(fields.map((field) => [field, v[field]])) as SynchronizationObservation
}

/** UTC trust comes from the host, never inferred from a plausible Date.now() value. */
export type SynchronizationClockSource = { now: () => number; trusted: () => boolean }
export class SynchronizationClock {
	private last?: number
	private healthy = false
	constructor(private readonly source: SynchronizationClockSource = { now: Date.now, trusted: () => false }) {
		this.restoreTrust()
	}
	/** Explicit host revalidation after clock repair; sampling never silently restores trust. */
	restoreTrust(): boolean {
		this.healthy = false
		try {
			const now = this.source.now()
			if (this.source.trusted() && integer(now, 0, MAX_TIME)) {
				this.last = now
				this.healthy = true
			}
		} catch { /* Unavailable trust or clock is unknown. */ }
		return this.healthy
	}
	sample(): number | undefined {
		try {
			const now = this.source.now()
			if (this.healthy && this.source.trusted() && integer(now, 0, MAX_TIME) && now >= this.last!) {
				this.last = now
				return now
			}
		} catch { /* No diagnostics from the clock provider. */ }
		this.healthy = false
		return undefined
	}
}

/** Additive schema 8. Only the normalized eight fields and receipt/expiry are stored. */
export const SHADOW_SYNCHRONIZATION_SCHEMA = `
	CREATE TABLE shadow_synchronization (
		collector_instance_id TEXT PRIMARY KEY REFERENCES shadow_collectors(collector_id),
		protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
		observation_sequence INTEGER NOT NULL CHECK (observation_sequence BETWEEN 1 AND 9007199254740991),
		observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms BETWEEN 0 AND 253402300799999),
		state TEXT NOT NULL CHECK (state IN ('clear', 'queued', 'retrying', 'blocked')),
		records INTEGER NOT NULL CHECK (records BETWEEN 0 AND 10000),
		bytes INTEGER NOT NULL CHECK (bytes BETWEEN 0 AND 8388608),
		oldest_queued_at_ms INTEGER CHECK (oldest_queued_at_ms BETWEEN 0 AND 253402300799999),
		received_at_ms INTEGER NOT NULL CHECK (received_at_ms BETWEEN 0 AND 253402300799999),
		expires_at_ms INTEGER NOT NULL,
		CHECK ((state = 'clear' AND records = 0 AND bytes = 0 AND oldest_queued_at_ms IS NULL) OR
		 (state != 'clear' AND records > 0 AND bytes > 0 AND oldest_queued_at_ms IS NOT NULL
		 AND oldest_queued_at_ms <= observed_at_ms + 600000)),
		CHECK (observed_at_ms BETWEEN received_at_ms - 60000 AND received_at_ms + 10000),
		CHECK (expires_at_ms = min(received_at_ms + 120000, observed_at_ms + 120000))
	) STRICT;
`
type Snapshot = SynchronizationObservation & { received_at_ms: number; expires_at_ms: number }

export class ShadowSynchronizationStore {
	readonly clock: SynchronizationClock
	constructor(private readonly database: Database, source?: SynchronizationClockSource) {
		this.clock = new SynchronizationClock(source)
	}

	/** One lookup distinguishes a revoked credential from an active, unprofiled credential. */
	authorize(tokenId: string): { site: string } | { error: 'unauthorized' | 'executor_profile_required' } {
		const auth = this.database.query<{ site: string | null; profile: string | null }, [string]>(
			`SELECT execution_site_id AS site, executor_label AS profile FROM auth_tokens
			 WHERE token_id = ? AND revoked_at IS NULL`,
		).get(tokenId)
		if (!auth) return { error: 'unauthorized' }
		if (!auth.site || !auth.profile) return { error: 'executor_profile_required' }
		return { site: auth.site }
	}

	/** tokenId is authenticated by the app, then revalidated under the same writer lock as replacement. */
	observe(tokenId: string, input: unknown): SynchronizationOutcome {
		return this.database.transaction((): SynchronizationOutcome => {
			const auth = this.authorize(tokenId)
			if ('error' in auth) return auth
			const observation = parseSynchronization(input)
			if (!observation) return rejected('invalid_record')
			if (observation.protocol_version !== 1) return rejected('unsupported_version')
			const binding = this.database.query<{ site: string }, [string]>(
				'SELECT execution_site_id AS site FROM shadow_collectors WHERE collector_id = ?',
			).get(observation.collector_instance_id)
			if (!binding) return rejected('collector_not_registered')
			if (binding.site !== auth.site) return rejected('identity_conflict')
			const latest = this.database.query<Snapshot, [string]>(
				'SELECT * FROM shadow_synchronization WHERE collector_instance_id = ?',
			).get(observation.collector_instance_id)
			// Sample even on replay to detect jumps, but freshness never changes replay classification.
			const receipt = this.clock.sample()
			if (latest) {
				if (observation.observation_sequence < latest.observation_sequence) return rejected('stale_observation')
				if (observation.observation_sequence === latest.observation_sequence) {
					return (Object.keys(observation) as Array<keyof SynchronizationObservation>)
						.every((key) => observation[key] === latest[key])
						? { status: 'duplicate' } : rejected('identity_conflict')
				}
			}
			if (receipt === undefined) return { error: 'temporarily_unavailable' }
			if (observation.observed_at_ms < receipt - 60000 || observation.observed_at_ms > receipt + 10000) {
				return rejected('invalid_observation_time')
			}
			const o = observation
			this.database.query(`INSERT INTO shadow_synchronization VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (collector_instance_id) DO UPDATE SET
				 protocol_version = excluded.protocol_version, observation_sequence = excluded.observation_sequence,
				 observed_at_ms = excluded.observed_at_ms, state = excluded.state, records = excluded.records,
				 bytes = excluded.bytes, oldest_queued_at_ms = excluded.oldest_queued_at_ms,
				 received_at_ms = excluded.received_at_ms, expires_at_ms = excluded.expires_at_ms`).run(
				o.collector_instance_id, o.protocol_version, o.observation_sequence, o.observed_at_ms,
				o.state, o.records, o.bytes, o.oldest_queued_at_ms, receipt,
				Math.min(receipt + 120000, o.observed_at_ms + 120000),
			)
			return { status: 'accepted' }
		}).immediate()
	}

	/** Internal only: no projection, public endpoint, stale fallback, or expiry deletion. */
	read(collector: string, site: string): { state: 'unknown' } | { state: 'fresh'; snapshot: Snapshot } {
		try {
			const now = this.clock.sample()
			if (now === undefined) return { state: 'unknown' }
			const snapshot = this.database.query<Snapshot, [string, string]>(
				`SELECT s.* FROM shadow_synchronization s JOIN shadow_collectors c
				 ON c.collector_id = s.collector_instance_id
				 WHERE c.collector_id = ? AND c.execution_site_id = ?`,
			).get(collector, site)
			return snapshot && snapshot.received_at_ms <= now && now < snapshot.expires_at_ms
				? { state: 'fresh', snapshot } : { state: 'unknown' }
		} catch { return { state: 'unknown' } }
	}
}

/** Bounded streaming bytes; JSON.parse validates grammar, the token walk rejects duplicate decoded keys. */
export async function synchronizationBody(request: Request): Promise<
	{ value: unknown } | { error: 'invalid_json' | 'payload_too_large' }
> {
	const reader = request.body?.getReader()
	const bytes = new Uint8Array(1024)
	let length = 0
	try {
		if (reader) for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			if (length + value.byteLength > 1024) {
				void reader.cancel().catch(() => {})
				return { error: 'payload_too_large' }
			}
			bytes.set(value, length)
			length += value.byteLength
		}
		const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length))
		const value: unknown = JSON.parse(text)
		const stack: Array<Set<string> | null> = []
		const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? []
		let invalidNumber = false
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i]!
			if (token === '{') stack.push(new Set())
			else if (token === '[') stack.push(null)
			else if (token === '}' || token === ']') stack.pop()
			else if (token.startsWith('"') && tokens[i + 1] === ':') {
				const keys = stack.at(-1)!
				const key = JSON.parse(token) as string
				if (keys!.has(key)) return { error: 'invalid_json' }
				keys!.add(key)
			} else if (/^-?\d/.test(token) && !exactInteger(token)) {
				invalidNumber = true
			}
		}
		// Duplicate keys/syntax take priority; malformed numeric values are semantic invalid_record.
		return { value: invalidNumber ? null : value }
	} catch { return { error: 'invalid_json' } }
	finally { reader?.releaseLock() }
}

/** Check decimal integrality before IEEE-754 rounding, including exponent underflow. */
function exactInteger(token: string): boolean {
	const [mantissa, exponent = '0'] = token.toLowerCase().split('e')
	const digits = mantissa!.replace(/[-.]/g, '')
	if (/^0+$/.test(digits)) return true
	const fractionalDigits = mantissa!.split('.')[1]?.length ?? 0
	const trailingZeros = /0*$/.exec(digits)![0].length
	return fractionalDigits - Number(exponent) <= trailingZeros && Number.isSafeInteger(Number(token))
}
