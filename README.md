# Cukup

Cukup tells Zain whether Amp-backed work time is under, complete, or over the hours due. It contains a personal Amp plugin and a release-candidate shared authority that accepts privacy-preserving events, unions work globally, and reports authoritative daily and weekly status.

## Current status

The local plugin vertical slice stores minimal evidence in executor-local SQLite at `${XDG_STATE_HOME:-~/.local/state}/amp-work-hours/state.sqlite`. The `service/` release candidate adds the Fleet #31 HTTPS API, persistent shared SQLite authority, physical-machine bearer lifecycle, Amp workload OIDC, timezone aggregation, verified backup/restore tooling, and the host-isolated single-owner dashboard backend/UI. Nothing is deployed and no shared credential, OAuth application, DNS, TLS, backup provider, or infrastructure is live from this repository change.

The shared privacy boundary excludes prompts/content, host/user/fleet identity from events, model names, repository identifiers, paths, and local Amp thread/message IDs. Shared events use random source/session UUIDs and may carry only an explicit optional v2 Project Slug; physical Executor Labels bind separately to authenticated bearer lineages. Amp workload JWT claims are a transient authentication-layer exception and never enter shared event records or logs. See [the service API contract](docs/service-api.md), [dashboard service contract](docs/dashboard-service.md), [operations runbook](docs/service-operations.md), [ADR 0002](docs/adr/0002-shared-service-release-candidate.md), and [ADR 0004](docs/adr/0004-personal-dashboard-and-explicit-attribution.md).

## Repository ownership

This repository is the canonical development source for the plugin, service, architecture, and deployment code. The Amp Global User Plugins repository is only the reviewed publication target. Fleet tracks cross-machine coordination and rollout:

- [Fleet #30](https://github.com/zainfathoni/fleet/issues/30) — parent architecture and acceptance record
- [Fleet #31](https://github.com/zainfathoni/fleet/issues/31) — shared service and deployment acceptance
- [Fleet #32](https://github.com/zainfathoni/fleet/issues/32) — plugin productionization and publication
- [Fleet #33](https://github.com/zainfathoni/fleet/issues/33) — fleet and fresh-orb rollout

See [ADR 0001](docs/adr/0001-repository-ownership.md) for the ownership boundaries.

## Development

[Bun](https://bun.sh/) 1.3.10 is pinned as standalone development tooling. Amp supplies its own Bun runtime when it executes published plugins; installing Bun from this repository is not a production plugin prerequisite.

```bash
bun install --frozen-lockfile
bun run check
```

The build output under `dist/` is disposable and is not the publication source. Publish the reviewed `plugin/` implementation through the Amp Global User Plugins repository; do not edit the deployed copy as a second canonical source. The shared service can be built independently with `bun run build:service` or `Dockerfile.service`; deployment requires a separate explicit approval and the gates in the operations runbook.

## Provenance

The initial six files under `plugin/` were transferred byte-for-byte from the uncommitted `work-hours/` vertical slice developed in the canonical Amp User Plugins checkout. Typechecking against the pinned current Amp API then required the `agent.start` handler to return an empty result; that semantics-neutral compatibility correction is the only implementation change in this migration. Cukup is now the source of truth without treating the deployment repository as development history.
