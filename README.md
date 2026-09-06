# Cukup

Cukup tells Zain whether Amp-backed work time is under, complete, or over the hours due. It contains a personal Amp plugin and a release-candidate shared authority that accepts privacy-preserving events, unions work globally, and reports authoritative daily and weekly status.

## Current status

The local plugin vertical slice stores minimal evidence in executor-local SQLite at `${XDG_STATE_HOME:-~/.local/state}/amp-work-hours/state.sqlite`. The `service/` release candidate adds the Fleet #31 HTTPS API, persistent shared SQLite authority, physical-machine bearer lifecycle, Amp workload OIDC, timezone aggregation, verified backup/restore tooling, and the host-isolated single-owner dashboard backend/UI. Nothing is deployed and no shared credential, OAuth application, DNS, TLS, backup provider, or infrastructure is live from this repository change.

The shared privacy boundary excludes prompts/content, host/user/fleet identity from events, model names, repository identifiers, paths, Amp Project IDs, and local Amp thread/message IDs. Shared events use random source/session UUIDs and may carry only an optional v2 Project Slug normalized from the exact Amp Project name; physical Executor Labels bind separately to authenticated bearer lineages. Amp workload JWT claims are a transient authentication-layer exception and never enter shared event records or logs. See [the service API contract](docs/service-api.md), [dashboard service contract](docs/dashboard-service.md), [operations runbook](docs/service-operations.md), [ADR 0002](docs/adr/0002-shared-service-release-candidate.md), [ADR 0004](docs/adr/0004-personal-dashboard-and-explicit-attribution.md), and [ADR 0005](docs/adr/0005-derive-attribution-from-amp-project.md).

## Marking a day off

The Amp command palette entry `cukup: Set day off` changes the shared authoritative target for one Asia/Jakarta date. It defaults to today's Jakarta civil date, requires an exact real `YYYY-MM-DD`, previews **Full day off (0m)**, **Half day (4h)**, or **Clear / undo**, and asks for explicit confirmation before making an authenticated request. Full and half days set that date's target to exactly 0 or 240 minutes; clearing restores the normal weekday or weekend target. Existing work evidence and worked minutes never change. Worked time below, equal to, or above the selected target remains `UNDER`, `COMPLETE`, or `OVER`; one weekday half-day changes a standard 2,400-minute week to 2,160 minutes. The daily and Monday–Sunday weekly values in both Cukup status and the dashboard Overall panel reflect the change.

The command uses the same protected physical bearer or Amp workload OIDC credential as synchronization and never displays it. A success notification confirms the authoritative mutation; a generic failure means the service did not confirm it. The dashboard itself remains read-only. The existing **Set local fallback target** command remains non-authoritative and affects only offline fallback display.

## Repository ownership

This repository is the canonical development source for the plugin, service, architecture, and deployment code. The Amp Global User Plugins repository is only the reviewed publication target. Fleet tracks cross-machine coordination and rollout:

- [Fleet #30](https://github.com/zainfathoni/fleet/issues/30) — parent architecture and acceptance record
- [Fleet #31](https://github.com/zainfathoni/fleet/issues/31) — shared service and deployment acceptance
- [Fleet #32](https://github.com/zainfathoni/fleet/issues/32) — plugin productionization and publication
- [Fleet #33](https://github.com/zainfathoni/fleet/issues/33) — fleet and fresh-orb rollout

See [ADR 0001](docs/adr/0001-repository-ownership.md) for the ownership boundaries.

## Product direction

[The Cukup roadmap](ROADMAP.md) records the current product outcomes, including external-contributor readiness and the planned Tycho integration. GitHub issues own executable work; ADRs record durable decisions; Fleet remains limited to cross-machine rollout and operations.

## Development

[Bun](https://bun.sh/) 1.3.10 is pinned as standalone development tooling. Amp supplies its own Bun runtime when it executes published plugins; installing Bun from this repository is not a production plugin prerequisite.

```bash
bun install --frozen-lockfile
bun run check
```

The build output under `dist/` is disposable and is not the publication source. Publish the reviewed `plugin/` implementation through the Amp Global User Plugins repository; do not edit the deployed copy as a second canonical source. The shared service can be built independently with `bun run build:service` or `Dockerfile.service`; deployment requires a separate explicit approval and the gates in the operations runbook.

## Provenance

The initial six files under `plugin/` were transferred byte-for-byte from the uncommitted `work-hours/` vertical slice developed in the canonical Amp User Plugins checkout. Typechecking against the pinned current Amp API then required the `agent.start` handler to return an empty result; that semantics-neutral compatibility correction is the only implementation change in this migration. Cukup is now the source of truth without treating the deployment repository as development history.
