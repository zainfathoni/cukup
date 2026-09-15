# Stage 5Z: authority-aware report delivery contract

Status: **complete design-contract slice; implementation and activation blocked**. This document
closes the report/API/client/cache boundary required by [Stage 5R](stage-5r-authority-activation-contract.md).
It selects no C, trusts no clock, implements no wire schema, and activates no generic accounting.
[Stage 5Q](stage-5q-legacy-history-authority.md) owns historical semantics;
[Stage 5S](stage-5s-authority-control-storage.md) owns restricted recovery/control state;
[Stage 5Y](stage-5y-commit-authority-provider-decision.md) still selects no provider.

## Existing behavior is not an authority envelope

- [Aggregation](../service/aggregation.ts) and `/v1/summary` in [app.ts](../service/app.ts)
  return schema-1 legacy daily/weekly targets. Grace, crash caps, occurrence clipping, global union
  and final minute flooring remain legacy semantics. Date overrides retain the Jakarta schedule.
- [Report types](../service/dashboard/report.ts) expose schema-2 panels, not authority metadata.
  Schema-1 normalization preserves legacy panels and adds unavailable shadow disclosures; it does
  not validate a selection, time proof, or restore frontier.
- [Builder](../service/dashboard/report-builder.ts) independently queries legacy overall, timeline,
  trend and executor panels; failed reads become unavailable. Overall/day targets ignore filters.
  The builder's injected `nowMs` is not an authority clock or a consistent multi-query snapshot.
- [Backend](../service/dashboard/backend.ts) serves initial rendered HTML plus embedded report and
  POST refresh JSON with `no-store`. [Client](../service/dashboard/client.ts) normalizes both paths.
  [Controller](../service/dashboard/controller.ts) queues refreshes and retains failed refresh data
  as stale; it has no authority/request-generation release fence. [Renderer](../service/dashboard/render.ts)
  still renders stale target verdicts and a report-wide authoritative-as-of heading.
- [Plugin sync](../plugin/sync.ts), [cache](../plugin/store.ts) and [status](../plugin/status.ts)
  overwrite a singleton summary, display retained target classifications, and can show local legacy
  fallback. `/v1/time` and cache age do not establish authority validity.
- [Stage 5E](stage-5e-shadow-aggregation.md)/[5F](stage-5f-cutover-clipping.md) are pure generic
  aggregation/clipping, not production accounting. [5N](stage-5n-shadow-availability-delivery.md)/
  [5O](stage-5o-shadow-disclosures-dashboard.md) deliver independent disclosures, not generic totals.

Existing builder, backend, controller and render tests characterize these behaviors, including
non-additive lanes, legacy zero-target `OVER`, panel failure, schema-1 normalization and stale
synchronization redaction. They are not proof of future authority readiness.

## Closed logical envelope, version 1

This is a logical contract, distinct from dashboard schema 1/2, summary schema 1, evidence versions
and SQLite version 8. Future codecs must map it to a separately negotiated incompatible report/API
version; never reuse an existing version with changed meaning. No endpoint is selected here.
There are exactly two measurement authorities: `legacy` and `generic`. `unresolved` below is a
refusal to identify authority, not a third authority. Runtime is a metric, never another authority.

The following are the complete logical fields; no extension bags or copied internal records:

| Object | Fields and constraints |
| --- | --- |
| Envelope | `contract_version: 1`, `timezone: Asia/Jakarta`, `range: {start,end}`, `as_of` (trusted elapsed cap or null on whole-envelope refusal), `authority: verified/unresolved`, `cutover` (C or null), `delivery: current/snapshot/unavailable`, `reason` (null or closed reason below), `sections` (0..2). |
| Section | `authority: legacy/generic`, `range: {start,end}`, `working_time: Metric`, `agent_runtime: Metric` (generic only; absent for legacy), `disclosures: DisclosureDelivery` (generic only; absent for legacy). Ordered legacy then generic; no duplicate authority. |
| Metric | `metric: legacy_working_time/working_time_estimated/agent_runtime`, `state: ready/stale/unavailable`, `reason` (null only for ready), `data` (present only for ready/stale). Authority fixes the metric name; no client-supplied substitution. |
| Metric data | `observed_minutes` (nonnegative safe integer), `target: none/comparison`, `comparison` (present only for comparison: `target_minutes`, `status: UNDER/COMPLETE/OVER`, `difference_minutes`). Runtime always has target none. Stale metrics always have target none and omit comparison. No combined progress field. |
| DisclosureDelivery | `state: ready/stale/unavailable`, `reason` (null only for ready), `data` (present only for ready/stale, exact shape below). Stale retains capability/loss/pending facts but every synchronization is unknown under Stage 5N. |

