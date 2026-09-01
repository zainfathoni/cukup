---
status: accepted
---

# Add a personal dashboard with explicit activity attribution

Cukup will add a single-owner dashboard at `cukup.dev` while retaining `api.cukup.dev` as the ingestion boundary. The existing Bun service and SQLite authority will serve both hosts; browser access uses GitHub OAuth restricted by immutable GitHub user ID, secure seven-day sessions, and no browser-visible machine bearer. The dashboard is read-only and shows overall Working Time, non-additive Project Activity, non-additive Executor Activity, and executor last-activity/credential state without analytics or sensitive logging.

Project attribution is an explicit optional Project Slug: a lowercase kebab-case identifier stored in Amp workspace-scoped plugin configuration and durably snapshotted with event schema at turn start. Event schema v2 carries the optional slug; v1 remains accepted and historical project-less evidence stays Unassigned. Physical Executor Labels come from canonical Fleet hostnames, are validated against a deployment allowlist, and bind once to one active Bearer Lineage rather than being trusted per event. OIDC-owned sources use `amp-orb`. Historical executor attribution is derived through stable source ownership across rotating bearer credentials without rewriting events; unlabeled physical history remains visible as `unassigned-executor`.

## Approved target-override addendum

The narrowly approved day-off workflow does not turn the dashboard into an editor. An authenticated API-host boundary, available to the same personal bearer and allowed workload OIDC principals as the service, may set one exact Asia/Jakarta civil date's authoritative target to zero or explicitly clear it. The request is closed and stores only date, zero target, and audit timestamps—never a free-text reason. The plugin exposes the validated, previewed, confirmed `cukup: Set day off` workflow; dashboard routes remain read-only.

Overrides affect only authoritative target calculation. Evidence and worked minutes remain immutable, so zero work against target zero is `COMPLETE` and positive work is `OVER`. Both schema-1 `/v1/summary` and the dashboard schema-1 Overall Working Time panel use the same daily and Monday-week target reduction; clearing restores the default target. Filtered Project and Executor activity remains targetless and unaffected. Dynamic mutation routes are logged only as a route template without dates or bodies. SQLite v3 adds the override table through restart-safe migration from supported v1 and v2 databases and includes it in the existing verified backup and clean-restore boundary.

## Considered alternatives

- Raw workspace paths, Git remotes, and inferred project names were rejected because project disclosure must be explicit.
- Opaque per-workspace IDs were rejected in favor of deliberate, cross-machine Project Slugs.
- Per-event machine claims and ephemeral orb hostnames were rejected because executor identity belongs to the authenticated principal.
- Heartbeats were rejected because inactivity is not evidence of machine health.
- A separate dashboard service and frontend framework were rejected because they would add deployment and runtime boundaries without current product value.
- Splitting concurrent time between projects was rejected because Cukup cannot observe human attention allocation; project and executor series are therefore explicitly non-additive.

## Consequences

- Dashboard filters never affect the authoritative overall target classification; filtered project/executor views are targetless.
- Existing physical credentials can bind in place on first v2 sync, and rotations carry their label and source ownership forward.
- Every queued event retains its original schema and Project Slug. The service must accept mixed v1/v2 replay permanently after v2 emission; a migration-aware build becomes the rollback compatibility floor.
- Dashboard and ingestion share a process but use host-first route dispatch, distinct credential types, independently disabled dashboard configuration, and a host-only dashboard cookie.
- Dashboard filters containing Project Slugs or Executor Labels stay out of URLs and logs.
- Deployment requires a GitHub OAuth application, protected runtime secrets, the canonical Fleet hostname allowlist, and a separately gated `cukup.dev` DNS/TLS cutover.
