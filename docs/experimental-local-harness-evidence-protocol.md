# Experimental local Harness evidence protocol

**Status:** explicitly experimental message and loopback transport contract for local conformance work. It is not the deployed cloud v1/v2 API, a deployed receiver or daemon, an SDK compatibility promise, or official support for any Harness. Compatibility and support are unstable until three real Harness integrations and weak-capability/recovery validation pass the roadmap gate. The deployed contract in [service-api.md](service-api.md) is unchanged.

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

The envelope capability set must exactly equal the set accepted during negotiation. Capability changes require a new negotiation; a collector must not opportunistically add a capability to authorize one record. The Stage 3 validator checks the closed declaration and record-to-capability relationship. The Stage 4A durable core persists and enforces that negotiated snapshot; transport session continuity remains deferred.

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

## Stage 4A durable receiver core

The transport-independent core in [`experimental/local-harness-evidence-receiver.ts`](../experimental/local-harness-evidence-receiver.ts) now accepts a caller-supplied, receiver-controlled random UUIDv4 execution-site identity. It permanently binds each collector instance to one execution site and persists every successful protocol-version and exact closed-capability negotiation snapshot in a dedicated SQLite database. Identical negotiation is idempotent; changed capability negotiation creates or reuses another immutable snapshot without invalidating prior bindings or their queued retries. Every submission must match one persisted snapshot and its local site, and a binding authorizes only an envelope with that exact version and capability set. This is an abstract authenticated-site seam only: the core does not authenticate a caller or define credentials.

The core reuses the Stage 3 closed parser and evaluates valid-envelope records in delivery order inside one SQLite transaction. Accepted closed records, their collector/version/capability/site context, receipt timestamp, and immutable attribution are durable before outcomes return. Engagement attribution is retained with its accepted record. Execution segments snapshot site and attribution at their accepted start; an accepted end closes that row without replacing the start snapshot. Pending rows have null end fields and no duration field. Exact replay and identity/segment conflicts survive close and reopen. A storage exception rolls back every accepted record and segment change from the submission and escapes as a storage failure, never as acknowledgement outcomes.

Stage 4A has no listener, socket/HTTP framing, transport authentication, daemon lifecycle, bounded collector retry or offline spool. Those delivery and installation concerns remain Stage 4B work. It also adds no cloud event, outbox, upload/retry, aggregation, Working Time, Agent Runtime calculation, dashboard, migration/cutover, deployment, stable compatibility promise, or official Harness support. Deployed v1/v2 behavior remains unchanged.

For each record in a valid supported envelope, logical outcomes are:

- `accepted`: a new valid immutable fact;
- `duplicate`: the same `evidence_id` and structurally identical record already exists; the Stage 3 fixtures exercise exact replay and later closure only within one ephemeral conformance state;
- `conflict`: an accepted `evidence_id` is reused with different content, a `segment_id` has a different start, or a segment has a different end; accepted facts remain unchanged;
- `rejected`: closed-schema, privacy, capability, identity, timing, or ordering failure; no partial repair occurs;
- `unsupported_version`: an envelope-level outcome with no `evidence_id`; version negotiation failed before evidence inspection.

Malformed or unknown-field supported-version envelopes receive one fixed envelope-level `rejected` outcome without an `evidence_id`; raw values are not reflected or logged. A record-level rejection includes its `evidence_id` only when that value is a valid UUIDv4; a missing or invalid identity is represented as the fixed empty string rather than reflected. Within a valid envelope, records are evaluated in order, so a start may precede its end. Rejection never reserves an identity. Stage 4A implements durable persist-before-outcome, atomic accepted changes within a submission, and restart-safe replay/closure in the local core. Bounded collector retry, retention, storage-exhaustion policy, and sanitized collector spooling remain deferred. Conflict never overwrites accepted evidence, and measurement failure must never indefinitely block Harness work.

The executable parser in [`experimental/local-harness-evidence.ts`](../experimental/local-harness-evidence.ts) and credential-free fixtures continue to define Stage 3 message conformance. The Stage 4A receiver adds only the dedicated local persistence described above. Neither component implements a listener, outbox, cloud upload, accounting, aggregation, support claim, or deployed route.

## Stage 4B1 experimental loopback transport

The transport-only wrapper in [`experimental/local-harness-evidence-http-server.ts`](../experimental/local-harness-evidence-http-server.ts) starts a Bun HTTP server explicitly bound to IPv4 loopback `127.0.0.1`. It uses an ephemeral port by default (`port: 0`) and reports the actual bound address and port to its programmatic caller. The caller owns and closes the `LocalHarnessEvidenceReceiver`; stopping the wrapper closes only the HTTP listener. This slice creates no endpoint or credential file, performs no endpoint discovery, and installs no daemon or background service. It does not listen on IPv6, a public interface, a Unix socket, or a deployed `/v1/*` route, and it adds no HTTPS claim.

