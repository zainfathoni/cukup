import type { IngestOutcome, WorkEvent } from './types.ts'

export const MAX_REQUEST_BYTES = 1_048_576

const EVENT_FIELDS = new Set([
	'schema_version',
	'event_id',
	'source_instance_id',
	'source_sequence',
	'session_id',
	'kind',
	'occurred_at',
	'monotonic_duration_ms',
])
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID_V5_OR_V7 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[57][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID_V4_OR_V5 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export type ParsedBatchEntry =
	| { index: number; eventId?: string; event: WorkEvent }
	| {
			index: number
			eventId?: string
			reason: 'invalid_event' | 'prohibited_field' | 'source_sequence_order'
	  }

export type BatchResult = {
	event_id: string
	status: 'accepted' | 'duplicate' | 'conflict' | 'rejected'
}

export function parseBatch(value: unknown): ParsedBatchEntry[] | undefined {
	if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.events)) {
		return undefined
	}
	const entries = value.events.map((event, index) => parseEvent(event, index))
	const highestSequence = new Map<string, number>()
	return entries.map((entry) => {
		if (!('event' in entry)) return entry
		const highest = highestSequence.get(entry.event.sourceInstance)
		if (highest !== undefined && entry.event.sourceSequence < highest) {
			return { index: entry.index, eventId: entry.eventId, reason: 'source_sequence_order' }
		}
		highestSequence.set(entry.event.sourceInstance, entry.event.sourceSequence)
		return entry
	})
}

export function batchResult(
	entry: Pick<ParsedBatchEntry, 'eventId'>,
	result: IngestOutcome,
): BatchResult {
	return {
		event_id: entry.eventId ?? '',
		status: result.outcome === 'conflicted' ? 'conflict' : result.outcome,
	}
}

function parseEvent(value: unknown, index: number): ParsedBatchEntry {
	if (!isRecord(value)) return { index, reason: 'invalid_event' }
	const eventId =
		typeof value.event_id === 'string' && UUID_V5_OR_V7.test(value.event_id)
			? value.event_id
			: undefined
	if (Object.keys(value).some((key) => !EVENT_FIELDS.has(key))) {
		return { index, ...(eventId ? { eventId } : {}), reason: 'prohibited_field' }
	}
	if (
		value.schema_version !== 1 ||
		typeof value.event_id !== 'string' ||
		!UUID_V5_OR_V7.test(value.event_id) ||
		typeof value.source_instance_id !== 'string' ||
		!UUID_V4.test(value.source_instance_id) ||
		!Number.isSafeInteger(value.source_sequence) ||
		(value.source_sequence as number) < 1 ||
		typeof value.session_id !== 'string' ||
		!UUID_V4_OR_V5.test(value.session_id) ||
		(value.kind !== 'agent.start' && value.kind !== 'agent.end') ||
		typeof value.occurred_at !== 'string' ||
		!UTC_MILLISECONDS.test(value.occurred_at) ||
		(value.monotonic_duration_ms !== undefined &&
			(typeof value.monotonic_duration_ms !== 'number' ||
				!Number.isSafeInteger(value.monotonic_duration_ms) ||
				value.monotonic_duration_ms < 0))
	) {
		return { index, ...(eventId ? { eventId } : {}), reason: 'invalid_event' }
	}

	const occurredAtMs = Date.parse(value.occurred_at)
	if (!Number.isFinite(occurredAtMs) || new Date(occurredAtMs).toISOString() !== value.occurred_at) {
		return { index, eventId, reason: 'invalid_event' }
	}
	const canonicalEventId = value.event_id.toLowerCase()
	return {
		index,
		eventId: value.event_id,
		event: {
			schemaVersion: 1,
			eventId: canonicalEventId,
			sourceInstance: value.source_instance_id.toLowerCase(),
			sourceSequence: value.source_sequence as number,
			sessionId: value.session_id.toLowerCase(),
			kind: value.kind,
			occurredAt: value.occurred_at,
			occurredAtMs,
			...(value.monotonic_duration_ms === undefined
				? {}
				: { monotonicDurationMs: value.monotonic_duration_ms as number }),
		},
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
