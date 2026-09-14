# Stage 5O: shadow disclosures dashboard

The authenticated dashboard report now has schema version 2 and one independent
`shadow_disclosures` panel. Its selected occurrence window follows the dashboard's 7-, 30-, 90-day,
or custom trend range and is clipped by the report builder's existing server-owned `nowMs`. The
service reads registered collector/site lanes, supplies Stage 5K-classified synchronization reads to
the Stage 5M projection, and passes the result through `deliverShadowDisclosures('ready', ...)`.
Dashboard code does not inspect synchronization timestamps, infer freshness, or call `Date.now()`.

The public panel replaces private collector/site UUIDs with an existing Executor Label when that
label uniquely identifies the execution site. Ambiguous or unlabeled lanes receive deterministic
display-only ordinals; raw collector/site, evidence, segment, fact, project, bearer, and profile
identities do not cross the report boundary. Capability intervals retain explicit declared,
declared-limited, and unknown assessments. Known losses retain only their interval, reason, and
affected capability names. Pending execution retains occurrence times but no evidence identities.
Synchronization exposes only `clear`, `queued`, `retrying`, `blocked`, or `unknown`. Spool records,
bytes, and additive disclosure totals are absent.

## Availability and browser retention

A successful empty projection is `ready` with no lanes. The renderer says that no accepted matching
disclosure facts or current status lanes were found and explicitly does not claim complete coverage
or no work. A failed disclosure query makes only this panel `unavailable`, carries no data, and
renders no lanes or zero. A wholly future custom range is also payload-free unavailable rather than
a reversed ready-empty interval. Other dashboard panels retain their existing behavior.

When a whole browser refresh fails, the controller retains usable disclosure dimensions but invokes
`deliverShadowDisclosures('stale', retainedLanes)` at delivery time. Every retained lane's
synchronization is therefore `unknown`, including values previously delivered as clear, queued,
retrying, or blocked. Losses, capability assessments, and pending execution remain visible with a
stale notice. An already unavailable panel remains unavailable and receives no retained payload.
The browser normalizes a schema-1 report from mixed-version serving into the preserved legacy panels
plus a payload-free unavailable disclosure panel; unsupported report versions are rejected before
they replace retained state.

This panel is disclosure-only and never contributes to Working Time, timeline, trend, project,
executor, or Stage 5E/5F totals. It does not schedule the Stage 5L client, invoke Stage 5D, activate a
trusted production clock, select a cutover, change evidence or coverage ingestion, migrate a schema,
design OIDC collector sites, backfill history, switch authority, or establish collector support.

## Publication boundary

The slice changes `service/**`, including the existing runtime dashboard path, so it is not
publication-neutral. The default production synchronization clock remains untrusted and therefore
would disclose synchronization as unknown until a separately reviewed trust provider exists. No
push, image publication, deployment, shared-setting change, production access, or migration is
authorized or performed by this slice.
