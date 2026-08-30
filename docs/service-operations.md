# Shared service operations runbook

This runbook describes the release candidate. It does not authorize a deployment or any shared-infrastructure change.

## Pre-deployment gate

Do not deploy until each blank has a named owner and the evidence is linked from Fleet #31:

| Responsibility | Required owner |
| --- | --- |
| Service/runtime | _assign before deployment_ |
| DNS and TLS | _assign before deployment_ |
| Backup schedule, retention, and off-site pull | _assign before deployment_ |
| Incident response and credential revocation | _assign before deployment_ |

Also record VPS authorization, CPU/memory/disk capacity, container isolation, the final hostname, backup retention, alert destination, and recovery objectives. Backblaze B2 and Healthchecks are not configured or claimed by this RC. Add them only after real retention, retrieval, alert ownership, and restore paths are verified.

## Runtime and TLS

`Dockerfile.service` builds a non-root Bun image containing the server plus database/token operator bundles. `/var/lib/cukup` is the only persistent volume. `config/deploy.service.yml` is a distinct Kamal application with hostname, host, image, registry, allowed OIDC user, and host-volume path supplied outside Git. It contains no credential values. Before first start, create the host data directory with ownership that maps to the image's `bun` user and mode `0700`; a bind mount overrides the directory ownership baked into the image.

Required deployment inputs:

- `CUKUP_IMAGE`: image name without embedding registry credentials;
- `CUKUP_DEPLOY_HOST`: authorized VPS host;
- `CUKUP_TLS_HOSTNAME`: dedicated service hostname;
- `CUKUP_DATA_DIRECTORY`: persistent host directory (defaults to `/srv/example-cukup-data`);
- `KAMAL_REGISTRY_USERNAME` and Kamal secret `KAMAL_REGISTRY_PASSWORD`;
- Kamal secret `CUKUP_OIDC_ALLOWED_USER_ID`, containing only the exact permitted Amp `user_id`.

The fixed OIDC issuer and audience are code constants, not deployment overrides. The container accepts HTTP only behind Kamal Proxy and requires `X-Forwarded-Proto: https` on `/v1/*`; Kamal Proxy owns public TLS. Direct Bun TLS is available outside this asset by setting both `CUKUP_TLS_CERT_PATH` and `CUKUP_TLS_KEY_PATH`. Never expose container port 3000 publicly.

Before a real deployment, render/validate the config and build the image without deploying:

```bash
kamal config -c config/deploy.service.yml
docker build -f Dockerfile.service -t cukup-service-rc .
```

After explicit deployment approval, verify minimal health through the final HTTPS hostname, then authenticated `/v1/time`, a disposable ingestion source, summary, and persistence across one normal restart. Do not paste the credential, JWT, headers, or response containing identity data into Fleet, GitHub, or an Amp thread.

Record the deployed immutable image reference and the prior known-good reference for every release. To roll back application code, redeploy that prior reference with this separate Kamal config, leave the persistent volume in place, and repeat the health, authenticated time/summary, and restart checks. Do not replace SQLite merely to roll back the application: restore a backup only for a diagnosed data incident, using the stopped-service procedure below. Stop the rollback and preserve evidence if the prior version cannot read the current schema.

## Physical-machine bearer lifecycle

Operate on the persistent database from a protected administrative session. Token values are generated server-side, printed exactly once, and never accepted as process arguments or environment variables. Start with `umask 077` and redirect output to a protected file rather than terminal capture:

```bash
umask 077
bun run service:token issue /var/lib/cukup/cukup.sqlite > /secure-transfer/new-machine-token.json
```

Deliver the token through an approved narrow secret channel. Keep the nonsecret `token_id` for operations.

Rotation atomically revokes the old token and transfers all its random source claims:

```bash
bun run service:token rotate TOKEN_ID /var/lib/cukup/cukup.sqlite > /secure-transfer/replacement-token.json
```

Confirm the replacement works, then remove the transfer file. Rotation already revokes the old value. Emergency revocation is independent per machine:

```bash
bun run service:token revoke TOKEN_ID /var/lib/cukup/cukup.sqlite
bun run service:token list /var/lib/cukup/cukup.sqlite
```

`list` emits only token IDs and lifecycle timestamps—never hashes or bearer values. A fresh Amp orb uses workload OIDC and must never receive a physical-machine token.

## Integrity and online backup

The service uses WAL mode and restrictive directory/database permissions. `backup` opens the live source read-only and executes SQLite `VACUUM INTO`, producing a transactionally consistent online snapshot without copying WAL files. It then runs full `PRAGMA integrity_check`, records SQLite schema version, size, SHA-256, creation time, and backup ID in adjacent JSON metadata, and publishes both files atomically.

```bash
bun run service:db integrity /var/lib/cukup/cukup.sqlite
bun run service:db backup /srv/example-cukup-backups /var/lib/cukup/cukup.sqlite
bun run service:db verify /srv/example-cukup-backups/BACKUP.sqlite /srv/example-cukup-backups/BACKUP.json
```

Schedule this command only after retention and monitoring owners are assigned. Preserve each `.sqlite` and `.json` pair. A backup is not successful until `integrity_check` is `ok` and the metadata is retained.

An independent system must pull—not merely push—the pair off the VPS. A provider-neutral example from the off-site system is:

```bash
rsync --archive --protect-args DEPLOY_HOST:/srv/example-cukup-backups/ /independent/cukup-backups/
bun run service:db verify /independent/cukup-backups/BACKUP.sqlite /independent/cukup-backups/BACKUP.json
```

Supply SSH authentication outside process arguments and broad environments. Do not claim off-site protection until retrieval and verification have run from that independent system.

## Clean restore and replacement

Perform a clean restore drill periodically and before claiming production readiness:

1. Retrieve one database/metadata pair from the off-site system into a new protected directory.
2. Verify it before touching any service database.
3. Restore to a new path, run integrity, start an isolated service against it, and authenticate with a designated drill credential.
4. Confirm expected event count/summary and record only nonsensitive evidence (backup ID, dates, integrity result, and pass/fail).

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

`--replace` removes stale WAL/SHM sidecars before the atomic replacement. Never run it against a live service. Restart, verify `/healthz`, authenticated `/v1/time`, summary, and persistence through one further normal restart. If integrity, checksum, authentication, or expected summary fails, stop and retain all artifacts; do not overwrite the backup or attempt repeated blind restores.

## Incident boundaries

- Revoke only the affected physical token; other machine credentials and OIDC remain independent.
- Change the allowed OIDC user only as an intentional auth-policy change, then restart the service. Existing JWTs for the old user fail without database mutation.
- Logs contain method, pathname, status, duration, and redacted internal errors. They intentionally omit headers, bodies, event IDs, source/session IDs, JWT claims, and database details.
- Treat unexpected conflict or clock-skew outcomes as visible client incidents. Never mutate accepted events to make a retry pass.
- The unauthenticated health response is liveness only. Use authenticated checks and database integrity tooling for diagnosis.