Disclosure data has exactly `start`, `end`, `lanes`. Each lane has exactly `label`,
`capability_intervals`, `known_losses`, `pending_execution`, `synchronization`, preserving 5O's
projection without private keys. Each capability interval has `start`, `end`, `working_time_v1`,
`agent_runtime_v1`. Each assessment is exactly `{status: unknown}`, or status declared_for_scope
with `missing_recovery_capabilities`, or status declared_limited with `missing_capabilities` and
`missing_recovery_capabilities`. Each loss has exactly `start`, `end`, `capabilities`, `reason`.
Loss reasons are storage_exhaustion/source_without_replay/abrupt_termination/operator_discard/
unspecified, not the operational delivery refusal reasons below. Pending has exactly
`status: none_pending/pending`, `started_at` (empty for none_pending, nonempty for pending).
Synchronization is exactly clear/queued/retrying/blocked/unknown. Times are canonical UTC bounds;
capability/loss intervals are nonempty and clipped to the disclosure range. Pending start times
retain Stage 5I occurrence scoping; they are not durations or fabricated endpoints.

All capability lists are duplicate-free subsets of this frozen version-1 vocabulary:
engagement.composition, engagement.submission, engagement.follow_up, engagement.approval,
engagement.takeover, execution.segments, recovery.engagement.composition,
recovery.engagement.submission, recovery.engagement.follow_up, recovery.engagement.approval,
recovery.engagement.takeover, recovery.execution_start.native,
recovery.execution_start.current_observation, recovery.execution_end.native, process.lifecycle.
Missing-recovery lists contain only recovery-prefixed values. The existing 5I projection determines
the metric-specific missing sets; this list does not grant capability or permit process-lifetime
measurement. Future protocol additions require a reviewed envelope version, not arbitrary strings.

Closed refusal reasons are `authority_unavailable`, `report_unavailable`, `not_started`,
`refresh_required`, and `unsupported_version`. They deliberately do not disclose whether a journal,
authorization policy, key, clock or database failed. Authentication denial remains an HTTP denial,
not a report that discloses account state. No arbitrary exception/message string crosses the boundary.
UI wording is locally mapped from these codes and fixed metric labels.

Envelope `authority: verified` means routing was verified at its release, not complete observation
coverage. `cutover` is non-null only for a verified armed/active fence; prepared/cancelled candidates
are not public. `authority: unresolved` requires delivery unavailable, reason authority_unavailable,
null cutover/as_of and no sections. Missing state cannot default to legacy. With verified authority,
delivery current means freshly validated routing and at least one ready metric; individual sections
may be unavailable. If none is usable, delivery unavailable; retained-only delivery is snapshot.
Snapshot retains its original as-of/C and named authority, never a new current validity claim.

`range` is a canonical half-open UTC interval; the civil display zone is always Asia/Jakarta.
Integer milliseconds are 0..253402300799999, dates round-trip exactly, ranges are nonempty and
at most 366 civil days. `as_of` is an elapsed cap, never a receipt watermark or claim of what was
known then. Restricted server cache provenance binds actual input snapshots separately.
Future initial, refresh, summary, export and cache codecs must enforce exact fields/discriminants,
duplicate-key rejection, finite safe integers and bounded UTF-8 before parsing/rendering. Unknown
versions/fields/enums, malformed nested data and invalid field combinations reject the envelope;
no coercion, partial normalization or silent truncation. The future wire slice must pin finite
byte, lane, interval, label, request and response-deadline budgets before implementation. Exceeding
a budget yields payload-free report_unavailable, never a partial total masquerading as complete.

