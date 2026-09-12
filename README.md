# Cukup

**Cukup is a privacy-first WakaTime for AI-assisted work.** It automatically measures work with AI agents across projects, machines, and cloud sessions without collecting prompts or source code.

Today Cukup reports whether Amp-backed Working Time is under, complete, or over the hours due. Its accepted product direction separates interaction-based estimated Working Time from evidenced Agent Runtime through a generic boundary and independently maintained Harness Adapters. The [experimental local evidence message contract](docs/experimental-local-harness-evidence-protocol.md) has conformance fixtures, but no receiver or new metric is deployed; current production remains Amp-only v1/v2.

## Current status

The Amp plugin stores minimal evidence in executor-local SQLite at `${XDG_STATE_HOME:-~/.local/state}/amp-work-hours/state.sqlite` and synchronizes through a transactional outbox. The production Bun service at `api.cukup.dev` is the shared SQLite authority; the single-owner dashboard at `cukup.dev` provides GitHub-authenticated reporting. Event schemas v1/v2, exact Amp Project attribution, physical-machine profiles, workload OIDC, target overrides, verified backup/off-site retrieval, and protected automatic deployment are live.

The shared privacy boundary excludes prompts/content, host/user/fleet identity from events, model names, repository identifiers, paths, Amp Project IDs, and local Amp thread/message IDs. Shared events use random source/session UUIDs and may carry only an optional v2 Project Slug normalized from the exact Amp Project name; physical Executor Labels bind separately to authenticated Bearer Lineages. Amp workload JWT claims are a transient authentication-layer exception and never enter shared event records or logs.

The service release workflow runs only when a `main` change touches an image input (`service/`, `Dockerfile.service`, `package.json`, `bun.lock`, or `tsconfig.json`), or when an operator dispatches it manually. Documentation, plugin-only, and other non-image changes therefore create no service image or release version. The protected off-site operator operator follows the newest successfully published service revision that remains an ancestor of signed `main`, rather than assuming every `main` SHA has an image.

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

Start with the [product vision](docs/product/vision.md), [domain language](CONTEXT.md), and [roadmap](ROADMAP.md). [ADR 0007](docs/adr/0007-generic-harness-evidence-boundary.md) records the accepted generic evidence boundary and supersedes ADR 0006. [Tycho collector guidance](docs/tycho-adapter.md) records candidate integration constraints, not an accepted upstream contract. GitHub issues own executable work; Fleet remains limited to cross-machine rollout and operations.

## Development

[Bun](https://bun.sh/) 1.3.10 is pinned as standalone development tooling. Amp supplies its own Bun runtime when it executes published plugins; installing Bun from this repository is not a production plugin prerequisite.

```bash
bun install --frozen-lockfile
bun run check
```

The build output under `dist/` is disposable and is not the publication source. Publish the reviewed `plugin/` implementation through the Amp Global User Plugins repository; do not edit the deployed copy as a second canonical source. The shared service can be built independently with `bun run build:service` or `Dockerfile.service`; release and recovery boundaries are documented in the [operations runbook](docs/service-operations.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution readiness, architecture, privacy, and review requirements. Cukup is available under the [MIT License](LICENSE).

## Provenance

The initial six files under `plugin/` were transferred byte-for-byte from the uncommitted `work-hours/` vertical slice developed in the canonical Amp User Plugins checkout. Typechecking against the pinned current Amp API then required the `agent.start` handler to return an empty result; that semantics-neutral compatibility correction is the only implementation change in this migration. Cukup is now the source of truth without treating the deployment repository as development history.
