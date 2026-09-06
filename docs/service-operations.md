# Shared service operations runbook

This runbook describes the deployed Cukup service. Following it does not by itself authorize a release, production mutation, credential operation, DNS/TLS change, restore, or rollback.

## Ownership and production baseline

The current owner assignments are:

| Responsibility | Required owner |
| --- | --- |
| Service/runtime | Zain Fathoni |
| DNS and TLS | Zain Fathoni |
| Backup schedule, retention, and off-site pull | Zain Fathoni |
| Incident response and credential revocation | Zain Fathoni |

Production runs on `rumahberbagi` behind Kamal Proxy at `api.cukup.dev` and `cukup.dev`. The linux/amd64 role is capped at half of one CPU, 256 MiB RAM+swap, and 128 processes with a read-only root filesystem. Initial deployment and subsequent releases passed public reachability, authenticated API, dashboard, restart, runtime-contract, database-integrity, preservation, and rollback-retention checks. Sustained saturation and a durable external operator-failure alert remain operational concerns.

The active recovery policy is a verified SQLite backup every six hours, seven days of local retention on `rumahberbagi`, and a daily independent SSH pull to `vikas-mac-mini`, where backup pairs are retained for 30 days. The target is RPO 24 hours and RTO 4 hours. Independent retrieval, verification, and a clean restore passed before production acceptance; repeat a clean restore quarterly. There is deliberately no B2 or other cloud object-storage dependency; see ADR 0003. Healthchecks is not configured or claimed; add an external alert only after its real delivery and owner response are verified.

## Runtime and TLS

`Dockerfile.service` builds a non-root Bun image containing the server plus database/token operator bundles. `/var/lib/cukup` is the only persistent volume. `config/deploy.service.yml` is a distinct Kamal application with hostname, host, image, registry, allowed OIDC user, and host-volume path supplied outside Git. It contains no credential values. Before first start, create the host data directory with ownership that maps to the image's `bun` user and mode `0700`; a bind mount overrides the directory ownership baked into the image.

Required deployment inputs:

- `CUKUP_IMAGE`: image name without embedding registry credentials;
- `CUKUP_DEPLOY_HOST`: authorized VPS host;
- `CUKUP_API_HOSTNAME` and `CUKUP_DASHBOARD_HOSTNAME`: exact public hostnames;
- `CUKUP_DATA_DIRECTORY`: persistent host directory (defaults to `/srv/cukup`);
- `KAMAL_REGISTRY_USERNAME` and Kamal secret `KAMAL_REGISTRY_PASSWORD`;
- Kamal secret `CUKUP_OIDC_ALLOWED_USER_ID`, containing only the exact permitted Amp `user_id`;
- Kamal secret `CUKUP_FLEET_HOSTNAMES`, containing the comma-separated exact canonical lowercase hostnames permitted to bind physical credentials;
- `CUKUP_NEW_TURN_EVENT_SCHEMA_VERSION`, currently `2` after the plugin attribution rollout passed orb and physical-runner canaries. Set it back to `1` to make only future turns use v1 without disabling delayed v2 replay.

The fixed OIDC issuer and audience are code constants, not deployment overrides. The container accepts HTTP only behind Kamal Proxy and requires the single exact value `X-Forwarded-Proto: https` on secure API and dashboard routes; Kamal Proxy owns public TLS. Routing uses the preserved original `Host` and never trusts `X-Forwarded-Host`. Direct Bun TLS is available outside this asset by setting both `CUKUP_TLS_CERT_PATH` and `CUKUP_TLS_KEY_PATH`. Never expose container port 3000 publicly because proxy-header trust relies on that network boundary.

The checked-in Kamal asset configures both exact hosts and uses host-agnostic `/up` for Kamal Proxy readiness while public API liveness remains the API-host `/healthz`. Inject `CUKUP_GITHUB_OAUTH_CLIENT_ID`, `CUKUP_GITHUB_OAUTH_CLIENT_SECRET`, `CUKUP_GITHUB_ALLOWED_USER_ID`, and `CUKUP_DASHBOARD_SESSION_KEYS` only through protected runtime configuration. Missing or invalid values disable dashboard routes without affecting ingestion. The exact routes, key-ring rotation procedure, report contract, and release checks are in [the dashboard service contract](dashboard-service.md).

## Publication and protected deployment operator

