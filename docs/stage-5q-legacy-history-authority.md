# Stage 5Q: legacy history, backfill, and reporting authority

This documentation-only contract follows [ADR 0007](adr/0007-generic-harness-evidence-boundary.md),
[Stage 5A](stage-5a-shadow-persistence.md), and [Stage 5F](stage-5f-cutover-clipping.md).
It specifies future reporting behavior; it selects no cutover and changes no deployed behavior.
The evidence below is repository code for the deployed v1/v2 contract, not an inspection of production
data or a claim that every historical installation ran the same collector version.

**Decision: reject all legacy-to-generic evidence backfill.** No stored v1/v2 subset proves the
required generic facts. Retain legacy rows and their existing reporting semantics as their own
authority. A future explicitly approved, non-authoritative audit ledger may record reconciliation
results, but is not a migration source or new evidence store. No ledger is implemented or populated
here. A future proposal using additional independently captured evidence needs separate review;
the presence of a matching legacy turn is neither necessary nor sufficient for acceptance.

## What legacy storage actually establishes

Sources: [wire validation](../service/protocol.ts), [service storage](../service/store.ts),
[legacy adapter](../plugin/legacy-amp-adapter.ts), [local storage](../plugin/store.ts),
[synchronization](../plugin/sync.ts), [aggregation](../service/aggregation.ts), and
[dashboard attribution](../service/dashboard/report-builder.ts).

| Stored fact or invariant | Meaning and limit |
| --- | --- |
| `schema_version`, `event_id` | v1/v2 wire versions, not SQLite versions. Event UUIDv5/v7 is lowercased by the service parser. New local events use UUIDv7; old local-event migration uses a retained random namespace and UUIDv5. Neither is a generic evidence UUIDv4. |
| `source_instance`, `source_sequence` | Persisted source UUIDv4 and positive safe-integer wire order, unique together. Local event/outbox/session/allocator writes commit atomically. Source identity survives intact local state; it is not a generic collector or authenticated site attestation. |
| `session_id`, `kind` | UUIDv4/v5 turn session and `agent.start`/`agent.end`. Native thread/message IDs and end status remain local, not in service rows. The local session mapping preserves the turn's first attribution. The service groups by source plus session, not session alone. |
| `project_slug` | v1 always null; v2 optional canonical slug. Local start attribution is retained for the end. Service rejects an end with a different version/slug when an earlier stored start exists. A slug is not an immutable Cukup Project UUID or proof of approved evidence-time mapping. |
| `occurred_at`, `occurred_at_ms` | Canonical UTC wall time and parsed milliseconds. There is no stored generic timing provenance, precision, human origin, or recovered flag. Receipt time does not repair these omissions. |
| `monotonic_duration_ms` | Optional nonnegative safe integer; live adapter computes elapsed monotonic time when its in-memory start survives. Service parser permits it on either kind; aggregation uses the end's duration only. It is turn elapsed time, not proof that human-input waits were excluded. |
| `received_at`, `received_at_ms` | First service acceptance time. Immutable duplicate equality excludes receipt; exact retries return the original receipt. It is not occurrence, observation completeness, or a historical knowledge watermark. |
| `source_owners`, `auth_tokens` | Legacy source authorization: bearer token ownership, or OIDC ownership by kind with null owner ID. OIDC rows have no per-orb incarnation identity. Physical Executor Label is joined from credential metadata, not stored on each event; OIDC displays shared `amp-orb`. |
| Local tracking markers | `tracking-incomplete` and optional metadata hold first/last observed warning times and a set of reasons. Older/invalid metadata becomes null bounds with `legacy-unknown`. Acknowledgement clears them. They are not uploaded in v1/v2, are not an immutable history, and their times are not lost-work interval endpoints. |
| Local pending delivery | Outbox states are pending/conflict/rejected; accepted/duplicate acknowledgements remove queued entries. Sync clock/backoff/cache state describes delivery, not observation coverage. A pending upload is distinct from an accepted unmatched turn start. |

