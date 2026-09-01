# Shared service operations runbook

This runbook describes the release candidate. It does not authorize a deployment or any shared-infrastructure change.

## Pre-deployment gate

The initial owner assignments are:

| Responsibility | Required owner |
| --- | --- |
| Service/runtime | Zain Fathoni |
| DNS and TLS | Zain Fathoni |
| Backup schedule, retention, and off-site pull | Zain Fathoni |
| Incident response and credential revocation | Zain Fathoni |

The authorized deployment target is `production-host`, with final hostname `api.cukup.dev`. A read-only inspection on 2026-08-30 found an existing Kamal Proxy on ports 80/443, no conflicting Cukup resources, about 23 GB free disk, and about 2.2 GB available RAM. A native linux/amd64 container check then passed the full API/restart path at roughly 15 MiB idle and 30 MiB request-load working set within a 256 MiB limit. The Kamal role is capped at half of one CPU, 256 MiB RAM+swap, and 128 processes with a read-only root filesystem. This supports low-traffic personal co-location while protecting the host's existing workloads; sustained saturation must remain monitored. Before deployment, also prove registry access, public reachability, and the alert destination.

Keep the active backup cadence, retention, targets, and monitoring status in private operator configuration. Verify online snapshots, off-site retrieval, and a clean restore.

## Runtime and TLS

`Dockerfile.service` builds a non-root Bun image containing the server plus database/token operator bundles. `/var/lib/cukup` is the only persistent volume. `config/deploy.service.yml` is a distinct Kamal application with hostname, host, image, registry, allowed OIDC user, and host-volume path supplied outside Git. It contains no credential values. Before first start, create the host data directory with ownership that maps to the image's `bun` user and mode `0700`; a bind mount overrides the directory ownership baked into the image.

Required deployment inputs:

- `CUKUP_IMAGE`: image name without embedding registry credentials;
- `CUKUP_DEPLOY_HOST`: authorized VPS host;
- `CUKUP_TLS_HOSTNAME`: dedicated service hostname;
- `CUKUP_DATA_DIRECTORY`: persistent host directory (defaults to `/srv/example-cukup-data`);
- `KAMAL_REGISTRY_USERNAME` and Kamal secret `KAMAL_REGISTRY_PASSWORD`;
- Kamal secret `CUKUP_OIDC_ALLOWED_USER_ID`, containing only the exact permitted Amp `user_id`;
- Kamal secret `CUKUP_FLEET_HOSTNAMES`, containing the comma-separated exact canonical lowercase hostnames permitted to bind physical credentials;
- `CUKUP_NEW_TURN_EVENT_SCHEMA_VERSION`, which must remain `1` until a separately reviewed plugin rollout is ready to snapshot v2 for future turns.

The fixed OIDC issuer and audience are code constants, not deployment overrides. The container accepts HTTP only behind Kamal Proxy and requires the single exact value `X-Forwarded-Proto: https` on secure API and dashboard routes; Kamal Proxy owns public TLS. Routing uses the preserved original `Host` and never trusts `X-Forwarded-Host`. Direct Bun TLS is available outside this asset by setting both `CUKUP_TLS_CERT_PATH` and `CUKUP_TLS_KEY_PATH`. Never expose container port 3000 publicly because proxy-header trust relies on that network boundary.

The checked-in Kamal asset remains intentionally API-only. Before the separately approved dashboard rollout, extend and validate its proxy configuration for both `api.cukup.dev` and `cukup.dev` while retaining an API-host `/healthz` check. Inject `CUKUP_GITHUB_OAUTH_CLIENT_ID`, `CUKUP_GITHUB_OAUTH_CLIENT_SECRET`, `CUKUP_GITHUB_ALLOWED_USER_ID`, and `CUKUP_DASHBOARD_SESSION_KEYS` only through protected runtime configuration. Missing or invalid values leave dashboard routes disabled without affecting ingestion. The exact routes, key-ring rotation procedure, report contract, and remaining gates are in [the dashboard service contract](dashboard-service.md).

