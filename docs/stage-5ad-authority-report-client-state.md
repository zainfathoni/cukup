# Stage 5AD: inactive authority-report client state

Status: **complete inactive pure-state slice**. [`service/authority-report-client-state.ts`](../service/authority-report-client-state.ts)
implements only Stage 5AA's local session, exact-range, request-generation, settlement, and
same-snapshot retention rules. It allocates opaque identity-free session epochs, creates canonical
version-1 request bytes, and reduces explicit caller events. It performs no fetch, cancellation,
HTTP routing, timing, visibility subscription, authentication, persistence, rendering, fallback,
or browser integration, and no runtime or bundle imports it.

Every admitted read increments one monotonic safe-integer generation and captures the opaque session
epoch plus the codec-admitted canonical range. A new read returns the prior active identity so its
caller may cancel it; the module itself performs no cancellation. A range change clears the sole
snapshot slot. Settlement requires the latest active session/generation/range tuple, so old responses
and failures cannot replace or stale newer results. Exhaustion clears state without wrapping.

Response bytes enter only through `decodeAuthorityReportResponse`. Only a codec-valid HTTP 200
snapshot installs. A codec-valid 503 unavailable report is a fixed `report_refused` failure and never
refresh success; malformed, oversized, semantically invalid, status-mismatched, current-capable,
target/comparison-bearing, or legacy-shaped data never installs. Failures retain only the exact
same-session/range snapshot object, preserving its original as-of, cutover, labels, target-none, and
unknown-synchronization semantics. Session replacement/logout and hide/pagehide clear the slot and
active request. Resume/reconnect has no implicit action and requires a fresh explicit begin.

Inputs retained by state are copied and frozen; decoded snapshots are recursively frozen. Failure
and result categories are fixed strings. No raw body, response bytes, error, cookie, account/session
identifier, range diagnostic, or private identity is retained or exposed. The opaque epoch contains
no data and exists only for in-memory equality.

Focused tests cover asymmetric request races, same-generation range/session mismatch, logout/login,
range replacement, old failure after new success, 200 versus 503, strict malformed/oversized/nested
rejection, same-snapshot retention, mutation resistance, generation exhaustion, hide/resume, and
rejection of legacy/current/target/comparison promotion.

This isolated `service/**` module is inactive but publication-sensitive under the existing main-push
workflow. No push, publication, deployment, migration, production access, route, consumer, or
activation is authorized. Rollback removes only this module, its test, this document, and its ROADMAP
entry while preserving the cumulative schema-8 prerequisite baseline and its recovery precautions.
