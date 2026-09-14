# Stage 5J: bounded current synchronization observations

This is a documentation-only contract for a future physical-bearer route. It implements and enables
nothing. [Stage 5G](stage-5g-shadow-coverage-contract.md) supplies the closed synchronization vocabulary;
[Stage 5I](stage-5i-shadow-disclosures.md) still returns `unknown` unconditionally today.

## One latest snapshot, no observation history

Keep one revision-safe latest snapshot per already bound collector/site, not an append-only history.
Synchronization is operational state, not evidence, a capability declaration, or a loss fact. Historical
spool snapshots are unnecessary for current reporting and reveal activity patterns. This explicitly
narrows Stage 5G's original append-only observation assumption; evidence/coverage immutability is
unchanged. Replacing a snapshot is atomic, never an in-place edit of the same observation identity.
No observation IDs, receipts, or payloads accumulate in an audit/history table.

The durable identity is `(collector_instance_id, observation_sequence)`. The sequence is an integer
1–9007199254740991, monotonically allocated in the existing owner-exclusive local spool, independently
of evidence/coverage source sequence. No new UUID, epoch, server-issued lease, shared fact ordering,
or per-project status is needed. Gaps are allowed. One pending observation replaces an older pending
observation; it is never inserted into the evidence FIFO. Neither stream waits for the other.

Only collectors already bound by accepted evidence/coverage can upload status. An unknown collector
receives `collector_not_registered`; observations cannot create bindings or unlimited status-only
collector rows. This deliberately leaves a fresh, never-accepted collector `unknown`, even when its
local spool is empty or blocked. Once registered, status remains usable even if the evidence FIFO is
blocked. Never manufacture an evidence fact just to register a collector.

## Future closed physical wire contract

`POST /v1/shadow-synchronization` on the existing API hostname requires HTTPS, no query parameters,
and an active physical bearer with its pre-bound Executor Profile. The service derives execution site
from authentication, as [Stage 5B](stage-5b-shadow-ingestion-api.md) does. No profile write occurs here.
OIDC receives `physical_bearer_required`; OIDC/Amp-orb execution-site design remains deferred.

Require `Content-Type: application/json` (optional UTF-8 charset only), no Content-Encoding, and at
most 1024 raw UTF-8 body bytes, enforced while reading, independent of Content-Length. Reject invalid
UTF-8, duplicate JSON keys, trailing data, non-object roots, unknown fields, and non-finite/fractional
integers. There is exactly one observation, no envelope/batch extension or free metadata:

```json
{
  "protocol_version": 1,
  "collector_instance_id": "11111111-1111-4111-8111-111111111111",
  "observation_sequence": 23,
  "observed_at_ms": 1800000000000,
  "state": "retrying",
  "records": 3,
  "bytes": 740,
  "oldest_queued_at_ms": 1799999900000
}
```

All eight fields are required. Collector UUIDv4 uses the existing exact case-sensitive convention.
`state` is exactly `clear`, `queued`, `retrying`, or `blocked`; `unknown` is absence of usable knowledge,
not an uploaded state. `records` is 0–10000; `bytes` is 0–8388608. Each is independently saturated:
the maximum means **at least** that many, all smaller values are exact. Local limits may differ from
these disclosure limits. Never truncate/wrap an overflowing sequence or a malformed count.

Times are integer UTC epoch milliseconds in 0–253402300799999. `oldest_queued_at_ms` is null iff
`records` is zero; otherwise it is the minimum original evidence occurrence (`timing.wall_time`)
among all retained FIFO records, including blocked/retrying rows, not the head's occurrence, enqueue
time, retry time, or a collection watermark. Recovered evidence uses its original occurrence. Any
future spool fact family must define its occurrence mapping before participating. The client must
read this internally without exposing payloads or identifiers. Old occurrence has no age cutoff;
it must be no more than 600000 ms after `observed_at_ms`, matching evidence's future-skew tolerance.
It need not precede observation time and must never be displayed as negative backlog age.

Take one consistent spool snapshot: total records = local `queued + blocked` (retrying is a subset
of queued, not an extra count); bytes = Stage 5C stored `payloadBytes`, not SQLite file size. Map in
this order: zero total → `clear`; any blocked → `blocked`; any retrying → `retrying`; otherwise
`queued`. Persistent retry markers count even when retry is due or in flight. An empty spool requires
zero bytes and null oldest; any nonempty state requires positive records and bytes and nonnull oldest.
Read/corruption failures produce no candidate, never `clear`. Counts describe only retained records;
they say nothing about rejected collection, pending execution, or irreversible loss.

