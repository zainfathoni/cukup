# Candidate Tycho collector guidance

**Status:** prospective integration guidance under [ADR 0007](adr/0007-generic-harness-evidence-boundary.md), not an accepted upstream API contract or an implemented adapter. ADR 0006's Tycho-specific design is superseded. Unmerged fork work is evidence for investigation, not a dependency or guarantee.

## Boundary and ownership

A Tycho collector may be maintained by Cukup, Tycho, or a third party, and may be embedded or separate. It translates supported native facts into the experimental generic local evidence protocol. Cukup owns validation, durable acknowledgement, accounting, privacy identities, and cloud delivery; Tycho need not implement a Cukup outbox in Ruby.

Native run IDs, project keys, API calls, pagination, reconciliation checkpoints, and timestamp interpretation remain collector-local. The generic core must not require Tycho's run model or assume a particular polling cadence. Each proposed integration must reverify current supported upstream surfaces and their timing, privacy, and recovery guarantees before claiming support.

## Evidence must justify the metric

- **Working Time:** only supported evidence of explicit human composition, submission, follow-up, approval, or takeover opens or renews a 15-minute Engagement Window. Submission/enqueue alone does not establish human origin. Scheduled starts, automatic orchestration/resume, liveness, output, finalization, and waiting do not create Working Time. Unavailable composition or human-origin evidence is disclosed, not inferred.
- **Agent Runtime:** only defensible closed execution intervals count, excluding explicit waiting for human input. A managed run's start and finalization do not automatically establish continuous execution. Finalization time is not necessarily process exit time. Observable unfinished execution may be pending but contributes no provisional duration; missing endpoints remain unresolved without crash caps or synthetic ends.
- **Coverage:** declare each supported observation, endpoint, replay, and liveness capability separately. Missing observations bound the richer-observation window metric, not actual attention. Weak runtime evidence does not invalidate independently supported human observations.

## Candidate reads and recovery

Open runs naturally form a current snapshot; historical interactions and finalized records may support windowed or cursor-based reads. Do not require all native reads to be windowed. These are collector choices, not generic protocol concepts.

Before relying on a surface, establish stable local deduplication identity, timestamp meaning and precision, retention, pagination, and how late changes are discovered. A query filtered only by start time can miss a much older run finalized today. A disappeared snapshot entry is not a terminal timestamp, and receipt time cannot replace a missing native endpoint.

Hooks may serve as low-latency notifications. Do not forward raw payloads; they may contain paths, session identifiers, summaries, or output. A live-only collector is allowed with honest loss/recovery disclosure. Claim replay only when a supported durable surface actually supplies it. Raw private files are not a default production integration contract; a proposed reliance on them requires a separate compatibility and privacy review.

Wall-clock and monotonic measurements are distinct. Preserve supported occurrence times and their precision; do not populate a monotonic-duration field with wall-clock subtraction or use polling/finalization time as execution completion. Exact protocol timestamp encoding belongs to the experimental protocol review, not this candidate guide.

## Attribution and privacy

Native identities remain local and map to stable Cukup Projects through approved mappings. Matching normalized names alone never merges Tycho and another harness's projects. An explicit non-path launch/session binding is allowed; absent or ambiguous binding remains Unassigned. Native renames refresh future activity automatically, without rename approvals or historical backfilling. Occasional stale labels are acceptable.

Deploy at the execution site with its authenticated executor binding. Querying another machine must never attribute its work to the collector's machine; cross-host collection needs a separate design. Initial first-party scope is macOS/Linux physical machines and Amp orbs, not every environment where Tycho can run.

Prompts, output, drafts, commands, paths, repository metadata, credentials, native run/session/project IDs, model/provider details, and arbitrary metadata do not enter generic evidence messages or cloud events. Use sanitized local mappings and diagnostics only. Closed-schema validation does not sandbox a malicious collector; installing one remains a trust decision.

## Implementation gate

A scoped collector proposal must identify the supported upstream revision and surfaces, ownership/package, capability matrix, and credential-free fixtures. Tests must exercise duplicate/conflicting evidence, restart, offline delivery, late finalization, missing endpoints, waiting, human versus automatic origin, attribution, and prohibited fields. Loss limitations must be visible rather than papered over by invented evidence.

Follow the [generic initiative stages](../ROADMAP.md#generic-harness-adapter-initiative). A Tycho collector is not a prerequisite for the behavior-preserving Amp extraction, and this guide does not authorize resuming the prior Tycho-specific implementation.
