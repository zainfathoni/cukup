# Stage 5M: pure synchronization disclosure projection

`projectShadowDisclosures(records, coverage, report, synchronization)` now accepts a separate array
of Stage 5K classified reads. Each value pairs one registered collector/site lane with either
`{state:'unknown'}` or the fresh Stage 5K snapshot returned for that exact lane. This is a pure value
boundary: projection does not open SQLite, sample a clock, inspect receipt/expiry timestamps, or call
`Date.now()`.

Stage 5K remains the sole owner of trusted UTC sampling, half-open expiry, failed reads, malformed
stored rows, backward/untrusted clocks, and requested-site matching. All of those conditions reach
projection only as `unknown`. A `fresh` value projects exactly `clear`, `queued`, `retrying`, or
`blocked` when its collector identity matches the lane. Duplicate, malformed, mismatched, or absent
inputs fail closed to `unknown`; no receipt or plausible timestamp can manufacture freshness.

## Lane and metric isolation

The supplied registered identity creates a status-only lane even when that collector/site is absent
from the evidence and coverage snapshots. An evidence/coverage lane keeps its accepted site when a
synchronization input names the same collector at another site, and its status remains `unknown`.
Conflicting sites cannot establish a status-only lane, regardless of input order. Collectors are never
merged through a common site.

Synchronization is current context. Report and cutover bounds still shape the lane's occurrence
intervals, loss facts, and pending-start cohort, but they do not clip or historically reconstruct the
fresh synchronization value. Spool records and bytes are intentionally not copied into disclosures,
project attribution, Stage 5E/5F totals, capability assessment, loss, pending execution, availability,
or legacy v1/v2 reporting. Inputs are read without mutation.

## Scope and publication

This slice adds no public or HTTP schema, dashboard or report caller, client invocation, clock-trust
activation, migration, persistence, collector/OIDC design, backfill, cutover activation, deployment,
or production access. The default omitted synchronization input preserves `unknown` for existing
callers. Stage 5K's owning read boundary additionally validates retained content and exact
receipt/expiry invariants before returning `fresh`, so constraint-bypassing corruption fails closed.
Tests cover all four fresh states, status-only lanes, unknown/failure cases, exact site and collector
isolation, occurrence independence, unchanged totals, and frozen input snapshots.

The changed `service/**` paths match the existing main-push service publication workflow, so Stage 5M
is not publication-neutral even though it has no production importer. Push, publication, deployment,
and any production or shared-setting change require separate authorization.