The minimal envelope carries section totals and target comparisons only. Existing timeline, trend,
day-detail and project/executor views are not new lanes here: their future implementation must use
the same authority/range/state fence on every existing view, or suppress that view. No raw project,
site or collector key is added to support filtering. Filter transport and richer view codecs remain
separately reviewed; they cannot be implemented by passing internal IDs through this envelope.

## Authority, clipping and target routing

Explicit legacy/prepared/cancelled state without an armed/active fence serves legacy only. Armed
before C serves current legacy with expiry no later than C. Armed at/after C without committed
activation leaves post-C metrics unavailable; verified pre-C history can survive. Active serves
legacy before C and generic at/after C. A crossing range has separate sections, each target none
in this minimal envelope, never their sum, combined percentage, streak or goal achievement.
The multi-period comparison presentation required by 5Q/5R remains a richer-view implementation
gate; complete civil-day/week comparisons remain available as separate requests. Whole-envelope recovery/time
failure withholds authority; it does not extend legacy or silently select generic.

Clip unchanged derived legacy intervals to `[start,min(end,C,as_of))` in pre-C sections only.
Standalone explicitly historical legacy comparison retains full crossing intervals and its original
semantics outside this minimal authority envelope. Generic intervals use
`[max(start,C),min(end,as_of))`, after pairing/deriving from a complete accepted input snapshot.
Do not prefilter away crossing starts or use receipt time. Pending starts remain pending, not
closed at C. End at C contributes zero; start at C is eligible. A wholly future section is
unavailable/not_started, not observed zero. A nonempty elapsed section with zero contribution is
ready zero. Union each metric globally in integer milliseconds before flooring once to minutes.
Project/site lanes remain non-additive; never add runtime to working time or legacy to generic.

Keep Jakarta civil daily/weekly target schedule and exact-date overrides. A minimal target-bearing
request covers one civil day or Monday week; arbitrary ranges can show totals but target none.
Future daily/weekly subviews in larger ranges compare each unsplit civil period separately. No
rescaling, reset or duplicated override at C. Generic zero target means target none, not COMPLETE;
legacy preserves existing zero-target COMPLETE/OVER interpretation. Only global working time has
comparisons; filters never allocate targets. Runtime remains independent and targetless even if
engagement or target delivery fails. No runtime-derived human time or inferred completeness/loss.

Evidence, target policy/overrides, required disclosures, labels, authority and trusted as-of must
come from one consistent recoverable read context. Failed engagement/target/required disclosure
reads make dependent working-time data unavailable, without numbers or comparison. A target-only
failure need not hide independently verified runtime; failed runtime input need not hide engagement.
Failed required generic disclosures withhold both generic metrics. Unknown capability/synchronization
and accepted known loss are valid ready disclosures and do not modify totals. Ready-empty lanes mean
no accepted matching disclosure facts/status lanes, not complete coverage. Successful empty engagement
may show **0 observed estimated minutes** while runtime is positive and actual human work unknown.

## Release fencing without exposing control identities

The server retains, privately, the selection revision/C, recovery lineage/head, evidence/target/
disclosure/label snapshot versions, contract/floor, request selection and trusted as-of. Those are
cache-key inputs, not public fields. Every cache hit must freshly revalidate the current recoverable
head, authorization, compatible floor, readiness and trusted time before release. Changed inputs
invalidate/recompute dependent entries. Late evidence may revise the same as-of; timestamp equality
is never cache equality. Do not emit journal/approval/snapshot IDs, digests or revisions as ETags.

Final release authorization is serialized against decision/readiness/target/auth changes and C
crossing, as required by 5R/5S. A computation started before C cannot release current legacy at/after
C. Recompute or refuse within a bounded deadline. An old replica, restored backup or version-mixed
server without a fresh witness cannot release current data. Never mutate authority while reading a
report except through the separately implemented already-authorized 5R activation protocol.

