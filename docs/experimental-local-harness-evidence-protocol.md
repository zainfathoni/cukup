# Experimental local Harness evidence protocol

**Status:** explicitly experimental message contract for local conformance work. It is not the deployed cloud v1/v2 API, a transport endpoint, an SDK compatibility promise, or official support for any Harness. Compatibility and support are unstable until three real Harness integrations and weak-capability/recovery validation pass the roadmap gate. The deployed contract in [service-api.md](service-api.md) is unchanged.

This specification implements the Stage 3 contract boundary accepted in [ADR 0007](adr/0007-generic-harness-evidence-boundary.md). Examples and fixtures are synthetic and generic. They do not assume the unmerged Tycho fork or revive the superseded ownership, runtime, provisional-duration, or crash-cap decisions in ADR 0006.

## Ownership and negotiation

Before sending evidence, a collector offers the exact closed negotiation object:

```json
{
  "protocol": "cukup.experimental.harness-evidence",
  "supported_versions": [1],
  "collector_instance_id": "10a00000-0000-4000-8000-000000000001",
  "capabilities": ["engagement.submission"]
}
```

`supported_versions` is a non-empty, duplicate-free array of positive integers. The receiver selects the greatest version that appears in both lists. Version 1 is the only version in this specification. A successful closed response is `{"protocol":"cukup.experimental.harness-evidence","selected_version":1}`. With no intersection, the response is `{"protocol":"cukup.experimental.harness-evidence","unsupported_versions":true,"supported_versions":[1]}`; no evidence is inspected or accepted. Malformed offers fail negotiation. An evidence envelope repeats the selected version so a stale or misrouted message fails closed.

The collector creates `collector_instance_id`, every `evidence_id`, and every `segment_id` as independently random RFC 4122 UUIDv4 values, stable across idempotent retry and revealing no native or cloud identity. Cukup core creates cloud identities, source sequence/outbox records, and any future cloud wire events. Collectors never construct deployed v1/v2 or future cloud events.

Capabilities are a closed, duplicate-free set:

- `engagement.composition`, `engagement.submission`, `engagement.follow_up`, `engagement.approval`, `engagement.takeover`;
- `execution.segments`;
- optional interaction-specific recovery: `recovery.engagement.composition`, `recovery.engagement.submission`, `recovery.engagement.follow_up`, `recovery.engagement.approval`, or `recovery.engagement.takeover`;
- optional endpoint-specific execution recovery: `recovery.execution_start.native`, `recovery.execution_start.current_observation`, and `recovery.execution_end.native`;
- `process.lifecycle`, which discloses lifecycle observation but authorizes no evidence family.

An envelope must contain at least one capability. Each recovery capability requires its matching base interaction capability or `execution.segments`; an orphan recovery declaration makes the envelope invalid. Evidence not authorized by its declared capability is rejected. Declarations describe coverage, not metric semantics. Every base engagement or execution capability is live-capable; absence of its matching recovery capability explicitly means live-only recovery coverage for that kind or endpoint. Recovery declarations do not imply one another. This can represent, for example, live-only composition with replayable submissions, recoverable starts with no historical ends, or observation-time recovery of currently running execution without historical start replay.

A rich collector may declare every defensible interaction, execution, and corresponding recovery capability. A partial collector declares only what it can establish. A process-lifecycle-only collector can submit an empty envelope, but process lifetime is never accepted as engagement or continuous execution. If that collector independently observes a human submission, that engagement may be accepted while its execution coverage remains unavailable. Products must retain the full declaration so limitations are visible; missing evidence is not zero.

The envelope capability set must exactly equal the set accepted during negotiation. Capability changes require a new negotiation; a collector must not opportunistically add a capability to authorize one record. The Stage 3 validator checks the closed declaration and record-to-capability relationship. Session continuity and enforcement against the negotiated snapshot belong to the Stage 4 transport receiver.

## Closed version 1 envelope

```json
{
  "protocol": "cukup.experimental.harness-evidence",
  "protocol_version": 1,
  "collector_instance_id": "10a00000-0000-4000-8000-000000000001",
  "capabilities": ["engagement.submission"],
  "evidence": []
}
```

All objects in this document are closed. Unknown fields are rejected, never ignored or retained for debugging. Arrays preserve delivery order. Batch size, framing, authentication, connection lifetime, and acknowledgement transport are Stage 4 decisions.

### Timing and occurrence provenance

Every evidence record has:

```json
"timing": {
  "wall_time": "2026-09-10T02:00:00.000Z",
  "provenance": "native_occurrence",
  "precision_ms": 1
}
```

`wall_time` is a real UTC RFC 3339 timestamp with exactly three fractional digits. `precision_ms` is an integer from 1 through 60,000 and states the source resolution; it does not widen or repair an interval. `native_occurrence` means a supported native fact carries the occurrence or endpoint time. `collector_observation` means the record occurred no earlier than the collector observed a currently true condition or live transition; it must never be backdated to an inferred native start.

The receiver compares wall time with its receipt clock and rejects timestamps over ten minutes in the future. Historical timestamps are allowed for replay. It never shifts, rounds, swaps, or synthesizes timestamps. Clock-offset sampling and monotonic correlation may improve a collector, but neither creates a protocol field or permits uncertain evidence. Wall-clock subtraction is not monotonic evidence.

### Project attribution

Engagement records and execution starts contain exactly one attribution reference:

```json
{"kind":"cukup_project","project_id":"20a00000-0000-4000-8000-000000000001","basis":"approved_mapping"}
```

or

```json
{"kind":"unassigned","reason":"absent"}
```

