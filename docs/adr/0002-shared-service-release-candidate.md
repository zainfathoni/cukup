# ADR 0002: Shared service release-candidate authority

- Status: Accepted
- Date: 2026-08-30

## Context

[ADR 0001](0001-repository-ownership.md) moved development but did not deploy a service. Fleet #31 required a reviewed release candidate before infrastructure, credential, or rollout changes.

## Decision

Use one Bun service and one authoritative SQLite database. SQLite suits the current personal write volume. It requires one service writer, a persistent volume, verified backups, and restore drills.

Keep evidence immutable. Accept delayed evidence so offline executors can converge. Report clock errors and conflicts instead of rewriting accepted timestamps.

Use separate credentials for physical machines and Amp workload identity for orbs. Keep source identities random. Authentication claims must not become stored work identity.

Keep the historical time policy: Asia/Jakarta, Monday weeks, eight-hour weekdays, 15-minute completed-turn grace, and 15-minute unmatched-start caps. These are product choices, not measurements of attention.

Require verified online backups and clean restore tooling before release acceptance. Code alone does not establish off-site protection; [ADR 0003](0003-off-site-sqlite-backups.md) selects the recovery site.

Deployment remains a separate approved action. Keep Cukup's container and Kamal assets separate from other applications.

## Consequences

- OIDC discovery depends on Amp's identity endpoint. Authentication must fail closed when verification fails.
- Credential rotation must preserve source ownership without rewriting evidence.
- Clients must retain evidence until the service confirms acceptance or exact replay.

Read [API source references](../service-api.md) for wire formats and validation. Use [service operations](../service-operations.md) for release and recovery procedures.