Future transport carries a bounded validity deadline for current use, no later than C for armed
legacy and no later than any applicable time/gate/session validity limit. This is delivery metadata,
not a control identifier, new clock trust or a promise that data cannot change before expiry.
The precise authenticated time/deadline representation and client conservative validity proof are
implementation blockers: browser Date.now, HTTP Date, `/v1/time`, receipt age, a logical sequence,
or an unchecked TTL is insufficient. Without proof, show snapshot/unavailable and refresh; do not
show current progress. A valid deadline never substitutes for server release revalidation.

Apply the same rule before initial HTML renders, before embedded JSON hydration, on refresh and
before every client cache use. Initial HTML must not flash current verdicts before the client can
establish validity; serve snapshot/no-current markup until validated. Suspend/resume, hidden-tab
return, back-forward cache restore, reconnect and lost validity immediately withhold current progress.
Use no-store for authenticated HTML/JSON and no shared/service-worker current-report cache. If a
future private persistent cache is approved, it can start only as a validated historical snapshot.

Client-local request generations bind selection/range and authentication session. A response from
an older generation, old session or superseded request cannot overwrite the accepted state, even
with a later as-of. A failed refresh removes current comparisons immediately; retained compatible
totals stay visibly snapshot/stale with original labels/as-of, target none and synchronization unknown.
Unavailable sections remain payload-free. Changed selection never relabels old data as the new
selection. Authentication loss clears retained private data; incompatible cache data is discarded.
Never borrow fresh disclosure status for retained totals from a different snapshot.

## Compatibility and privacy are release gates

Schema-1 summary and schema-1/2 dashboard responses retain legacy meaning only. Existing deployment
behavior is unchanged by this document. In a future authority-aware consumer, old responses cannot
establish current authority even before C: reject them from current use, or display only explicitly
legacy non-current comparison content. Schema-1→2 disclosure-unavailable normalization may continue
only inside that legacy-only path. Never wrap old payloads with invented verified/C/as-of metadata.
An unsupported new response cannot replace good retained data with zero or trigger a legacy fallback.

Before arming, all target consumers (dashboard initial/refresh/DOM, summary, plugin status/local
fallback/cache, exports) must support the fence or be prevented from claiming current progress.
Simply returning a non-2xx response to old plugins is insufficient: old cache and local progress
must be suppressed too. Legacy summary routes cannot send generic numbers in schema 1. Their future
compatibility response must be bounded non-success for ineligible current use; existing authenticated
ingestion/replay is independent and stays compatible. The future API slice must pin negotiated
version errors and HTTP statuses (including partial section success versus whole-envelope refusal)
before coding. No success-shaped zero on an HTTP error or missing report.

Use exactly **Legacy Working Time · turn-based**, **Working Time · estimated**, and **Agent Runtime**
in charts, tooltips, screen-reader descriptions and exports. No report-wide “authoritative” heading
for stale/unavailable mixtures. Project and executor text stays privacy-safe display-only; use 5O
unique Executor Labels or display ordinals, and Unassigned where applicable. Labels never join
authorities or prove immutable identity. Preserve legacy query-time labels/slugs without relabeling
history through current project mappings. Stage 5V/W/X capture/control identities remain restricted.

No control/journal/account/owner/project/native/collector/site/evidence/segment/fact identifiers,
snapshot references/digests, paths, hostnames, tokens, prompts or bodies enter new report JSON,
HTML/DOM, accessibility attributes, URLs, client caches, logs or public artifacts. No identifier
encoding or hash laundering into labels. Closed operational reason categories only; detailed
diagnostics and reconciliation provenance stay behind separately reviewed restricted boundaries.

## Asymmetric acceptance vectors and release gates

These are future requirements, not executed runtime tests. C below is a symbolic hypothetical
Jakarta Monday midnight, not a selected date. Offset units are minutes unless stated otherwise.
Arithmetic defaults are range `[C−30,C+40)` and as-of C+40; target vectors instead use separate
complete Sunday/Monday day requests, with the same as-of. Other rows override these when stated.
Tests must drive real codec/server/client/cache/render boundaries with disposable inputs and derive
expected endpoint unions independently, not through the implementation under test.