Before a real deployment, render/validate the config and build the image without deploying:

```bash
kamal config -c config/deploy.service.yml
docker build -f Dockerfile.service -t cukup-service-rc .
```

After explicit deployment approval, verify minimal health through the final HTTPS hostname, then authenticated `/v1/time`, a disposable ingestion source, summary, and persistence across one normal restart. Do not paste the credential, JWT, headers, or response containing identity data into Fleet, GitHub, or an Amp thread.

Record the deployed immutable image reference and the prior known-good migration-aware reference for every release. SQLite `user_version=4` is the half-day target rollout floor. Fresh, v1, and v2 databases create the latest `target_overrides(date, target_minutes, created_at, updated_at)` table directly; current production v3 transactionally rebuilds its strict zero-only table while preserving every existing override and audit timestamp. The v4 table accepts exactly target 0 or 240 and no reason or other free text. Startup is restart-safe, leaves v4 unchanged, never lowers `user_version`, and fails closed on v5 or newer. Once v4 has opened the persistent database, never run or restore a pre-v4 binary against it.

To roll back attribution, set `CUKUP_NEW_TURN_EVENT_SCHEMA_VERSION=1` so only future turns start as v1. The service must continue accepting delayed and in-progress v2 events. To roll back application code after v4 migration, deploy only a tested v4-aware reference against the existing persistent volume, then verify authenticated capabilities, time, mixed v1/v2 delayed replay, full-day/half-day target set and clear, summary schema 1, labeled token rotation, and one further normal restart. Do not run a v3-only image or replace SQLite merely to roll back application behavior: restore a backup only for a diagnosed data incident, using the stopped-service procedure below.

Roll out the v4 service before publishing the plugin command with its half-day option. Older plugins remain compatible because their zero-target PUT remains valid. A half-day selection receives a generic protocol failure from a v3 service, so the updated plugin must not be published first. Before rollout, take and verify the current v3 backup and retain the established v1/v2 restore fixtures; after the first v4 start, exercise temporary 0→240→clear changes with an approved credential, verify schema-1 summary and dashboard Overall targets (including a 2,160-minute standard week), restart once, then take, retrieve, verify, and clean-restore a v4 backup. Do not log or paste the exercised date, body, credential, or response.

## Physical-machine bearer lifecycle

Operate on the persistent database from a protected administrative session. Token values are generated server-side, printed exactly once, and never accepted as process arguments or environment variables. Start with `umask 077` and redirect output to a protected file rather than terminal capture:

```bash
umask 077
bun run service:token issue /var/lib/cukup/cukup.sqlite > /secure-transfer/new-machine-token.json
```

Deliver the token through an approved narrow secret channel. Keep the nonsecret `token_id` for operations.

The future plugin binds the bearer before its first v2 upload through `PUT /v1/executor-profile`. Binding is exact and immutable; an unrecognized hostname, rename attempt, or label already held by another active lineage fails without changing the credential. Configure the complete allowlist before enabling future v2 starts.

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
bun run service:db backup /srv/example-cukup-backups /var/lib/cukup/cukup.sqlite
bun run service:db verify /srv/example-cukup-backups/BACKUP.sqlite /srv/example-cukup-backups/BACKUP.json
```

Run and verify backups at the configured interval. Apply the configured retention policy and keep each database file with its metadata.

An independent system must pull—not merely push—the pair off the VPS. A provider-neutral example from the off-site system is:

```bash
rsync --archive --protect-args DEPLOY_HOST:/srv/example-cukup-backups/ /independent/cukup-backups/
bun run service:db verify /independent/cukup-backups/BACKUP.sqlite /independent/cukup-backups/BACKUP.json
```

Pull backup pairs from an independent host and verify them on receipt. Apply the configured retention policy after a successful inventory check. Prove a clean restore before claiming off-site protection.

## Clean restore and replacement

Perform a clean restore drill periodically and before claiming production readiness:

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