Legacy ingestion checks source ownership before duplicate lookup. Exact immutable retries precede
new-row sequence and future-clock checks. Reusing an ID or source sequence with changed content
conflicts. Gaps are allowed; new rows below high-water are rejected, and an occupied equal sequence
conflicts unless exact. Batch order also matters: a decreasing sequence is rejected by parsing before
store duplicate lookup. There is no legacy historical gap-fill exception. Old occurrences may arrive
with increasing sequence; future occurrence beyond receipt + ten minutes rejects. Client clock
sampling separately pauses upload for excessive absolute offset. Neither check proves past clocks
were accurate; never adjust old rows, derive occurrence from IDs, or rewrite time from receipt.

Do not overstate service endpoint guarantees. It can accept an orphan end and multiple starts/ends
with distinct IDs/orders. Aggregation picks the earliest-sequence start and last later-sequence end;
ends without starts contribute nothing. It does not enforce the generic one-start/one-end invariant.
For a matched turn, completion is start plus end monotonic duration when present, otherwise the
greater of start/end wall times. Add 15 minutes idle grace, cap at report now, then union overlaps.
An unmatched start uses start + 15-minute crash cap, capped at now. These are **Legacy Working Time ·
turn-based**, not execution closures or human Engagement Windows. Day/week clipping and final
minute flooring remain as implemented; do not add separately rounded sessions or lane totals.

The adapter can start recovery at the current observation of `running` **or `awaiting-approval`**,
using a synthetic local message ID. Recovery status is not transmitted. A normal hook and recovered
observation can thus produce indistinguishable service rows. Waiting is not segmented out. An
intact local start may later end without its lost in-memory monotonic anchor. Local fallback timing
also differs from service aggregation: explicitly active local turns run to now. Do not use local
fallback totals as a substitute for the authoritative service calculation.

## Why there is no proven conversion or cross-authority deduplication

| Generic requirement | Why legacy cannot supply it |
| --- | --- |
| Engagement with explicit `origin: human` and interaction kind | Agent starts, ends, status, and turn duration do not establish composition, submission, follow-up, approval, or takeover by a human. |
| Defensible execution segments excluding human-input waits | Even a matched monotonic pair can include waiting; recovered starts and synthetic transitions are not distinguished. Grace and crash caps invent endpoints. An unmatched start cannot become a generic pending start either. |
| Timing provenance/precision and recovered capability | Millisecond serialization is not one-millisecond observation precision. No row says native occurrence versus collector observation or which recovery capability supported capture. Assigning `recovered: false` or an empty/default capability set would fabricate facts. |
| Collector/site binding, immutable IDs and order | Legacy source/session/event identities are a different namespace and lifecycle. A later physical site allocation or current bearer lineage does not attest every old row's capture site. `amp-orb` is shared display text. UUID substitution or hashing cannot manufacture this provenance. |
| Immutable project-at-start attribution | A captured v2 slug preserves legacy attribution but is not an approved generic project binding. v1/null remains legacy Unassigned. Changing everything to generic Unassigned would still invent generic observations and an attribution snapshot/reason. Ends cannot carry generic attribution. |

No deterministic event-level join between the two authorities exists. Even independently collected
generic evidence that overlaps a legacy turn has its own collector/order/IDs and distinct semantics.
Do not deduplicate across authorities by timestamps, duration, slug, executor label, sequence,
credential, or matching UUID text; do not publish a confidence-based equivalence. Exact replay
deduplication **within** each authority remains valid under its own contract. Generic unions handle
overlapping generic intervals; they do not prove two records represent the same observation.

## Future account-wide authority and exact cutover behavior

Until a separately implemented and owner-approved activation, **legacy remains target authority**;
Stage 5E/F totals are shadow-only, and Stage 5O disclosures do not select authority. A future single
account-wide cutover C must be exactly Monday 00:00 Asia/Jakarta. No per-project, site, collector,
credential, or receipt-time cutover is allowed. Stage 5F only validates/clips a caller-supplied C;
it provides no durable authority selection, approval record, or activation transaction.