| Vector | Required distinction |
| --- | --- |
| Initial read | Missing authority yields no sections; explicit legacy with readable zero events may yield legacy 0. Initial HTML contains no current verdict until validity is established. Hydration cannot upgrade schema 1/2. |
| Crossing arithmetic | Legacy starts −11/end −6 and +3/end +5 give grace intervals [−11,9), [3,20): full comparison 31, pre-C 11. Humans −6,+12 give post-C estimated 24; execution [−9,4), [2,16) gives runtime 16, not lane sum 18. Never 35 or 40 as merged working time. |
| Boundary/rounding | End at C gives 0, start C gives positive elapsed time; pending gives no runtime. Two disjoint contributing 40-second intervals give 80000 ms → 1 minute, not 0. Wholly future is unavailable, elapsed empty is ready 0. |
| Runtime-only/target failure | Readable no engagement, runtime 16, unknown coverage gives observed estimated 0/runtime 16. Target read failure removes estimated data, runtime can remain 16. Required disclosure read failure removes both; unknown synchronization alone removes neither. |
| Overrides | Sunday legacy 11/240, Monday estimated 24/480 remain separate. Generic Monday override 0 removes comparison; legacy positive work with target 0 remains OVER. Never 35/720. |
| Initial/refresh version skew | Old initial HTML plus new bundle has no current claim; new initial report followed by schema-1 refresh retains only snapshot or refuses. Unsupported nested enum/version never installs partial data. |
| Refresh failure | Ready estimated 24 and runtime 16 become stale targetless snapshots; queued synchronization becomes unknown. Previously unavailable section stays payload-free. Initial failure with no cache never creates zero. |
| Selection/session race | Request A for 7 days returns after newer 30-day request B: A cannot replace B. Logout/login during A clears cache and rejects A; changing filter during an in-flight request cannot label A's totals as that filter. |
| Release/C race | Calculate C−2 ms, final release C+1 ms: recompute or unavailable. Pre-C packet delivered after C cannot become current merely because server release preceded C. Client without deadline proof withholds progress. |
| Cache/head race | Same as-of, late execution end changes runtime 0→4; cache must revalidate inputs. Target override changes 480→240 during computation: never combine old denominator with new numerator. Old replica/head, missing witness or restored pre-approval backup refuses current delivery. |
| Expiry/resume | Armed legacy cached before C; browser sleeps through C or deadline: no current verdict on wake/bfcache restore. Wall clock moved backward or absent trust cannot extend validity. Active authority does not revert on refresh failure. |
| Privacy/rollback | Sentinel private IDs and tokens absent from JSON, DOM attributes, accessibility, caches and logs. Old binary able to read schema 8 but unable to fence authority cannot serve current reports. Ingestion/queues remain intact. |

Before release of an implementation, pin wire versions/limits/errors, authenticated deadline/client
proof, complete dependency snapshot and private cache rules; execute all vectors plus existing legacy
characterization and 5Q/R reconciliation; verify initial/refresh/retained/unavailable DOM and accessible
text, not just screenshots or aggregate counts. Prove every old target consumer is fenced before
arming. Review all source paths for privacy and retain independent sanitized evidence.

Implementation remains blocked on 5R/S/Y commit authority, trusted time and recovery interfaces,
compatible report/target consumers and owner gate acceptance. 5P OIDC and 5W native support blockers
remain; missing coverage is not invented. Authority persistence, owner operations, project controls,
rich view/filter codecs, wire transport and rollout rehearsal are separate slices. Returning to
legacy after C requires a separately reviewed owner policy, never cache fallback or deleting C.
Rollback retains accepted records/queues and schema-8-aware prerequisites plus future reader/client/
recovery floors; pause delivery rather than downgrade or silently restore legacy accounting.

Only this document and ROADMAP change. They do not match the main-push
[service publication paths](../.github/workflows/publish-service.yml); this slice is publication-neutral.
The cumulative prerequisite archive includes service/schema changes and is not publication-neutral.
No TypeScript, runtime, schema, API, dashboard, client, target, config, workflow, shared-state mutation,
production access, push, publication, deployment, cutover selection or activation is authorized.
