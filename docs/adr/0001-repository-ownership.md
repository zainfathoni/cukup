# ADR 0001: Repository ownership and deployment boundaries

- Status: Accepted
- Date: 2026-08-30

## Context

The first Cukup vertical slice was developed as an uncommitted `work-hours/` directory in Zain's Amp Global User Plugins checkout. That proved the local tracking semantics, but a deployment repository is the wrong owner for future service, architecture, and deployment work. Fleet issues [#30](https://github.com/zainfathoni/fleet/issues/30)–[#33](https://github.com/zainfathoni/fleet/issues/33) coordinate the intended cross-machine system, but Fleet is not an executable application repository.

The current implementation is local-only. There is no shared HTTPS service, authoritative cross-machine database, credential authority, service deployment, or fleet rollout.

## Decision

1. `zainfathoni/cukup` is the canonical development source for the Amp plugin and any future service, architecture, deployment configuration, and operational documentation.
2. Zain's Amp Global User Plugins repository is a publication and deployment target only. Reviewed plugin code flows from Cukup into that repository; changes must not flow back as an independent development line.
3. `zainfathoni/fleet` owns cross-machine coordination, rollout state, and acceptance tracking through issues #30–#33. It does not own executable plugin or service code.
4. No shared service or authority is deployed by this migration. Service implementation remains explicitly out of scope.
5. Amp supplies the Bun runtime used to load and execute plugins, including `bun:sqlite`. A separately installed Bun CLI is required only for repository development tasks such as dependency installation, tests, type checking, and builds.
6. The proven local semantics and privacy boundaries remain unchanged during migration.

## Consequences

- `plugin/` is the only current executable product directory.
- Future service or deployment directories are added only when their implementation begins; this migration creates no empty scaffolding for them.
- Publication requires an explicit reviewed transfer to the Amp Global User Plugins repository and its normal signed publication workflow.
- Fleet issue updates link back to Cukup rather than duplicating implementation state.
- Local SQLite remains executor-local evidence, not a shared authority.