After that future activation:

- Pre-C historical periods retain Legacy Working Time and their legacy target interpretation. Do not
  recompute them with generic windows, remove grace/crash caps, relabel projects, or turn them into
  estimated Working Time. Preserve complete legacy records and standalone legacy summaries,
  including a crossing turn's full legacy interval; any post-C legacy view is explicitly historical/
  comparison-only and cannot drive post-C targets.
- At/after C, only independently collected accepted generic engagement drives **Working Time ·
  estimated** targets; **Agent Runtime** is separate and targetless. Generic absence never falls back
  to legacy or implies zero actual human work. Coverage limits remain beside progress. An unavailable
  authoritative report must be unavailable, not a success-shaped zero or silent legacy fallback.
- Apply half-open occurrence clipping `[C, reportEnd)` and the report's start/as-of bounds to generic
  intervals, not raw event receipt selection. A 15-minute human window opened before C can contribute
  its remaining portion. A defensible closed execution interval crossing C contributes only after C.
  Starting at C is eligible; ending at C contributes zero; pending generic starts contribute no
  runtime, even if they predate C. Never synthesize an endpoint at C.
- A range spanning C must present separately named pre-C legacy and post-C generic sections with
  their own target comparisons. Do not sum them into one metric/progress percentage or add Working
  Time to Agent Runtime. The Monday boundary avoids split target days/weeks; arbitrary multiweek
  ranges still require separation. Project/site lanes remain non-additive.
- Late accepted legacy records may revise legacy occurrence-period totals under unchanged legacy
  rules; preserving history means preserving semantics, not freezing incomplete snapshots. Late
  generic evidence may revise post-C occurrence totals, including closing a pre-C start across C.
  Pre-C generic contributions remain shadow-only. `asOfMs` caps elapsed contribution, not what was
  known at that receipt time. Reproducible audits must retain their input-snapshot identity separately.

## Failure, restoration, labels, and disclosures

Keep missing/acknowledged local markers unknown; do not upload their warning bounds as Stage 5H loss.
No legacy row establishes a generic capability declaration. Missing rows, sequence gaps, process
lifetime, migration failure, inaccessible credentials, an empty spool, or lack of generic evidence
prove neither complete coverage nor irreversible loss. Only independently evidenced, scoped generic
declarations/loss facts qualify under [Stage 5G](stage-5g-shadow-coverage-contract.md) and
[Stage 5H](stage-5h-shadow-coverage-persistence.md). Availability and synchronization remain independent
under [Stage 5N](stage-5n-shadow-availability-delivery.md); a readable history or recent legacy receipt
does not establish generic synchronization. No synthetic generic collector/status lane is created.

Retain unmatched legacy starts as legacy rows, using the existing crash cap in legacy summaries;
retain generic starts pending until a valid same-collector end arrives. Neither closes the other.
Retry queued records through their original protocol and authorization with exact identity/content;
do not resequence rejected older facts or convert them to bypass conflicts, cutover, or revoked access.

Restored backups are snapshots, not new observations. Exact already accepted replays may deduplicate;
unaccepted old orders can block. Quarantine incompatible/ambiguous state for reviewed recovery, never
renumber or mint generic facts. Restoring a service backup must not silently rewind selected authority
or discard later accepted facts. Before serving authoritative reports, reconcile against the retained
approval and later writes, or suspend authority delivery as unavailable. This recovery control is a
future implementation gate, not an existing facility or permission to merge production databases.