Exactly three JSON routes exist. Authentication precedes route and method handling for all three:

| Method and path | Request | Successful closed response |
| --- | --- | --- |
| `GET /experimental/local-harness-evidence/ready` | No body. | `{"protocol":"cukup.experimental.harness-evidence","protocol_version":1,"ready":true}`. This is a side-effect-free authenticated readiness and endpoint-possession check. |
| `POST /experimental/local-harness-evidence/negotiate` | The closed negotiation offer above. | The existing negotiation response with `selected_version`, or the existing `unsupported_versions` response. |
| `POST /experimental/local-harness-evidence/evidence` | The closed versioned evidence envelope above. | `{"outcomes":[...]}`, containing the Stage 4A logical outcomes only after the receiver transaction commits. |

One server wraps one receiver and therefore one receiver-controlled execution site. The wrapper accepts no hostname, machine, executor, path, native identity, or client-provided binding. For evidence submission, it validates the envelope and resolves its exact collector, protocol version, and capability set against an immutable negotiation snapshot in the receiver database. An older snapshot remains usable after a newer capability set is negotiated and after receiver restart.

### Authentication and framing

The programmatic caller supplies a pre-provisioned receiver token. It must have the strict shape of 32 random bytes encoded as 43 characters of unpadded base64url. Every request must carry exactly `Authorization: Bearer <receiver token>`. Authentication happens before route, method, media-type, or body handling; missing and incorrect authorization both receive the same `401 {"error":"unauthorized"}`. Tokens in URLs, JSON bodies, or cookies are never credentials. The implementation does not log requests, tokens, bodies, or receiver errors. Stage 4B3A below adds generation and a secure token file around this transport; Stage 4B3B adds its validated live token-replacement seam and caller-managed rotation.

Requests must use `Content-Type: application/json` (case-insensitive, with optional media-type parameters). The maximum encoded request body is 1 MiB (1,048,576 bytes). A declared larger `Content-Length` is rejected before reading or parsing the body. Undeclared and chunked bodies are read incrementally and rejected as soon as their accumulated size exceeds that limit; the transport never buffers more than the limit for JSON parsing. Empty, malformed, invalid UTF-8, array, scalar, and null JSON bodies all receive the same fixed invalid-request response. The Bun listener explicitly disables development endpoints and port reuse. Its native body ceiling is raised to JavaScript's maximum safe integer so ordinary HTTP declarations, including those above Bun's default 128 MiB ceiling, reach authentication and the application limit; malformed HTTP or declarations outside the runtime's representable range may still receive a runtime-level failure before the application handler.

Transport errors are closed JSON objects and never reflect a route, request value, identifier, token, body, database diagnostic, or stack trace:

| Status | Body | Meaning |
| --- | --- | --- |
| 400 | `{"error":"invalid_request"}` | Invalid JSON framing or negotiation offer. |
| 401 | `{"error":"unauthorized"}` | Missing or incorrect bearer authorization. |
| 404 | `{"error":"not_found"}` | Authenticated request to an unknown path. |
| 405 | `{"error":"method_not_allowed"}` | Authenticated request using a non-POST method on a known path. |
| 409 | `{"error":"collector_binding_conflict"}` | Negotiation conflicts with the receiver-controlled execution-site binding. |
| 413 | `{"error":"request_too_large"}` | Declared or streamed body exceeds 1 MiB. |
| 415 | `{"error":"unsupported_media_type"}` | Authenticated request is not JSON. |
| 503 | `{"error":"service_unavailable"}` | Receiver persistence failed; `Retry-After: 1` is included and no outcome array is returned. |

A supported, object-shaped evidence request reaches the durable core. Its closed envelope-level or record-level result is returned with status 200. In particular, an unsupported `protocol_version` remains an envelope-level `unsupported_version` result and its evidence is not inspected. A persistence exception rolls back the Stage 4A transaction and returns only the fixed retryable 503 response, so the transport never manufactures an acknowledgement.

## Stage 4B2 collector client and sanitized spool

The programmatic collector-side client in [`experimental/local-harness-evidence-client.ts`](../experimental/local-harness-evidence-client.ts) accepts an exact `http://127.0.0.1:<port>` origin, a receiver-token provider, and an exact durable spool path. Other schemes or hosts and origins containing credentials, paths, queries, or fragments are rejected. The provider is called separately for every HTTP request and its result must have the same canonical 32-byte unpadded base64url shape as the server token, allowing a caller to supply a rotated token without storing it. Endpoint discovery and token generation, files, provisioning, and rotation remain outside this client and are owned by the caller-managed runtime below.

