# Stage 5H: internal coverage protocol and persistence

This slice implements only the two durable facts specified by
[Stage 5G](stage-5g-shadow-coverage-contract.md) and [ADR 0007](adr/0007-generic-harness-evidence-boundary.md).
It adds no HTTP route or payload, authentication change, upload, collector behavior, synchronization
observation, report projection, aggregation, dashboard, or runtime activation. No historical facts
are inferred or backfilled. Existing evidence envelopes, append outcomes, reads, segments, and
Stage 5E/5F measurements retain their interpretation.

## Internal closed protocol

`ServiceStore.shadow.appendCoverage(input, receivedAtMs)` accepts exactly
`{ executionSiteId, sourceSequence, envelope }`, the same internal wrapper as Stage 5A `append`.
The caller must supply an **authentication-derived execution-site UUID**, not a field extracted from
the envelope. This persistence method does not authenticate; there is no new external caller.
The site, collector, and fact IDs use the existing exact, case-sensitive UUIDv4 identity convention.
Source sequence is an integer from 1 through 9007199254740991.

The envelope has exactly these fields:

| Field | Value |
| --- | --- |
| `protocol` | `cukup.experimental.harness-evidence` |
| `protocol_version` | `1` |
| `collector_instance_id` | Collector UUIDv4 |
| `capabilities` | Exact, nonempty, duplicate-free subset of the existing closed v1 vocabulary |
| `fact` | One of the two closed objects below |

- Capability declaration: `{ family: 'capability_declaration', fact_id, effective_at }`.
  Its capability set follows the existing v1 declaration rules, including requiring the corresponding
  base capability for recovery capabilities. `effective_at` is an occurrence instant, not receipt time.
- Explicit loss: `{ family: 'irreversible_loss', fact_id, start, end, reason }`.
  Its capabilities identify exactly the affected observations; a recovery capability alone is valid
  here and does not declare the base capability lost. `reason` is exactly one of
  `storage_exhaustion`, `source_without_replay`, `abrupt_termination`, `operator_discard`, `unspecified`.

All occurrence timestamps are real UTC dates in `YYYY-MM-DDTHH:mm:ss.sssZ` form. The loss interval is
exactly **[start, end)**, with start strictly before end; adjacent and overlapping intervals are not
merged or rounded. Each occurrence endpoint may be at most ten minutes ahead of the caller's receipt
time, matching evidence clock tolerance. Old occurrences have no age cutoff. Receipt time is a valid
integer epoch millisecond and is stored separately. No receipt field is accepted in the envelope.

The sole parser remains `service/harness-evidence-protocol.ts`, with shared envelope, capability,
UUID, timestamp and canonicalization primitives. Unknown/prohibited fields at every object boundary
reject the whole candidate. Project attribution, prompt, output, path, hostname, token, response body,
metadata, native harness ID, and free-form diagnostics are not fields of either fact. Rejection
results contain only closed reasons; no rejected candidate is stored or logged. Unsupported versions
remain `unsupported_version`, including retries, as with Stage 5A.

## Immutable append and source order

Every append uses an immediate SQLite transaction, shared by both tables' checks and the insert.
The first accepted evidence or coverage fact binds the collector to one site. IDs are unique across
both shadow fact tables (not legacy IDs). An exact retry compares ID, collector, site, source sequence,
version, sorted capability set, and canonical fact; it returns `duplicate` without writing or changing
the original receipt time. Changed valid immutable content returns `identity_conflict`. Malformed
candidates return `invalid_record` and never overwrite an accepted fact.

Exact retry lookup precedes the shared collector high-water check. A new fact's source sequence must
exceed **both** tables' accepted sequences. Lower/reused source sequences return `invalid_order`,
preserving Stage 5A's outcome contract; gaps are allowed. No mutable counter or copied source ledger
can diverge from the accepted facts. Binding and fact insertion commit together before `accepted`;
database failures roll back and propagate, without payload diagnostics.

Declarations with the same collector and effective instant but different capability sets conflict.
Distinct IDs with the same effective instant and same set remain separate immutable facts, not merged
identities. A declaration applies prospectively from its effective occurrence instant until the next
effective declaration for that collector. Late declaration receipt is permitted; source order is not
occurrence order. Stored declarations never acquire mutable end times, and later declarations never
rewrite earlier facts or evidence capability snapshots. `coverageRecords()` returns raw accepted
facts in collector/source order, **not** effective intervals or an assessment; projection remains
deferred. Retaining identity preserves the lane across restart; fresh collector IDs start independent
lanes even at the same site.

Only explicit accepted loss produces a stored loss fact. Sequence gaps, missing evidence, silence,
delays, pending execution, retries, blockers, stale declarations, or failures never produce one.
Execution closure stays solely in the existing evidence segment projection and does not erase loss.

## Schema, publication, and rollback implications

Service schema **7** adds only the STRICT `shadow_coverage` table, its sequence/effective-time indexes,
and SQL UPDATE/DELETE refusal triggers. Version 6's existing schema objects and rows are unchanged;
there is no evidence-table rebuild, copied history, or inferred coverage. Migration is inside the
existing immediate transaction and advances `user_version` only after successful DDL. Versions 0–5
retain their prior upgrade steps before the additive coverage schema. Schema 7 restarts without
migration; future versions are refused. A failed migration leaves old rows, schema and version intact.
Cross-table identity/order enforcement belongs to the internal append methods under that transaction;
direct SQL insertion is not a supported ingestion API. SQL administrators and malicious in-process
code are outside this reviewed closed-schema boundary, as in Stage 5A and ADR 0007.

**Not publication- or deployment-neutral:** these `service/**` changes match the existing main-push
service publication workflow. Starting this service version migrates a database even with no coverage
caller connected. Protocol source ownership and Docker inputs stay unchanged. No package, workflow,
Docker, production setting, push, publication, deployment, or shared database operation is authorized
or performed by this slice; tests use disposable local databases.

Schema-6 and older service binaries refuse a schema-7 database. Do not lower `user_version`, drop
coverage tables, or restore an old backup over newly accepted facts to make an old binary run.
Any eventual rollback must retain accepted evidence/coverage and queued records and use schema-7
compatible ingestion, possibly pausing the faulty future collector. A pre-migration backup alone is
not a lossless rollback once new facts have been accepted. Cutover and legacy target accounting remain
separate owner decisions.

Tests cover cross-family ordering and identity, old retries, immutable receipt/occurrence and capability
snapshots, late/equal-effective declarations, site binding, fresh identity separation, UTC/half-open
endpoints and skew boundaries, closed privacy validation, no synthesized coverage, append failure,
SQL mutation refusal, exact v6 schema/row preservation, migration failure after partial DDL, restart,
and future-version refusal. Existing legacy migrations, API, aggregation, and restricted service build
tests remain required. No report-level capability/loss assessment or real collector integration is
claimed by these persistence tests.
