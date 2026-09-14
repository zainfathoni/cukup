# Stage 5R: durable account-wide authority activation

This **documentation-only contract** builds on [Stage 5F](stage-5f-cutover-clipping.md) and
[Stage 5Q](stage-5q-legacy-history-authority.md). It selects no date and activates nothing.
It defines one prospective legacy→generic transition for the whole account, not per project,
execution site, collector, credential, receipt time, or report request. All legacy evidence backfill
and heuristic cross-authority deduplication remain rejected. Separate authorities are never summed.

The current [Stage 5F function](../service/shadow-aggregation.ts) validates/clips a caller-supplied
instant but does not persist or approve it. [Summary API](../service/app.ts) and
[dashboard totals](../service/dashboard/report-builder.ts) still use legacy aggregation;
[Stage 5O](stage-5o-shadow-disclosures-dashboard.md) adds only independent disclosures.
The [synchronization clock](../service/shadow-synchronization.ts) defaults to untrusted and does not
establish an authority clock. None of the future controls below exists merely because these slices do.

## One durable decision, with an irreversible boundary fence

The minimum logical state is a versioned account-owned selection record and its durable decision
history. This is a behavioral contract, **not a table, wire schema, setting, or new endpoint**.
Persist these facts atomically and retain superseded decisions for recovery:

- A service-generated opaque selection identity, account binding, monotone revision, and closed
  state: `legacy`, `prepared`, `armed`, `active`, or `cancelled`. Missing state is not `legacy`.
  A reviewed first initialization must establish explicit legacy state and recovery lineage before
  serving through the new authority router; it must not overwrite an existing/restored lineage.
- For a candidate: exact integer UTC millisecond C, canonical Asia/Jakarta civil representation,
  direction legacy→generic, contract version, and immutable gate-manifest reference/digest. The
  manifest binds enabled scope, accepted coverage limitations, shadow/dashboard validation inputs,
  target-policy version, compatible rollback floor, and recovery verification. Use bounded closed
  records and opaque references, not free-form metadata or credential/native identity payloads.
- Owner approval bound to the exact selection/revision/C/manifest: authenticated owner authorization
  decision, trusted approval time, opaque operation identity, and immutable approved terms. A plugin,
  collector, normal ingestion credential, scheduler, or report request cannot approve. The future
  owner control must separately define its authentication, authorization, revocation, and CSRF/replay
  protections; current bearer/OIDC ingestion permission is not owner approval.
- Activation outcome bound to that approval: effective boundary C, actual trusted commit time A,
  resulting revision, operation identity, and recovery-lineage checkpoint. A may exceed C; never
  falsify A as C. Revision/order is not a timestamp. Failed attempts are not successful approvals.

`prepared` has no routing effect. Approval atomically changes it to `armed` only while trusted time
is strictly before C and every gate is valid. `armed` is a binding authorization to activate at C,
not activation itself. Before C, an authorized owner may cancel by compare-and-swap; retain the
cancelled record. Editing any approved term requires cancellation and a fresh candidate/approval.
Once C is reached, cancellation, changing C, and returning to legacy are forbidden in this contract,
even if activation has not committed. A replacement of a cancelled candidate uses a new selection
identity and a strictly future C; it cannot overwrite history. Only one candidate may be armed.

At C the armed decision **fences legacy target delivery for occurrence periods at/after C**. A
worker or report request may perform the already-authorized activation; neither supplies a new C.
Until activation commits, affected authoritative sections are unavailable, not legacy. A service
outage spanning C therefore does not move the boundary: recovery activates the same C when safe,
or remains unavailable. An active decision never becomes legacy because a flag, clock, or database
read fails. Delivery suspension is orthogonal to durable selection, not a reverse transition.

## Trusted time and atomic races

C must be exactly Monday 00:00:00.000 Asia/Jakarta, verified by civil conversion as well as integer
validation. Monday midnight UTC is not equivalent. Client time, `/v1/time`, receipt timestamps,
JWT issuance, recent synchronization, and bare `Date.now()` do not establish clock trust.
The future service clock provider must supply a fresh, authenticated/operationally validated UTC
sample with a bounded uncertainty interval [L,U], a monotonic ordering guard, and a trust epoch.
Its maximum age, uncertainty budget, trust source and repair/revalidation procedure must be pinned
and tested in the implementation review before approval is possible; unspecified means untrusted.

