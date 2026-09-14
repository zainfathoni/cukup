# Stage 5I: pure internal shadow disclosures

`projectShadowDisclosures(records, coverage, report)` consumes complete accepted snapshots from
`ServiceStore.shadow.records()` and `coverageRecords()`. It returns collector/site lanes, not an
account-wide completeness value. It has no persistence or runtime dependency, production caller,
HTTP/public schema, duration sum, dashboard, or activation. Stage 5E/5F totals and non-additive lanes
remain separate and unchanged, as do legacy v1/v2 rows and summaries.

## Occurrence bounds and source identity

The report uses the existing `Interval` type: finite UTC epoch-millisecond `startMs` and `endMs`,
half-open. The internal caller supplies already resolved civil/as-of bounds (using the existing civil
helpers where needed); there is no new civil-calendar implementation. Optional `cutoverMs` is an
already approved and validated Stage 5F Monday 00:00 Asia/Jakarta instant. This lower-level projection
only applies `max(startMs, cutoverMs)`, not cutover validation, selection, persistence, or activation.
An empty/clipped-away interval returns no lanes.

For nonempty bounds every collector found in either complete snapshot gets its own lane, even if its
only accepted facts are outside the interval. Such a lane can contain only unknown assessments and
empty disclosure lists. No collector identity is inferred from a site, and evidence capability
snapshots never establish prospective declarations. Callers must not prefilter snapshots by report
or receipt time: earlier declarations and later accepted ends are needed for reconstruction.

Declarations apply from effective occurrence time to the next effective declaration for that
collector. Before the first declaration capability is `unknown`. Equal-effective/same-set facts
produce one assessment interval, without modifying or deleting their persisted identities. Stage 5H
already rejects different sets at the same effective instant. Receipt and source order do not govern
these intervals. Working Time v1 requires exactly the five base engagement capabilities; Agent Runtime
v1 requires `execution.segments`. Missing recovery capabilities are listed separately for each metric;
they do not affect base assessment or promise continuous observation. `process.lifecycle` satisfies
neither metric. Unknown assessment does not invent a missing-capability set.

## Independent dimensions, never durations

- `collectionIntegrity.losses` contains `known_loss` only for explicit accepted irreversible-loss
  facts intersecting the clipped lane. Each retains its fact ID, exact affected capabilities, bounded
  reason, and independently clipped interval; collector/site are inherited from the containing lane.
  Adjacent/overlapping facts are never unioned. `otherwise: unknown` applies outside those intervals
  and to capabilities not named by the loss facts. Gaps, silence, receipts, pending starts and local
  backlog never synthesize loss.
- `executionClosure.starts` contains only accepted starts whose original occurrence lies within the
  clipped lane and which lack an accepted end in the complete snapshot. Each retains evidence ID,
  segment ID and original start occurrence; collector/site are inherited from the lane. This is a
  report-start cohort, not an assertion about all currently open executions. Starts before the lower
  bound are not moved to it. Any accepted end clears its collector/segment, including late receipt
  or an occurrence beyond the report end. An end cannot close another collector's same segment UUID.
  `none_pending` means only no matching pending starts; pending contributes no runtime and is not loss.
- `synchronization` is always exactly `unknown`. No reviewed server-visible spool observation exists.
- Availability (`ready`/`stale`/`unavailable`) remains entirely a consumer wrapper. Successful pure
  projection supplies none of those states. Empty arrays mean only no accepted matching disclosure
  facts, not completeness, no work, actual attention, or an empty spool.

## Verification and remaining scope

Asymmetric tests use real disposable ServiceStore acceptance and Stage 5G cases 1–8 and 11 where facts
exist: converse same-site capabilities; out-of-source-order/equal-effective declarations; unknown,
between and after intervals; report/cutover half-open edges; explicit overlapping/adjacent losses;
sequence gaps and unrelated engagement; late closure; identical segment UUID isolation and fresh
same-site identity; receipt invariance; frozen snapshot, stored fact, legacy v1/v2 and metric stability.
Cases 5/6 test only currently implementable unknown synchronization, not invented spool observations.
Case 9 availability delivery and case 10 protocol/privacy rejection remain with their owners (Stage 5H
already tests accepted-fact validation). No retry/cache, spool protocol, collector, schema/migration,
target comparison, public report schema, OIDC/Amp-orb design, backfill, or support claim is added.

This slice adds no migration, but its `service/**` paths match the existing main-push service
publication workflow: it is **not publication-neutral**. Prerequisite Stage 5H schema-7 migration and
rollback constraints still apply separately. No push, publication, deployment, production access,
shared database operation, or cutover activation is authorized or performed.
