# Stage 5E: internal shadow aggregation

This slice implements prospective ADR 0007 measurements as pure internal functions in `service/shadow-aggregation.ts`. No production caller imports them. **No authoritative measurement or dashboard exists for these metrics.** Legacy v1/v2 aggregation, summaries, records, routes, and targets remain unchanged.

## Input and result contract

`buildShadowIntervals(records, asOfMs)` consumes one complete accepted Stage 5A `ServiceStore.shadow.records()` snapshot. It is not an ingestion validator or a wire API. Callers must not prefilter records by receipt date, occurrence date, project, or site: a window or execution start outside the requested period can overlap it. Source sequences govern persistence acceptance, not report order. The function returns separate, un-unioned attributed intervals for `workingTimeEstimated` and `agentRuntime`, capped at `asOfMs`. These intervals preserve the source snapshot's project attribution (including mapping basis or Unassigned reason) and stored execution-site ID; returned attribution objects do not alias input objects.

- Only explicit accepted human engagement opens a 15-minute elapsed-time window. Every accepted interaction renews the window through its occurrence plus 15 minutes. No execution or process lifetime extends Working Time.
- Runtime requires both accepted execution endpoints paired by collector ID and segment ID. Its interval uses their wall-clock occurrence times, without grace, crash caps, fabricated closure, or receipt/finalization timestamps. Pending starts and unmatched endpoints contribute no duration. The parser does not admit process-lifetime evidence. Explicit approval waits are excluded by separate collector-produced execution segments, not inferred here.
- `asOfMs` limits elapsed contribution, not knowledge. Even accepted evidence within the parser's future-clock tolerance cannot contribute ahead of it. A late accepted end may revise an earlier report, including when its receipt is later than `asOfMs`; this is not an “as known then” audit API.

`summarizeShadow(records, { asOfMs, date, period, timezone })` reports the civil day or Monday-based week containing `date`. Callers supply a valid civil date, IANA timezone, and finite epoch-millisecond as-of. Period boundaries use the existing generic civil-time helpers, including DST; intervals are half-open and clipped to the period and as-of. The returned `startMs` and `endMs` identify the full civil period, not the as-of-clipped end.

The result holds independent global `workingTimeEstimatedMs` and `agentRuntimeMs` totals, plus project and execution-site lanes. Every total unions its own underlying intervals; global totals never sum or apportion lane totals. Lanes can overlap and are **non-additive**, as are the two metrics. Project lanes use stable project IDs, with `null` for Unassigned; they do not merge names or look up current mappings. Execution attribution belongs to its start even if later engagements change mapping. Each lane exists only when an interval contributes positive duration in that period. No display labels or mutable attribution lookup is introduced.

Only generic interval union and civil-time helpers are reused from `aggregation.ts`; legacy session construction, grace/crash caps, target comparisons, and summary formulas are not called or changed.

## Verification and limitations

Focused tests use accepted SQLite-backed fixtures and independently calculated asymmetric expectations: repeated and touching engagement windows across collectors/projects/sites; overlapping and disjoint closed execution; a 55-minute approval gap; pending and zero-length execution; collector-scoped segment IDs; delayed uploads across Jakarta midnight/Monday; future-within-skew clipping down to a one-millisecond boundary; 23/25-hour DST days and cross-week intervals; non-additive lanes, Unassigned retention, and receipt-time independence. A disposable service fixture checks input, persisted shadow, legacy v1/v2 rows, and legacy summary equality after aggregation and mutation of a derived attribution copy.

This is an in-memory internal reporting boundary, not a materialized aggregate, public summary schema, coverage model, or completeness claim. Empty or zero output means no contributing interval in the supplied snapshot, not proof of no work. Pending-versus-absent disclosure remains available through Stage 5A records/segments and is not flattened into invented coverage counts here. Future dashboard consumers must supply coverage and synchronization disclosure before interpreting these totals.

No HTTP route, collector change, OIDC/Amp-orb site design, target comparison, cutover date or cutover clipping, historical backfill, migration, deployment, or authority change is included. Those remain separately reviewed slices.

## Publication implications

The functions are not connected to a production entrypoint and add no schema or runtime activation. Nevertheless, **this diff is not publication-neutral**: its `service/**` paths match the existing main-push service-publication workflow. An eventual push may publish a service image and requires explicit owner approval. The transferred Stage 5A/5B prerequisites retain their separate schema/publication implications. No push, publication, deployment, shared setting change, or production access is authorized or performed by Stage 5E.
