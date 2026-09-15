# Stage 5AC: inactive pure authority-report builder

Status: **complete inactive pure-builder slice**. [`buildAuthorityReportSnapshot`](../service/authority-report-builder.ts)
constructs only Stage 5AA version-1 stale snapshots and payload-free refusals, then validates and
canonically encodes every successful result through the Stage 5AB codec. It has no production
importer, route, authentication, store read, clock/provider access, dashboard/client dependency,
selected cutover, current-use permission, or activation behavior.

## Caller-classified input

The caller supplies one internally consistent snapshot with an exact millisecond request range,
explicit unresolved/verified authority, verified mode (`legacy`, `armed`, or `active`), cutover and
as-of assertions, and the exact expected legacy/generic partitions. Unresolved authority always
produces the closed `authority_unavailable` refusal and never falls back to supplied legacy data.
Verified partitions must exactly match the range split at a valid Jakarta Monday-midnight cutover;
only active authority may provide generic values. Armed elapsed generic partitions remain
payload-free unavailable.

Available metrics contain one nonnegative safe-integer `globallyUnionedMilliseconds` value. It must
already represent the complete caller-classified metric snapshot, globally unioned and clipped to
that exact authority range and as-of, and cannot exceed that partition's elapsed span. The builder
never accepts lanes or intervals to total, never adds legacy and generic, never adds runtime and
working time, and never sums non-additive lanes. It floors each authority/metric value once to
minutes. Thus an elapsed available zero becomes stale observed zero, unavailable remains payload-free,
a wholly future unavailable partition becomes `not_started`, and an already globally unioned
80,000 ms becomes 1 minute.

Generic disclosure input is the existing Stage 5N delivery over labeled Stage 5I/M lanes. Required
disclosure unavailability withholds both generic metrics while an independent legacy metric may
survive. Available disclosures pass through `deliverShadowDisclosures('stale', ...)`, so every
synchronization value is `unknown`. Projection copies only the Stage 5AA display fields and removes
collector, site, fact, evidence, and segment identities. The Stage 5AB codec remains the source of
truth for label safety, closed capability semantics, clipping, collection limits, and response size.

These are untrusted caller assertions, not proofs. This boundary does not establish a recoverable
authority read, trusted time, freshness, clipping/union provenance, release authorization, or current
validity. Every success has `current_use: forbidden`, null deadline/proof, targetless stale metrics,
and canonical codec bytes. Malformed ranges/partitions/modes/totals fail with `invalid_input`;
codec-invalid or oversized output fails closed without a partial envelope.

## Verification, publication, and rollback

Focused tests cover crossing, generic-only, and legacy-only partitions; independent 31/11 legacy,
24 estimated, and 16 runtime arithmetic; floor-once 80,000 ms; zero/unavailable/not-started;
required-disclosure withholding; synchronization redaction and identity removal; invalid authority
partitions, ranges, cutovers, labels, totals and limits; exact codec admission; and frozen input/no
aliasing behavior. This remains insufficient for activation: Stage 5R/S/Y authority, recovery,
trusted-time, serialized release, owner-session transport, consumers, and rollout gates are deferred.

The new `service/**` files match the main-push service-publication workflow, so this inactive slice
is publication-sensitive. No push, publication, deployment, migration, production access, cutover,
or activation is authorized. Rollback removes only this builder, its focused test and documentation;
it must retain cumulative prerequisite schema-8 data and all prior rollback precautions.
