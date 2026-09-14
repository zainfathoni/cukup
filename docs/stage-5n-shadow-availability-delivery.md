# Stage 5N: pure shadow availability delivery

`deliverShadowDisclosures(availability, disclosures)` is the internal delivery boundary for Stage 5M
shadow disclosures. It is pure: it does not read a clock, persistence, cache, HTTP request, or public
report. A `ready` delivery may expose the supplied current `clear`, `queued`, `retrying`, or `blocked`
synchronization value. A `stale` delivery retains every other cached disclosure dimension but replaces
each lane's synchronization with `unknown`. An `unavailable` delivery carries no disclosures because
Stage 5G defines it as having no usable current or retained result, and therefore cannot expose a
cached synchronization value.

Availability remains orthogonal to capability assessment, known loss, execution closure, and
synchronization health. The boundary does not infer completeness, work, loss, pending closure, or a
synchronization value from availability. Existing `unknown` synchronization remains `unknown`.
Inputs are read without mutation, and stale redaction creates new lane values while preserving the
other disclosure values unchanged.

This slice adds no dashboard/report schema, rendering, route, browser cache, caller, scheduling,
Stage 5D invocation, trusted-clock activation, persistence/migration, collector/OIDC design, backfill,
cutover, or production access. Failed, expired, malformed, or untrusted Stage 5K reads still enter
Stage 5M as `unknown`; this boundary cannot restore them. A future cache/report owner must invoke this
boundary at delivery time rather than directly serving cached Stage 5M lanes.

The changed `service/**` paths match the existing main-push service-publication workflow, so this
internal slice is not publication-neutral despite having no production importer. No push,
publication, deployment, shared-setting change, or production operation is authorized or performed.