`enqueue` performs no network operation. It runs the Stage 3 closed v1 parser first and writes only a wholly valid envelope's canonical allowed records, immutable collector/version/capability snapshot, FIFO sequence, encoded-byte count, and fixed delivery state. Any malformed, unsupported, prohibited, uncertain, or record-invalid envelope writes nothing. The spool never stores the supplied origin, token, raw input, HTTP request or response bodies, receiver diagnostics, arbitrary metadata, or native values. Accepted records are committed before `queued` is returned. SQLite busy waits are capped at 100 ms; a busy, unavailable, or injected persistence failure produces the fixed `tracking_failed` result rather than an acknowledgement or raw database error. An exhausted configured limit instead produces the fixed `spool_full` result.

Enqueue is restart-safe under uncertain local commit outcomes. Repeating an `evidence_id` with the same canonical record and exact collector/version/capability snapshot is idempotently `queued` with zero newly added records: it consumes no additional count or byte capacity and creates no new FIFO position. Reusing an ID with changed canonical content or snapshot context returns the fixed non-diagnostic `conflict` result. Classification, capacity checks, and insertion cover the complete envelope in one transaction; any conflict rejects all otherwise-new records, and capacity is charged only for genuinely new unique records.

The default spool maximum is 10,000 unresolved records and 8 MiB of canonical record JSON. Both count and encoded payload-byte limits are checked transactionally for the complete enqueue. The new envelope is rejected as `spool_full` without eviction when either limit would be exceeded. Blocked and otherwise unresolved evidence is never automatically deleted or overwritten.

The caller explicitly invokes one `drainStep`; the client creates no loop, sleep, poller, watcher, timer-driven background task, or receiver lifecycle. One step performs at most one idempotent negotiation and one evidence POST. The default batch is at most 100 contiguous FIFO records and at most 512 KiB for the complete encoded evidence envelope, below the server's 1 MiB request ceiling. Requests have a five-second abort timeout, and response buffering is also bounded to 1 MiB. These limits and the spool limits are programmatically configurable, while every configured batch-byte limit must remain below the server ceiling. Enqueue returns fixed `rejected/batch_too_large` without writing when even that record's complete one-record envelope exceeds the configured batch limit; equality is accepted. Reopening an existing spool with a newly lowered batch limit that cannot carry an already queued delivery-eligible record fails with a fixed configuration error instead of leaving an undeliverable FIFO head that repeatedly reports `tracking_failed`. Permanently blocked records and snapshots are not delivery candidates, so they do not prevent reopen under a lower limit and remain available through privacy-safe blocked status.

Delivery is strict global FIFO. A batch contains only the oldest contiguous records with the same exact collector/version/capability snapshot; a different snapshot begins a later cycle. A blocked oldest record or snapshot prevents later records, including otherwise independent records, from silently passing it. This deliberately favors visible ordering over throughput. Each cycle renegotiates idempotently, so receiver restart does not rely on process-local session state.

Network failure, timeout, authentication failure that may be repaired by token rotation, HTTP 408/425/429/5xx, oversized or malformed response, and response loss after receiver commit retain the exact attempted records. Retry state uses the durable deterministic schedule 1 second, 5 seconds, 30 seconds, then 5 minutes capped for subsequent failures. A call before `retry_at` performs no token lookup or network request. There is no sleeping in the client.

Only the exact closed Stage 4B1 unsupported negotiation response, including `supported_versions: [1]`, durably blocks as unsupported. Empty, alternate, duplicate, expanded, or otherwise malformed successful responses are retryable and retain the queue. Collector binding conflict and non-retryable transport refusal also durably block the snapshot. For a successful evidence response, the Stage 4B1 contract requires exactly one closed record outcome for every attempted ID. Missing, duplicate, unknown, malformed, extra-field, or envelope-scoped outcomes make the entire response unusable and acknowledge nothing. In a structurally valid complete response, only matching `accepted` and `duplicate` records are deleted; matching `conflict` and `rejected` records remain with fixed visible blocked categories. A local transaction failure while applying outcomes rolls back every deletion and block update, reports only `tracking_failed`, and permits exact replay.

Close and reopen preserve FIFO records, exact negotiation snapshots, payload-byte accounting, blocked categories, retry attempt, and `retry_at`. The status API exposes only queued/blocked/payload-byte and retrying-group counts plus fixed conflict, rejection, unsupported, binding-conflict, and transport-refusal category counts. It exposes no evidence or project IDs, protocol payload, occurrence timestamp, token, endpoint, native value, or database diagnostic.

## Stage 4B3A programmatic runtime and provisioning

