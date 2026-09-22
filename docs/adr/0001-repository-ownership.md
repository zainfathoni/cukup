# ADR 0001: Repository ownership and deployment boundaries

- Status: Accepted
- Date: 2026-08-30

## Context

The first Cukup slice was an uncommitted `work-hours/` directory in Zain's Amp Global User Plugins checkout. That location proved local tracking. It was not suitable for service and deployment work. Fleet issues [#30](https://github.com/zainfathoni/fleet/issues/30)–[#33](https://github.com/zainfathoni/fleet/issues/33) coordinated cross-machine work, but Fleet was not an application repository.

## Decision

1. `zainfathoni/cukup` owns plugin, service, architecture, deployment, and operations work.
2. Zain's Amp Global User Plugins repository is a publication target only. Move reviewed plugin code from Cukup to that repository. Do not develop a separate product line there.
3. `zainfathoni/fleet` owns cross-machine coordination, rollout state, and acceptance tracking through issues #30–#33. It does not own executable plugin or service code.
4. This migration does not deploy a shared service. It does not change local behavior or privacy boundaries.
5. Amp supplies the plugin's Bun runtime, including `bun:sqlite`. Repository development requires a separate Bun CLI.

## Consequences

- At decision time, `plugin/` was the only executable product directory.
- Add service or deployment directories only with their implementation.
- Publication requires reviewed transfer and the normal signed workflow.
- Fleet issue updates link back to Cukup rather than duplicating implementation state.
- At decision time, local SQLite remained executor-local evidence.
