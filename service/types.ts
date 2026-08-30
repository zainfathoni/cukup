export type EventKind = 'agent.start' | 'agent.end'

export type WorkEvent = {
	schemaVersion: 1
	eventId: string
	sourceInstance: string
	sourceSequence: number
	sessionId: string
	kind: EventKind
	occurredAt: string
	occurredAtMs: number
	monotonicDurationMs?: number
}

export type StoredWorkEvent = WorkEvent & {
	receivedAt: string
	receivedAtMs: number
}

export type Principal =
	| { kind: 'bearer'; tokenId: string }
	| { kind: 'oidc' }

export type IngestOutcome =
	| { outcome: 'accepted'; receivedAt: string }
	| { outcome: 'duplicate'; receivedAt: string }
	| {
			outcome: 'conflicted'
			reason: 'event_id_conflict' | 'source_sequence_conflict'
	  }
	| {
			outcome: 'rejected'
			reason: 'clock_skew' | 'source_not_authorized' | 'source_sequence_order'
	  }

export type WorkStatus = 'UNDER' | 'COMPLETE' | 'OVER'

export type SummaryPeriod = {
	status: WorkStatus
	worked_minutes: number
	target_minutes: number
	difference_minutes: number
}

export type WorkSummary = {
	schema_version: 1
	as_of: string
	daily: SummaryPeriod
	weekly: SummaryPeriod
}