The caller-managed runtime in [`experimental/local-harness-evidence-runtime.ts`](../experimental/local-harness-evidence-runtime.ts) owns one caller-supplied exact absolute durable state directory. It provisions that directory as owner-only (`0700`) and owns fixed receiver database, execution-site identity, receiver token, runtime-ownership, and endpoint-descriptor files within it (`0600`). Existing state paths, files, ownership, types, permissions, UUIDv4 identity, and canonical 32-byte unpadded base64url token are checked without following symlinks. Provisioned identity and token values contain no newline and survive a clean stop and restart. Atomic temporary-file writes, file and directory synchronization, and rename publication prevent partial identity, token, or descriptor contents from becoming authoritative.

Starting acquires an exclusive SQLite lock in the state directory, removes stale discovery, opens the existing durable receiver with the persisted receiver-controlled execution-site identity, and starts the existing authenticated IPv4 loopback server. Only after the listener is ready does it atomically publish the closed descriptor `{"protocol":"cukup.experimental.harness-evidence","protocol_version":1,"origin":"http://127.0.0.1:<port>"}`. The descriptor contains no token, execution-site identity, state path, host/user detail, or native metadata. Discovery strictly parses that object with the Stage 4B2 client's canonical exact-origin parser, securely reads and validates the owner-only token, and calls the authenticated side-effect-free readiness route with a one-second timeout and a 512-byte response bound. It returns the endpoint only for the exact closed protocol/version readiness response. A stale descriptor naming another Cukup runtime fails because that runtime has a different token; absent, stopped, malformed, unsafe, mismatched, or unreachable endpoints produce one fixed non-diagnostic error. The discovered-client factory then constructs the existing Stage 4B2 client and reads the owner-only canonical token afresh for each delivery request.

Concurrent runtime ownership is refused. The SQLite lock is released by explicit stop and by process termination, so a later caller can restart without interpreting or trusting a PID file. Stop removes endpoint discovery before closing the listener and receiver, releases ownership, and preserves the receiver database, execution-site identity, and token. Startup failure publishes no endpoint; errors expose no supplied path, credential, native value, or storage/listener diagnostic. The caller still owns process scheduling and invokes start and stop explicitly.

Credential rotation is not part of Stage 4B3A; its settled behavior is implemented by Stage 4B3B below.

## Stage 4B3B immediate receiver-token rotation

The live caller-managed runtime exposes one explicit synchronous rotation operation. It first verifies that the authoritative owner-only token file is still canonical and matches the token serving the runtime. It then generates a different fresh canonical 32-byte base64url token, disables authentication for the publication boundary, atomically writes and synchronizes the replacement file, and updates the live server authentication state before returning. There is no grace period, old/new overlap, retained previous-token file, timer, watcher, or background rotation loop. A successful return means the old token is immediately invalid, the new token passes readiness and delivery, and restart reads only the new token. The operation returns no token or other value.

The temporary disabled state makes both old and new credentials receive the same fixed 401 at the cutover boundary. An in-flight request may complete under the state in which it was authenticated or receive that indistinguishable 401. The Stage 4B2 client obtains the file token separately for every request; any boundary authentication failure retains the exact queued evidence and negotiation snapshot under its existing durable retry schedule, without reconstructing its spool or endpoint.

Validation precedes runtime mutation. If replacement fails before rename, the unchanged authoritative old token is restored as the live authentication state. If rename or directory synchronization has an uncertain outcome, the runtime rereads the authoritative file and serves exactly its canonical old or new value before throwing the fixed non-diagnostic runtime error. If the file is malformed, unsafe, externally inconsistent, or cannot be reconciled, authentication remains disabled and endpoint discovery is withdrawn. Thus a discoverable runtime is never left authenticating a token inconsistent with its authoritative file. Rotation does not change receiver evidence, execution-site identity, runtime ownership, endpoint origin, collector spool, or deployed v1/v2 behavior, and neither token is returned, reflected, or logged.

### Remaining Stage 4 work

Stage 4B3A/B remains an undeployed programmatic runtime around the experimental client and transport. Credential-rotation semantics are now settled and implemented. Later independently reviewed work must cover daemon installation and removal, initial macOS/Linux and Amp-orb packaging verification, and real Harness collectors. These stages add no installer, daemon command, autonomous background loop, or operating-system service packaging. No macOS, Linux, Amp-orb, Tycho, or other Harness support is claimed by this runtime, client, or transport.

Cloud protocol/outbox/upload, new metric accounting or aggregation, dashboard work, migration and cutover, deployment, and stable compatibility remain Stage 5 or later gates. Cukup production remains Amp-only v1/v2 with its historical semantics; this experimental server is not deployed and creates no new authoritative metric.