Approve/cancel only if U < C; activate only if L >= C. If L < C <= U, wait and withhold boundary-
dependent authoritative delivery. Do not round into Monday or grant early tolerance. A backward
sample, expired trust, forward jump outside the provider's validated bounds, restart without renewed
trust, or inconsistent trust epoch suspends time-dependent authority operations/delivery until
explicit revalidation. It does not undo active selection. Current progress/as-of must use this
trusted service time, not a caller-chosen future as-of. Historical as-of is only an elapsed cap.

Selection mutations, authorization revalidation, gate validity, clock epoch/sample validity,
expected revision, and activation outcome must have one serializable commit boundary. Storage
implementation may vary, but no process can serve an intermediate state. Require a single fenced
writer/leader or equivalent cross-process serialization; a process-local mutex is insufficient.
No acknowledgement precedes durable commit. No evidence rewrite or aggregation is part of activation.

Two activators for the same approved revision produce one activation record; the loser returns the
same committed outcome after reauthorization. Exact operation retries return the original outcome
without new revisions/timestamps; changed terms under the same operation identity conflict. A stale
revision cannot approve/cancel a successor. A denial committed before a mutation prevents it;
revocation of control access does not undo an already armed approval. Revoking that approval itself
requires the authorized pre-C cancellation above. Gate invalidation is serialized with activation:
if invalidation wins, activation blocks; if activation wins, a later readiness failure suspends
affected delivery without reversing authority. A crash before commit leaves armed; a crash after
commit/ack loss leaves active and retry-idempotent. Never use a pending local flag as success.

Read each authoritative response from one consistent selection revision, evidence snapshot,
target-policy/override snapshot, disclosure snapshot and trusted as-of. Serialize delivery validation
against selection mutation and time crossing: a calculation begun before C cannot be released as
current legacy progress at/after C. Recompute under the committed revision or return unavailable.
The linearization point is the server's final authorization to release the response, not packet
arrival; responses carry a validity boundary so a compatible client cannot keep using pre-C progress
after C. If a client cannot establish that validity, it withholds current progress and refreshes.

## Reports, API compatibility, caches, and targets

| Durable decision and requested occurrence range | Target-bearing result |
| --- | --- |
| Explicit legacy, prepared, or cancelled; no armed/active decision | Existing Legacy Working Time · turn-based under unchanged legacy target rules; generic remains shadow. |
| Armed, trusted now before C | Legacy current progress, with a validity fence at C. Future portions are not reported as completed work. Generic remains shadow. |
| Armed, now at/after C, activation not committed | Pre-C history may remain separately available if state/time/recovery are verified; post-C authority is unavailable. No legacy extension. |
| Active, range wholly before C | Legacy historical totals and legacy target interpretation. Pre-C generic is explicitly shadow-only. |
| Active, range wholly at/after C | Working Time · estimated from accepted independent generic engagement; Agent Runtime separate and targetless. Legacy only in explicitly named historical/comparison views. |
| Active, range crosses C | Separate pre-C legacy and post-C generic sections, each with its own applicable target comparison and availability. No combined total, percentage, streak, goal achievement, or account-wide progress derived by adding them. |
| Missing/corrupt/incompatible selection, uncertain clock, or unreconciled restore | No authoritative response. Independently verified historical comparison snapshots may be shown as non-current only; never infer a default authority. |

For the post-C section, clip derived generic intervals to
`[max(C, reportStart), min(reportEnd, trustedAsOf))`. A pre-C human observation may leave part of its
15-minute window after C; a defensibly closed execution interval may cross C. Ending at C contributes
zero, starting at C is eligible, and pending starts contribute no runtime. Never close at C, filter
by receipt time, or convert legacy endpoints. For the pre-C section, clip unchanged legacy intervals
at C for that section only; retain full legacy crossing intervals in standalone legacy summaries.
Union integer milliseconds globally for each metric before final minute flooring; lanes remain
non-additive. Do not add Agent Runtime to Working Time or generic to legacy. Late arrivals revise
only their own occurrence-period authority. `asOfMs` does not recreate knowledge at that time;
reproducible reports separately bind their actual input snapshots, configuration and target overrides.