Version 1 is the only supported version. Apply these classifications before binding/order checks:

| Failure | Exact outcome |
| --- | --- |
| Invalid UTF-8, JSON syntax/trailing data, or duplicate keys | 400 `{"error":"invalid_json"}` |
| Parsed non-object root; missing/extra field; wrong type, numeric range, or state/count/oldest consistency | 200 `{"status":"rejected","reason":"invalid_record"}` |
| Otherwise valid shape, but integer protocol_version in 1–9007199254740991 other than 1 | 200 `{"status":"rejected","reason":"unsupported_version"}` |

Validate every field's shape/range and cross-field consistency before unsupported-version selection;
a malformed version is `invalid_record`. `clear` requires zero records; every other state requires
positive records. The server cannot verify blocked/retrying precedence from aggregates and treats
that state as a client claim, not independently observed queue contents.

Success HTTP 200 has exactly `{"status":"accepted"}` or `{"status":"duplicate"}`. Semantic rejection
HTTP 200 has exactly `{"status":"rejected","reason":R}`, where R is one of `invalid_record`,
`unsupported_version`, `collector_not_registered`, `identity_conflict`, `stale_observation`,
`invalid_observation_time`. No identifiers, reflected values, timestamps, or arbitrary strings return.
Other responses are exactly `{"error":E}` with this closed mapping:

| HTTP | E |
| --- | --- |
| 400 | `secure_transport_required`, `invalid_request` (query), `invalid_json` |
| 401 | `unauthorized` (missing, invalid, expired, or revoked bearer) |
| 403 | `physical_bearer_required`, `executor_profile_required` |
| 404 | `not_found` (wrong API host/path) |
| 405 | `method_not_allowed` (Allow: POST) |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` (content type/encoding) |
| 429 | `rate_limited` |
| 500 | `internal_error` |
| 503 | `temporarily_unavailable` |

All JSON responses use application/json and Cache-Control: no-store, with no other body fields;
401 carries WWW-Authenticate: Bearer. Authentication/profile checks precede body parsing. A future
implementation must test these route-specific errors rather than leak generic exception names.

## Ordering, freshness, persistence, and clocks

Validation order is framing/authentication, closed shape/version/numeric constraints, existing
collector/site binding, then an atomic latest-row comparison. Wrong site is `identity_conflict`.
Lower sequence is `stale_observation` regardless of body equality or age. Equal sequence and equal
normalized field values is `duplicate` (JSON key order/whitespace do not matter); equal sequence with
different otherwise-valid content is `identity_conflict`. Only a strictly greater sequence, or a first
snapshot, reaches the new-observation freshness check. Retrying a superseded observation returns
`stale_observation`, not `duplicate`; no history is required to distinguish it.

Let R be trusted service UTC epoch milliseconds sampled inside the acceptance transaction, O the
client snapshot time. Require **R − 60000 ≤ O ≤ R + 10000**, inclusive; otherwise reject
`invalid_observation_time` without advancing order. The accepted observation's time is O, a bounded
client claim, not server proof of when the spool changed. Store R separately as server receipt time.
Expiry is **min(R + 120000, O + 120000)**. Freshness for read time N is exactly
**R ≤ N < expiry**. At expiry, missing row, failed read, invalid server clock, or N < R, return
`unknown`. Never use evidence receipts, source continuity, silence, pending endpoints, or local
diagnostics as substitutes. A delayed first arrival can be accepted only within the 60-second age
bound and gets reduced remaining life. An exact duplicate never updates R, expiry, or any content;
even a long-delayed duplicate is acknowledged but cannot refresh status.

The service requires a trustworthy UTC clock; comparisons use integer milliseconds, not local civil
time. Detected backward jumps invalidate current synchronization reads for that process and reject
new observations with 503 until clock health is restored. Clock-health checks must also run at service
startup; if clock trust cannot be established, fail closed. Undetected clock errors and dishonest
authenticated client claims cannot be proven away by this protocol; the bounded observation is not
a completeness guarantee. Client wall-clock error outside the allowed window yields unknown after
expiry; never repair evidence timestamps or use server response time as a fabricated snapshot time.

Persist-before-acknowledgement atomically replaces the latest row only if its sequence is greater;
transaction serialization must include collector/site checks and avoid stale concurrent overwrite.
Storage failure rolls back everything and returns 500/503, never `accepted`. The row contains only
the normalized eight fields plus R and expiry; site comes from the existing immutable binding.
Retain that one row, including its sequence and content, for the lifetime of the existing collector
binding, even after expiry, to preserve duplicate/conflict checks and prevent replay resurrection.
No TTL deletion, historical snapshots, or backfill. Cardinality is at most one row per existing
collector, not a global fixed collector cap; per-row data is bounded by the contract. Backups inherit
the existing database policy; this is not a promise to erase superseded bytes from backups. Future
collector deletion must delete its snapshot with its binding and must separately solve identity reuse;
this slice adds no deletion/retention policy for accepted evidence or coverage.

## Local persistence and failure isolation

Persist the observation counter and at most one exact pending candidate atomically before sending.
Counter state and collector identity survive restart alongside the spool; ack loss retries the exact
candidate or replaces it with a newly sampled higher revision. Never change fields at the same
sequence. On restart an old pending candidate may be retried, but fresh sampling is preferred; no
sampling means no freshness renewal. First adoption on a recognized pre-synchronization spool schema
atomically marks synchronization initialized and initializes its counter so the first observation is
1, preserving collector identity, evidence sequence, and every queued record. This is a one-time
schema transition, not an inference from an absent counter; exact migration/DDL remains deferred.
Once initialized, a missing/corrupt counter with retained collector state disables
status upload rather than resetting it. At sequence exhaustion disable status upload; evidence still
drains. A fresh spool identity starts at 1 and remains a separate lane; never relabel retained evidence
or merge collector counters. Restoring an old spool backup may get stale rejections; stop status upload
on that rejection and require counter recovery from retained newer local state, not guessed increments
or a server high-water response. Evidence recovery remains its separate existing contract.

Transport uses an independent, at-most-one in-flight request, no redirects, 1024-byte response cap,
and 5000 ms total request deadline. It rereads the physical bearer before each attempt. Bound status
sampling/attempts to at most one per 60000 ms per spool (monotonic elapsed time); restart begins a new
60000 ms wait. No background uploader is enabled here. Future invocation is optional and outside AI
hook critical paths; status failure neither blocks evidence delivery nor waits indefinitely for work.
Use a short snapshot transaction with no network inside, and abort status snapshot acquisition after
100 ms of lock wait. Never acquire a lock across evidence transport.

Timeout, response loss, 401, 429, 5xx, or invalid/oversized responses leave at most the pending candidate;
retry no sooner than the next bounded invocation, preferably replacing with a fresh sample. Rejection
for invalid time permits a fresh sample after clock repair; unregistered collector permits retry after
normal evidence acceptance. Valid closed HTTP 400, 403, 404, 405, 413, and 415 responses and other
semantic rejections suspend status until local repair or deliberate restart, retaining its counter
and at most one pending candidate. Accepted/duplicate clears only the matching pending candidate,
never a newer replacement. All failures leave evidence delivery unaffected;
they never become evidence FIFO blockers. Restart alone must not reset the durable counter or cure
counter corruption. Rotation within the bearer lineage preserves site and observation identity;
an exact retry using the replacement can return duplicate. Old/revoked credentials receive 401 before
any mutation, including duplicate lookup. Authorization must be revalidated atomically with acceptance
against rotation/revocation, so a revocation committed first prevents acceptance. Revocation does not
rewrite the last observation: it ages normally to unknown within at most 120 seconds. Another lineage
cannot take over the collector. No token, hostname, or profile is persisted in the local observation.

Logging allows only fixed route/event, HTTP status, and closed outcome/error category; no request or
response bodies, exception names/messages/stacks, collector IDs, times/counts, bearer, hostname, path,
project/evidence IDs, or free text. Route labels are fixed constants, not caller URLs. Normal service
metrics may count fixed outcomes; no per-collector labels or observation history through logs.

## Future ownership and acceptance gate

- Stage 5C owns consistent sanitized snapshot extraction, counter/pending durability, and independent
  delivery scheduling; Stage 5D's local-only command remains unchanged.
- Transport owns framing, credential reload, timeouts, and fixed failure handling. Service auth owns
  physical site binding; persistence owns atomic revision comparison and server-clock expiry.
- A later Stage 5I integration consumes a separate latest-snapshot input with explicit trusted read
  time. Synchronization is current collector/site context, not clipped historical occurrence coverage.
  It must include registered status-only lanes absent from the report's evidence/coverage selection,
  preserve site isolation, and never attribute spool counts to projects or add them to metric totals.
- Availability/dashboard owners keep current sync expiry independent of cached panel availability:
  stale panels cannot retain `clear` beyond expiry. A failed current sync read is `unknown`, not the
  last cached positive state. `clear` means only an empty reporting spool at O, never complete
  collection, no loss, no pending execution, no work, or permanent current status.

Encode these asymmetric cases as executable tests in the later owning implementation; these are
acceptance vectors, not a claim of runtime tests in this documentation slice. Use a fake clock and
disposable persistence; assert stored rows, response bodies, and independent metric/evidence results.

| Case | Required result |
| --- | --- |
| queued=2, blocked=1, retrying=2, bytes=740 | records=3, state=blocked, not retrying or records=5 |
| queued=3, blocked=0, retrying=1; then empty | retrying; then clear with records=bytes=0, oldest=null |
| head occurs at 90000; later FIFO record at 70000 | oldest=70000, not head time; 10001 records saturates to 10000 |
| bytes=8388607 then 8388609 | exact 8388607 then saturated 8388608; raw uploaded 8388609 rejected |
| seq 8 accepted, reply lost; retry 8; then accept 10 and deliver 9 | duplicate leaves receipt/expiry intact; 9 stale, latest remains 10 |
| seq 10 same fields reordered; changed count at 10 | duplicate; identity_conflict, no mutation |
| R=1000000, O=940000 / 939999 / 1010000 / 1010001 | accepted / invalid time / accepted / invalid time |
| R=1000000, O=940000; N=1059999 / 1060000 | fresh / unknown; duplicate at 1050000 cannot extend expiry |
| O=1010000, R=1000000; N=1120000 or N=999999 | unknown at receipt-based expiry or backward read |
| restart with pending 8; rotation; revoked old bearer | same 8 duplicate via replacement; old token 401, no mutation |
| pre-synchronization spool with evidence seq 42; initialized spool missing counter | first status seq 1, evidence/identity unchanged; missing counter disables only status |
| parsed array; duplicate key; version 2 otherwise valid; version 1.5 | 200 rejected/invalid_record; 400 invalid_json; 200 rejected/unsupported_version; 200 rejected/invalid_record |
| valid 403 executor_profile_required; 415 unsupported_media_type; 401 unauthorized | first two suspend status with counter retained; 401 permits next bounded retry; evidence unaffected |
| fresh collector B at A's site, then wrong-site use of A | B unknown/unregistered until evidence accepted; A conflicts |
| status seq 900; evidence/coverage source seq 12 then 13 | source 13 accepted normally; blocked evidence does not block registered status |
| status transaction fails; response >1024 bytes; request=1025 bytes | no ack/mutation on transaction failure; bounded client failure; 413 before parse |
| unknown key/path/token, duplicate key, fractional count, inconsistent zero | reject without raw logging or retained candidate on server |
| expired clear plus recent evidence, known loss, pending start, ready panel | sync unknown; all other dimensions and legacy v1/v2/totals unchanged |
| concurrent seq 14 and 15; retry replaced 14 after expiry | latest 15 regardless of commit order; 14 cannot resurrect or refresh |

Exact DDL/migration, module APIs, implementations, upload activation, report/public API integration,
availability/cache delivery, dashboard layout, OIDC/Amp-orb sites, capability/loss changes, aggregation,
target comparison, cutover selection/activation, historical backfill, support claims, production
settings/access, deployment, package/workflow/Docker changes, and legacy reinterpretation remain
outside this slice. These decisions are not authorization to implement or roll out the protocol.

Documentation paths are publication-neutral under the current service workflow. Prerequisite service
publication and schema-7 constraints remain separate. No runtime, schema, API, dashboard, or legacy
behavior changes; no push, deployment, production mutation, or shared access change is authorized.
