# Cukup

Cukup tells Zain whether Amp-backed work time is under, complete, or over the hours due. The current epicenter is a personal Amp plugin that records `agent.start` and `agent.end`, infers work with a 15-minute idle grace, unions overlapping turns, and reports today's status.

## Current status

Only the local vertical slice exists today. It stores minimal event evidence in executor-local SQLite at `${XDG_STATE_HOME:-~/.local/state}/amp-work-hours/state.sqlite`. It does not aggregate across machines or fresh orbs, and no shared service, credential authority, deployment, or publication is live.

The privacy boundary excludes prompts, responses, titles, repository paths, and account data. The local database contains only timestamps, Amp thread/message identifiers, event kind/status, and the weekday target. A future shared protocol must use random source/session identifiers and must not transmit those local Amp identifiers.

## Repository ownership

This repository is the canonical development source for the plugin and any future service, architecture, and deployment code. The Amp Global User Plugins repository is only the reviewed publication target. Fleet tracks cross-machine coordination and rollout:

- [Fleet #30](https://github.com/zainfathoni/fleet/issues/30) — parent architecture and acceptance record
- [Fleet #31](https://github.com/zainfathoni/fleet/issues/31) — future shared service and deployment
- [Fleet #32](https://github.com/zainfathoni/fleet/issues/32) — plugin productionization and publication
- [Fleet #33](https://github.com/zainfathoni/fleet/issues/33) — fleet and fresh-orb rollout

See [ADR 0001](docs/adr/0001-repository-ownership.md) for the ownership boundaries.

## Development

[Bun](https://bun.sh/) 1.3.10 is pinned as standalone development tooling. Amp supplies its own Bun runtime when it executes published plugins; installing Bun from this repository is not a production plugin prerequisite.

```bash
bun install --frozen-lockfile
bun run check
```

The build output under `dist/` is disposable and is not the publication source. Publish the reviewed `plugin/` implementation through the Amp Global User Plugins repository; do not edit the deployed copy as a second canonical source.

## Provenance

The initial six files under `plugin/` were transferred byte-for-byte from the uncommitted `work-hours/` vertical slice developed in the canonical Amp User Plugins checkout. Typechecking against the pinned current Amp API then required the `agent.start` handler to return an empty result; that semantics-neutral compatibility correction is the only implementation change in this migration. Cukup is now the source of truth without treating the deployment repository as development history.