Revocation does not erase accepted rows. Legacy bearer rotation updates source ownership and carries
the label (and any later generic site) forward; this is not a historical generic-site proof. Deleted
or missing credential metadata cannot be reconstructed from names: existing legacy joins fall back
to `unassigned-executor` when metadata is absent. Preserve available backup metadata under restricted
access rather than invent a former label. Do not delete credentials here or promise immutable
historical labels: legacy labels are query-time joins, not event-time snapshots. Capture resolved
labels and lookup-version provenance only in an approved restricted reconciliation snapshot if
reproducibility requires them. Retain recorded legacy slugs/Unassigned; never map them by current name.
Generic display-only labels/ordinals follow [Stage 5O](stage-5o-shadow-disclosures-dashboard.md) and
[Stage 5P](stage-5p-oidc-execution-site-contract.md); they never stitch histories or expose native IDs.

## Independent acceptance vectors for future implementations

These are specifications, **not executed runtime tests**. Future tests must exercise real reporting,
disposable storage, replay, authorization, and failure boundaries, not a stub returning these labels.
Use synthetic data only. In the arithmetic vectors, offsets are minutes from a hypothetical C =
2026-09-14T00:00:00+07:00 (2026-09-13T17:00:00.000Z); this is a fixture, not a selected cutover.
As-of is C+60 and report is `[C-60,C+60)` unless stated. Compute expectations independently with
sorted endpoints and integer milliseconds before final rounding; do not call the production union
function to construct expectations.

| Vector | Independent expectation |
| --- | --- |
| Legacy pair A start -8/end -3, no monotonic; B start +2/end +4; unmatched D +30 | With 15-minute grace/cap, legacy intervals are [-8,12), [2,19), [30,45): full global 42 min, pre-C portion 8 min, post-C comparison portion 34 min. Separate lane lengths 20+17+15=52 must not replace global 42. Generic contribution from all these rows is absent. |
| Independent generic human observations -4 and +9 on different projects | Windows [-4,11), [9,24), clipped to [0,11), [9,24): global estimated 24 min, project lanes 11 and 15 (sum 26). Pre-C shadow contribution 4 min never replaces legacy 8. |
| Independent generic execution X [-7,6), Y [4,17), pending Z at -2 | Post-C runtime global 17 min, site lanes 6 and 13 (sum 19), Z remains pending with no duration. Working Time remains 24 in the preceding vector, not 41; post-C legacy 34 never supplements either. |
| Boundary neighbors | Generic closed [-5,0) contributes 0; [0,3) contributes 3; [0,0) contributes 0. With as-of C all contribute 0. Cutover C+1 ms or Monday 00:00 UTC is rejected as not Jakarta Monday midnight. |
| Duration precedence and skew | Legacy start +5, wall end +2, end monotonic 120000 ms yields [5,22), 17 min; without monotonic yields [5,20), 15 min. Neither converts to generic. New legacy occurrence receipt+600000 ms accepts if otherwise valid; +600001 rejects; neither rewrites old times. |
| Receipt/order asymmetry | Accept legacy seq 7 then 10; exact retry 7 in its own ordered batch preserves receipt/count; changed 7 conflicts; unseen 9 rejects. Batch [10,7] rejects decreasing 7 before store replay. Old occurrence at new 11 may accept; receipt time never shifts its period. |
| Late closure | Generic start -7 initially pending gives 0; a later accepted end +6 gives 6 post-C minutes. A legacy end cannot close it. Late legacy end alters only legacy totals. Both retained snapshots state when and from which inputs they were produced. |
| Best-looking legacy subset | Matched v2 pair, monotonic duration, populated slug, physical label/site metadata, no warning marker: zero generic writes; still no human-origin, wait segmentation, or capture provenance proof. Same-time independent generic pair remains independently eligible. |
| Loss/availability asymmetry | Absent marker and empty rows do not declare completeness; present marker with first/last warning times does not become known loss. A ready panel can remain unknown; a failed history read is unavailable, not zero. Accepted scoped generic loss affects its own disclosure only, not totals. |
| Restore/credential/label | Exact replay after intact restore retains count/receipt; unaccepted older sequence stays rejected; rotation cannot create generic history; missing metadata stays Unassigned Executor. Backup predating authority approval cannot silently serve legacy as current authority. |
| Privacy and rollback | Sentinel native IDs, paths, token material, host metadata and bodies never enter new generic rows, report JSON/DOM, logs, or public audit output. Collector rollback retains facts/queues and post-C authority; missing compatible service/approval state blocks delivery, not automatic legacy fallback. |