`project_id` is a path-free Cukup Project UUID selected through an `approved_mapping` or `explicit_binding`. Absence and ambiguity must be represented as `unassigned` with the matching reason. Names, normalized names, slugs, paths, repositories, prompts, and native metadata never infer a binding. The receiver snapshots the resolved attribution immutably at engagement receipt or execution start. An execution end inherits its start snapshot and therefore carries no attribution field. Later mapping changes affect only later evidence and never overwrite accepted facts or backfill Unassigned evidence.

A future collector may refresh a changed native display name for subsequent activity without approval; that is not a cross-Harness mapping change. Rename refresh and presentation are not implemented by this slice, and no historical rewrite is promised.

### Engagement evidence

```json
{
  "family": "engagement",
  "evidence_id": "30a00000-0000-4000-8000-000000000001",
  "interaction": "submission",
  "origin": "human",
  "recovered": false,
  "timing": {
    "wall_time": "2026-09-10T02:00:00.000Z",
    "provenance": "collector_observation",
    "precision_ms": 1
  },
  "project_attribution": {"kind":"unassigned","reason":"absent"}
}
```

The closed interactions are `composition`, `submission`, `follow_up`, `approval`, and `takeover`. `origin` has the single valid value `human`. Unknown, automatic, scheduled, or inferred origin is rejected and creates no Working Time evidence. Process activity, generated output, completion, and waiting are not interactions. Recovered engagement requires a defensible `native_occurrence` timestamp and the recovery capability for that exact interaction; replayable submission cannot authorize recovered composition. Observing old state now does not prove when a human interacted.

### Execution evidence

Execution is a sequence of independently defensible segments, each opened and closed by separate immutable records:

```json
{
  "family": "execution_start",
  "evidence_id": "40a00000-0000-4000-8000-000000000001",
  "segment_id": "50a00000-0000-4000-8000-000000000001",
  "recovered": false,
  "timing": {
    "wall_time": "2026-09-10T02:00:00.000Z",
    "provenance": "native_occurrence",
    "precision_ms": 1
  },
  "project_attribution": {"kind":"unassigned","reason":"absent"}
}
```

An `execution_end` has the same fields except it omits `project_attribution` and names `family: "execution_end"`. It refers to an accepted start by `segment_id`; its time must be at or after the start. An accepted start without an end is pending and contributes no duration. Only a valid end closes it. There is no duration, heartbeat, process-lifetime, pause, crash-cap, last-seen, or synthetic-end field.

Explicit waits for human input are excluded by closing the executing segment at the defensible wait boundary and opening a new segment only when execution defensibly resumes. If either boundary is unavailable, the collector must leave evidence pending or omit uncertain execution rather than span the wait. Run creation/finalization and process start/exit do not establish these segment boundaries.

Recovery preserves an original `native_occurrence` endpoint only with the corresponding `recovery.execution_start.native` or `recovery.execution_end.native` declaration. Without a defensible native start, `recovery.execution_start.current_observation` separately permits a recovered currently executing segment to start at `collector_observation` and remain pending; it implies neither historical start replay nor end recovery. A recovered end cannot use observation/receipt time for an earlier missing endpoint and is rejected; the segment remains unresolved. No recovery capability implies another, and no restart, disappearance, timeout, or crash grants a synthetic end.

## Binding, privacy, and outcomes

The protocol contains no executor or machine field. Stage 4 must authenticate a collector at the actual execution site and bind accepted engagement at receipt and execution at segment start to the receiver-controlled random execution-site identity. A collector querying another machine must be rejected, not attributed locally. Cross-host collection requires a separate approved design.

Protocol values must never expose prompts, drafts, output, transcripts, commands, paths, repositories/remotes, credentials, host/user details, native IDs/routes/cursors/project keys, raw payloads, model/provider details, or arbitrary metadata. Native correlation and timestamp interpretation stay collector-local. The receiver may log only fixed outcome/reason codes, protocol version, counts, and receiver-owned random identities. It must not log raw envelopes, values, rejected fields, authentication material, or native diagnostics. Closed validation limits accidental leakage; it does not sandbox a malicious collector.

For each record in a valid supported envelope, logical outcomes are:

- `accepted`: a new valid immutable fact;
- `duplicate`: the same `evidence_id` and structurally identical record already exists; the Stage 3 fixtures exercise exact replay and later closure only within one ephemeral conformance state;
- `conflict`: an accepted `evidence_id` is reused with different content, a `segment_id` has a different start, or a segment has a different end; accepted facts remain unchanged;
- `rejected`: closed-schema, privacy, capability, identity, timing, or ordering failure; no partial repair occurs;
- `unsupported_version`: an envelope-level outcome with no `evidence_id`; version negotiation failed before evidence inspection.

Malformed or unknown-field supported-version envelopes receive one fixed envelope-level `rejected` outcome without an `evidence_id`; raw values are not reflected or logged. Within a valid envelope, records are evaluated in order, so a start may precede its end. Rejection never reserves an identity. Durable persist-before-acknowledgement, atomic batch behavior, retention, retry policy, storage exhaustion, sanitized spooling, and restart implementation are explicitly deferred to Stage 4. Stage 4 must verify that exact replay remains `duplicate` and a defensible later end can close a pre-restart start after persisted state is reloaded; Stage 3 does not implement or test either behavior across restart. Conflict must never overwrite accepted evidence, and measurement failure must never indefinitely block Harness work.

The executable parser in [`experimental/local-harness-evidence.ts`](../experimental/local-harness-evidence.ts) and credential-free fixtures define Stage 3 conformance only. They implement no listener, persistence, outbox, cloud upload, accounting, aggregation, support claim, or deployed route.