Targets keep the existing Asia/Jakarta civil day/week schedule and dated override semantics; no
automatic target reset, rescaling, duplicate override, or migration at C. Before C, the numerator
is legacy; at/after C it is estimated Working Time. The Monday boundary avoids splitting target
days/weeks. Arbitrary multiweek reports still split into separate sections. A target change and a
report race uses one committed override snapshot, not old denominators with new numerators. Existing
authorized target editing can remain date-based; it cannot select authority. For post-C estimated
Working Time, a zero target means no target comparison, not division by zero or automatic achievement.
Pre-C sections and standalone legacy summaries retain existing legacy target interpretation, including
zero-target classifications. Project/site filters do not allocate or sum account targets and cannot
override the account's selected authority.

Every target consumer must migrate before arming: dashboard, summary API, plugin/local fallback,
exports and any cached progress. The existing `/v1/summary` schema must not silently change its
legacy metric into estimated Working Time. The future API slice must freeze a versioned authority-
aware response and bounded unavailable/error behavior. Incompatible legacy clients must lose
current target delivery at C (and suppress local legacy progress), not receive a success-shaped zero
or reinterpret generic numbers as legacy. If that compatibility fence cannot be demonstrated, do
not arm. Legacy summary access may remain explicit comparison-only with no current target claim;
do not repurpose ingestion routes, revoke accepted evidence, or disable delayed legacy retries.

Cache identity includes selection revision/C, metric/section/range, evidence and target snapshot
versions, contract version, and as-of; disclosure freshness is independently classified. Pre-C or
older-revision responses cannot reappear as current post-C authority, including out-of-order browser
refreshes and mixed-version replicas. Stale compatible totals may be shown only as named historical
snapshots without current progress/achievement; apply [Stage 5N](stage-5n-shadow-availability-delivery.md)
stale synchronization redaction. Incompatible cached reports are discarded from current delivery,
not normalized into plausible totals. This requires a future client/API slice; Stage 5O's schema-1
compatibility normalization alone is not a cutover fence.

A failed authoritative evidence/target/required disclosure read yields unavailable for its dependent
section, with no numeric/progress payload; independent sections may survive. Unknown capability or
synchronization is a valid disclosure, not a query failure. A successful complete snapshot with no
contributing engagement may display **0 observed estimated minutes**, alongside coverage limitations
and no assertion of zero actual work; runtime-only evidence does not fill human time. Unknown/loss
disclosures do not adjust totals. Unavailable and successful-empty are distinct outcomes, including
in API errors, DOM, accessibility text, caches, exports and client fallback paths.

## Approval gates, restoration and privacy

Before arming, require all of the following, with restricted immutable evidence references. Gate
validity is bound to the deployed compatible implementation/configuration and enabled scope; changes
invalidate affected gates. Pin any expiry policy before implementation; no unspecified freshness.