GitHub Actions currently verifies the exact `main` SHA with `bun run check` and publishes an immutable linux/amd64 GHCR image labeled with the service name, source repository, and revision. The protected Vikas operator recorded in [Fleet commit `5082699`](https://github.com/zainfathoni/fleet/commit/5082699a5b6e605e84904f4c77f79d6274f98c69) polls signed Cukup `main`, requires a successful same-SHA publication, verifies image labels and architecture, creates and independently retrieves a backup, deploys with Kamal, validates API/dashboard/database/preservation contracts, and records success only after all gates pass. Its automatic rollback uses the captured prior v4-aware release.

The current publication trigger treats every `main` SHA as releasable, including documentation-only changes. That behavior is incorrect: changes with no runtime, dependency, image, deployment, or release-contract impact must not publish an image, create a release version, or trigger the production operator. Until path-aware publication and operator selection ship together, keep documentation-only work on a non-`main` branch or intentionally bundle it with a releasable runtime change. The eventual operator must follow the latest verified **releasable service revision**, not assume that the repository's latest commit always has an image.

Do not add path filters to the workflow alone: the current operator waits for an image matching `main`, so workflow and operator selection must change as one reviewed rollout. Preserve signed-commit verification, same-revision workflow evidence, immutable image verification, backup, acceptance, and rollback gates.

Before changing a release, render and validate the config and build the image without deploying:

```bash
kamal config -c config/deploy.service.yml
docker build -f Dockerfile.service -t cukup-service-rc .
```

After explicit deployment approval, verify minimal health through both final HTTPS hostnames, then authenticated capabilities/time/summary, dashboard sign-in/report/logout, database integrity, preservation, and persistence across one normal restart. Do not paste credentials, JWTs, headers, identity-bearing responses, dashboard data, or database rows into Fleet, GitHub, or an Amp thread.

Record the deployed immutable image reference and the prior known-good migration-aware reference for every release. SQLite `user_version=4` is the half-day target rollout floor. Fresh, v1, and v2 databases create the latest `target_overrides(date, target_minutes, created_at, updated_at)` table directly; a v3 database transactionally rebuilds its strict zero-only table while preserving every existing override and audit timestamp. The v4 table accepts exactly target 0 or 240 and no reason or other free text. Startup is restart-safe, leaves v4 unchanged, never lowers `user_version`, and fails closed on v5 or newer. Once v4 has opened the persistent database, never run or restore a pre-v4 binary against it.

To roll back attribution, set `CUKUP_NEW_TURN_EVENT_SCHEMA_VERSION=1` so only future turns start as v1. The service must continue accepting delayed and in-progress v2 events. To roll back application code after v4 migration, deploy only a tested v4-aware reference against the existing persistent volume, then verify authenticated capabilities, time, mixed v1/v2 delayed replay, full-day/half-day target set and clear, summary schema 1, labeled token rotation, and one further normal restart. Do not run a v3-only image or replace SQLite merely to roll back application behavior: restore a backup only for a diagnosed data incident, using the stopped-service procedure below.

The completed v4 rollout deployed the service before publishing the plugin's half-day option. Retain that compatibility rule for recovery: older zero-target clients remain compatible, but a pre-v4 service does not understand a half-day selection and must never run against the migrated database. The rollout verified a pre-migration backup, 0→240→clear behavior, schema-1 summary and dashboard targets, restart, post-migration backup retrieval, and clean restore without recording exercised dates, bodies, credentials, or responses.

## Physical-machine bearer lifecycle

Operate on the persistent database from a protected administrative session. Token values are generated server-side, printed exactly once, and never accepted as process arguments or environment variables. Start with `umask 077` and redirect output to a protected file rather than terminal capture:

```bash
umask 077
bun run service:token issue /var/lib/cukup/cukup.sqlite > /secure-transfer/new-machine-token.json
```

Deliver the token through an approved narrow secret channel. Keep the nonsecret `token_id` for operations.

The current Amp plugin binds the bearer before its first v2 upload through `PUT /v1/executor-profile`. Binding is exact and immutable; an unrecognized hostname, rename attempt, or label already held by another active lineage fails without changing the credential. Keep the complete allowlist configured before permitting v2 starts.

Rotation atomically revokes the old token, copies its Executor Label to the replacement, and only then transfers all its random source claims:

```bash
bun run service:token rotate TOKEN_ID /var/lib/cukup/cukup.sqlite > /secure-transfer/replacement-token.json
```

Confirm the replacement works, then remove the transfer file. Rotation already revokes the old value. Emergency revocation is independent per machine:

```bash
bun run service:token revoke TOKEN_ID /var/lib/cukup/cukup.sqlite
bun run service:token list /var/lib/cukup/cukup.sqlite
```

`list` emits token IDs, lifecycle timestamps, and nullable Executor Labels—never hashes or bearer values. Treat its output as machine-identifying operational data. A fresh Amp orb uses workload OIDC, derives `amp-orb`, and must never receive a physical-machine token. Historical evidence is not rewritten: source ownership derives the current lineage label, and history from a never-bound physical lineage remains `unassigned-executor`.

## Integrity and online backup

The service uses WAL mode and restrictive directory/database permissions. `backup` opens the live source read-only and executes SQLite `VACUUM INTO`, producing a transactionally consistent online snapshot without copying WAL files. The snapshot includes target overrides and their audit timestamps with the rest of SQLite. It then runs full `PRAGMA integrity_check`, records SQLite schema version, size, SHA-256, creation time, and backup ID in adjacent JSON metadata, and publishes both files atomically.

```bash
bun run service:db integrity /var/lib/cukup/cukup.sqlite
bun run service:db backup /srv/cukup-backups /var/lib/cukup/cukup.sqlite
bun run service:db verify /srv/cukup-backups/BACKUP.sqlite /srv/cukup-backups/BACKUP.json
```

Run the verified backup every six hours and prune local pairs only after they exceed seven days. Preserve each `.sqlite` and `.json` pair together. A backup is not successful until `integrity_check` is `ok`, the metadata is retained, and monitoring records success or alerts Zain Fathoni.

An independent system must pull—not merely push—the pair off the VPS. A provider-neutral example from the off-site system is:

```bash
rsync --archive --protect-args DEPLOY_HOST:/srv/cukup-backups/ /independent/cukup-backups/
bun run service:db verify /independent/cukup-backups/BACKUP.sqlite /independent/cukup-backups/BACKUP.json
```

From `vikas-mac-mini`, pull and verify backup pairs daily, retain them there for 30 days, and prune only after a successful inventory check. Supply SSH authentication outside process arguments and broad environments. A missed daily pull makes the 24-hour RPO visibly degraded; the seven-day VPS retention permits catch-up after Vikas returns. Off-site protection remains valid only while independent retrieval and verification continue succeeding. Repeat the clean restore drill quarterly.

## Clean restore and replacement

Perform a clean restore drill quarterly and before any recovery-path change:

1. Retrieve one database/metadata pair from the off-site system into a new protected directory.
2. Verify it before touching any service database.
3. Restore to a new path, run integrity, start an isolated service against it, and authenticate with a designated drill credential.
4. Confirm expected mixed-schema event count, summary schema 1, executor attribution, target overrides, and token rotation; record only nonsensitive evidence (backup ID, backup creation time, integrity result, and pass/fail).

```bash
bun run service:db verify /retrieved/BACKUP.sqlite /retrieved/BACKUP.json
bun run service:db restore /retrieved/BACKUP.sqlite /restore-drill/cukup.sqlite /retrieved/BACKUP.json
bun run service:db integrity /restore-drill/cukup.sqlite
```

For incident replacement, obtain explicit approval, stop the service, preserve the failed database and sidecars for investigation, and only then use `--replace`:

```bash
bun run service:db restore /retrieved/BACKUP.sqlite /var/lib/cukup/cukup.sqlite /retrieved/BACKUP.json --replace
bun run service:db integrity /var/lib/cukup/cukup.sqlite
```

`--replace` removes stale WAL/SHM sidecars before the atomic replacement. Never run it against a live service. Restored `user_version=1` and `user_version=2` backups create the latest target table while upgrading to v4; a restored v3 backup transactionally preserves its zero-minute overrides while relaxing the table to 0 or 240; a v4 backup restarts unchanged. Use only the v4-aware binary for every restored generation once migration begins. Restart, verify `/healthz`, authenticated `/v1/capabilities` and `/v1/time`, delayed v1/v2 replay, 0/240 target set and clear, summary schema 1, labeled rotation, and persistence through one further normal restart. If integrity, checksum, authentication, attribution, target, or expected summary fails, stop and retain all artifacts; do not overwrite the backup or attempt repeated blind restores.

## Incident boundaries

- Revoke only the affected physical token; other machine credentials and OIDC remain independent.
- Change the allowed OIDC user only as an intentional auth-policy change, then restart the service. Existing JWTs for the old user fail without database mutation.
- Logs contain method, route template, status, duration, and redacted internal errors. They intentionally omit headers, bodies, target-override dates, event IDs, source/session IDs, JWT claims, and database details.
- Treat unexpected conflict or clock-skew outcomes as visible client incidents. Never mutate accepted events to make a retry pass.
- The unauthenticated health response is liveness only. Use authenticated checks and database integrity tooling for diagnosis.