Dry-run reconciliation must compare exact legacy rows/counts, per-source order/high-water, receipts,
pending/closed selection and duplicate/conflict outcomes before and after the proposed operation.
For fixed identical inputs, clock, target overrides and configuration, compare legacy daily/weekly
global milliseconds and final floored minutes, project/executor lanes, and full crossing intervals;
generic evidence/coverage/collector counts and receipts must remain byte-for-byte/canonically unchanged
by any legacy audit. Separately verify generic unions/clipping against the arithmetic above and
prove late arrivals affect only their own authority. Counts alone are not totals reconciliation.

## Prerequisites, approval, audit, and rollback gates

Before authority selection or activation, separately implement/review a durable single account-wide
approval/selection contract, trusted-time validation, atomic activation and race behavior, report/API/
target routing across C, unavailable-state handling, and backup-restoration safeguards. No current
setting or Stage 5F function supplies those controls. Resolve all intended collectors' provenance,
durability and recovery limits; Stage 5P's external incarnation/attestation blocker still prevents
generic OIDC ingestion. OIDC is not universally required for cutover, but its missing coverage cannot
be disguised: the owner must explicitly accept the actual enabled sites and missing human evidence.
Approved generic project mapping, coverage upload, scheduling, and clock trust require their own
slices where needed; unknown must remain unknown until those capabilities exist.

Require independent shadow-total validation, dashboard metric/target/coverage readiness, the acceptance
vectors above, and an owner decision recording the exact C, scope, accepted limitations, evidence
snapshot references, and compatible rollback floor. Collector upgrades or documentation acceptance
alone are not that decision. No stable SDK or support claim follows; Stage 6 integration gates remain.

A future optional audit ledger must be separately approved with a closed minimal schema, retention,
access, deletion and integrity policy before implementation. It may contain restricted snapshot
references/digests, contract/tool versions, fixed outcomes, aggregate counts and reconciliation deltas,
never fabricated evidence, writable authority flags, raw payloads, native IDs, credentials, paths or
arbitrary metadata. Pseudonymous IDs/digests and precise historical totals remain sensitive. Private
label snapshots belong to restricted backup/reconciliation material, not a public report or generic
schema. Public review output uses synthetic fixtures and aggregate sanitized verdicts. An audit
failure leaves authorities untouched; no automatic loss declaration or fallback follows.

Before any future data operation, obtain scoped owner approval and verify an access-controlled,
consistent backup of legacy rows/ownership/labels/targets plus generic facts/bindings, relevant keys
and selected authority state. Rehearse restoration against disposable copies, retaining later writes
and queued records; never overwrite live data from a stale backup. Dry runs must be read-only and
must not trigger startup migrations on source databases. Failed reconciliation blocks activation.
Rollback retains accepted records and compatible ingestion; old binaries that reject newer service
schemas are not a rollback plan. Pause affected collection/reporting when necessary without deleting
facts, downgrading schemas or silently restoring legacy target accounting. Returning to legacy
authority requires a separate explicit owner decision and reviewed future policy, not toggling C.

Stage 5Q changes only this contract and ROADMAP. These paths do not match the current main-push
[service publication workflow](../.github/workflows/publish-service.yml): this slice is publication-
neutral, but the cumulative Stage 5 prerequisites are not. No TypeScript, runtime, schema, DDL,
migration/backfill script, API, dashboard, client, collector, config, workflow, database operation,
authority activation, support claim, shared setting, production access, push, publication or deployment
is authorized. Each future implementation and any publication/deployment needs its own review and
explicit approval. Documentation audits do not claim runtime or production verification.