1. Independent shadow totals, clipping, late evidence, no-backfill and no-summing reconciliation
   against [Stage 5Q's vectors](stage-5q-legacy-history-authority.md), plus the vectors below. Preserve
   exact legacy semantics and accepted generic facts/counts/receipts; an audit cannot create evidence.
2. Dashboard/API/client target routing, metric labels, coverage/availability and boundary cache fences
   demonstrated end-to-end, including incompatible consumers, failures and partial availability.
   Stage 5O disclosures alone do not meet generic totals or target readiness.
3. Owner explicitly accepts the actual enabled sites/collectors, supported human observations,
   missing human evidence, Unassigned attribution, pending endpoints, delivery/recovery limits, known
   loss and unknown capability/synchronization. Acceptance is of limitations, not a fabricated
   completeness declaration or permission to estimate absent work from runtime. No hidden minimum
   coverage score or all-sites-complete assertion. A runtime-only deployment requires explicit
   acceptance that estimated Working Time may remain zero observed while actual work is unknown.
4. [Stage 5P](stage-5p-oidc-execution-site-contract.md) remains externally blocked on attested
   incarnation/lifecycle and durability guarantees: generic OIDC ingestion stays disabled, attribution
   Unassigned and OIDC synchronization unsupported. OIDC is not universally required for cutover;
   the owner must accept its missing coverage. No implementation of OIDC is part of this slice.
5. Trusted clock, owner control, serializable durable selection, compatibility floor and restored-
   backup fencing are implemented and rehearsed on disposable data. Collector upgrades, documentation
   acceptance, stable SDK status or three-integration support gates do not themselves approve C.

An approved recovery mechanism must retain a rollback-resistant checkpoint outside the replaceable
service-backup lineage, binding the latest committed authority revision/approval/C and accepted-write
frontier. Protect it with integrity/access controls and serialize its advancement with acknowledged
selection/data writes, or use an equivalent durable journal/recovery protocol with the same guarantee.
There must be no acknowledged activation whose approval/fence can disappear after restoring an older
backup. A lone row in that same backup or Stage 5Q's optional audit ledger is insufficient. The exact
storage, coordination and retention mechanism is a future implementation gate, not infrastructure
authorization here. If the checkpoint cannot be verified, suspend authoritative delivery.

Before future recovery, obtain separate scoped approval, stop/fence writers, verify a consistent
backup of both authorities, ownership/bindings/keys, targets, selection/approval and checkpoints, and
retain later accepted writes and queued records. Reconcile restored revision and data frontiers with
the retained lineage before serving. A backup predating approval cannot silently initialize legacy;
one predating activation remains fenced by the approved C. Recover the exact committed decision and
later facts, or remain unavailable. Checksums/counts alone do not prove lineage or retained totals.
Never resequence queues, invent loss/closures, overwrite newer facts, change C, downgrade schemas,
or rerun approval merely to get a restore to open. Test exact replay and blocked old unseen orders.

Rollback must retain accepted records, queues, authentication mappings and compatible ingestion.
Old binaries lacking the selection fence must not serve authority, even if they can open the database.
The floor includes schema-8 prerequisites and future authority-aware reader/client/recovery versions,
not just a database version. Pause reporting/collection as needed. Returning to legacy, abandoning a
crossed armed boundary or selecting a second cutover requires a separately reviewed owner policy;
none is allowed by toggling/deleting selection. No automatic rollback to legacy is specified.

Selection/approval is required restricted control state, distinct from Stage 5Q's optional
non-authoritative audit ledger. Its future closed schema must pin retention, access, deletion and
integrity rules before implementation; deletion must never erase a live recovery fence. References,
digests, account/owner bindings and precise historical totals are sensitive, not public identifiers.
Use authentication-owned opaque references, not copied claims or raw user identities. Native thread,
message, platform/project IDs, paths, hostnames, token material, bodies and arbitrary metadata never
enter new selection records, report JSON/DOM, logs or public review artifacts. Restricted manifest
scope references may identify internal sites/collectors; reports use Stage 5O privacy-safe labels,
never raw UUIDs or approval/snapshot IDs. Operational logs use fixed event/outcome categories only,
not timestamps, manifests, payloads or exception details. Public audit output is synthetic/aggregate
sanitized verdicts. Audit failure cannot mutate either authority or manufacture a loss declaration.

## Asymmetric acceptance vectors

These are future implementation requirements, **not executed runtime tests**. C is a synthetic
fixture: 2026-09-21T00:00:00+07:00 = 2026-09-20T17:00:00.000Z, not a selected cutover.
Unless stated, offsets below are minutes, as-of is C+40 and the report is `[C-30,C+40)`.
Independently derive endpoint unions in integer milliseconds; do not use production aggregation
to build expected values. Future tests must exercise real disposable persistence, clocks, routes,
clients, recovery and privacy sinks, not an adapter that simply returns these words.

| Scenario | Independent expected result |
| --- | --- |
| Civil/time neighbors | C valid; C−1 ms, C+1 ms and Monday 00:00 UTC invalid. Approval at exact trusted C rejected; activation at C−1 ms blocked, at C eligible. Clock [C−1,C+1] ms permits neither approval nor activation; boundary-dependent delivery withheld. |
| Candidate versus approval | Prepared C passes without owner approval: legacy unchanged. Armed C passes during downtime: post-C unavailable until one durable activation with effective C and actual A>C. No retrospective selection of a fresh past C. |
| Cancel/activate | Owner cancellation commits at C−1 ms: cancelled, activator cannot use old approval. At C cancellation rejects; two activators yield one record/revision. Changed payload with same operation ID conflicts; exact retry preserves A. |
| Gate/control races | Gate invalidation before activation blocks it; after activation suspends dependent delivery. Control access revoked before mutation denies it; already armed approval remains unless valid pre-C cancellation commits. |
| Legacy crossings | A start −11/end −6 and B start +3/end +5, no monotonic duration: with grace, intervals [−11,9), [3,20), full legacy union 31 min; pre-C section 11 min, post-C comparison 20 min. Lane sum 37 is not global 31; none becomes generic. |
| Generic engagement and runtime | Humans −6 and +12 on different projects give clipped [0,9), [12,27): estimated global 24 min, not legacy 20 or runtime. Closed executions [−9,4), [2,16) on different sites give runtime 16 min, lane lengths 4+14=18. Pending −3 stays pending. Combined 40 is forbidden. |
| Boundary and late closure | Execution [−8,0) gives 0; [0,2) gives 2; as-of C gives 0. Pre-C start −9 pending then late end +4 revises runtime from 0 to 4, not 13. Later legacy end cannot close it; acceptance time cannot shift its period. |
| Floor once | Generic windows starting C−14 min 20 sec and C+14 min 30 sec, with as-of C+15 min 10 sec, contribute 40 sec each: global 80000 ms → 1 min, not separately floored 0. Pre-C shadow portions do not add. |
| Target split | Fixture Sunday target override 240 min with legacy 11; Monday default fixture 480 with estimated 24: comparisons remain 11/240 and 24/480, never 35/720. Runtime 16 has no target. Monday override 0 removes comparison, not work or authority. |
| Read/cache races | Start calculation at C−2 ms, release at C+1 ms: recompute or unavailable, no current legacy payload. Delayed pre-C response arriving after active revision cannot replace it. Unsupported client/local fallback cannot claim legacy target progress after C. |
| Empty versus failed | Readable generic snapshot, no engagement, runtime 16 and unknown coverage: 0 observed estimated minutes, 16 runtime, unknown actual work. Failed generic/target/disclosure read: no dependent numeric/progress payload; verified pre-C section may survive. |
| Restore/crash | Crash before activation commit leaves armed; after commit/ack loss retry returns original A. Restore backup before approval against newer checkpoint: delivery blocked until exact lineage/later writes reconciled, never default legacy. Lost checkpoint and old compatible-schema-only binary both fail closed. |
| Privacy/coverage | Synthetic sentinel native IDs, paths, tokens and bodies absent in all new public/control/log sinks; internal scope refs stay restricted. Missing OIDC and human evidence require explicit limitation acceptance, not invented capability/loss facts or runtime-derived engagement. |

## Implementation and publication boundary

Next slices separately own durable control/recovery storage and owner operations; trusted-time and
activation transactions; versioned report/API/target and client/dashboard compatibility; and rollout
gate rehearsal. Exact wire errors, schemas, checkpoint protocol, clock budgets and authentication
mechanisms must be reviewed before coding their owning slice. These are implementation blockers,
not permission to weaken the settled contract. No activation may precede all gates.

Stage 5R changes only this document and ROADMAP. Those paths do not match the current main-push
[service publication workflow](../.github/workflows/publish-service.yml); this slice is publication-
neutral. The cumulative Stage 5 prerequisites change service image inputs and are **not** publication-
neutral. No runtime/schema/DDL/migration/API/dashboard/client/collector/config/workflow change,
production access, database/settings mutation, authority activation, push, publication or deployment
is authorized. Docs-only checks and synthetic arithmetic do not claim runtime/production verification.
