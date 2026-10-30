# Shared service operations runbook

This runbook describes the deployed service. It does not authorize a release, production mutation, credential change, restore, or rollback.

## Ownership and production baseline

Zain Fathoni owns the service, DNS, TLS, backups, incident response, and credential revocation.

Production runs on `production-host` behind Kamal Proxy. The public hosts are `api.cukup.dev` and `cukup.dev`.

GitHub Actions is the active deployment authority. Keep the retired off-site operator LaunchAgent disabled or revoke its authority. Prevent concurrent production operators.

Keep the recovery objectives, backup schedules, and retention settings in the private operator runbook.

There is no cloud object-storage dependency. Keep the monitoring status in the private operator runbook. Verify alert delivery and owner response before claiming coverage.

## Runtime and TLS

Keep `/var/lib/cukup` as the persistent volume. Create the host data directory with mode `0700` and image-user ownership before first start.

Keep container port 3000 private to Kamal Proxy. Public TLS terminates at the proxy. The service trusts `X-Forwarded-Proto` only on this private boundary.

Inject registry, OIDC, Fleet, OAuth, and session values through protected configuration. Do not store credential values in the Kamal file.

Production sets `CUKUP_NEW_TURN_EVENT_SCHEMA_VERSION=2`. Set it to `1` only to move future turn starts back to v1.

Missing dashboard secrets disable dashboard routes. They do not disable ingestion. See [the dashboard contract](dashboard-service.md).

## Read metrics through the plugin

The development plugin provides the agent tool `work_hours_status`. Its optional `track` selects `work`, `play`, or `all`; the default is `work`. See the [tool registration](../plugin/index.ts) and [status reader](../plugin/status.ts). Local source changes do not activate or publish the tool. Service deployment, plugin publication, and activation require separate owner approval.

Use this tool for a status read instead of UI automation, SQL, or direct credential access. It uses the existing protected token provider and `GET /v1/summary?track=work` (or `play` or `all`). It does not run synchronization, upload queued events, save a summary, acknowledge gaps, or change targets or attribution. Existing tracking hooks and background synchronization remain independent of the read.

Report the returned freshness and `as_of`. Daily and Monday–Sunday weekly scope use Asia/Jakarta and the snapshot date, not the date of a later cached read. A failed or unsupported track read reports UNKNOWN for that track. It can show the existing global cache as a separate STALE legacy snapshot, never as track status. Cached activity has explicit global daily and weekly labels, without goal or limit comparisons. Missing data is not zero. The tool does not add a local estimate. Pending, conflict, rejection, clock, and tracking-gap diagnostics describe local coverage limits; they do not prove complete coverage on other executors.

The track response reuses the dashboard's existing calculation. Work includes exactly `bta` and `bta-notes`. Play includes everything else, including Unassigned. Work has goals; Play and All have limits, not goals to reach. These totals are Legacy Working Time · turn-based, not measured human attention. Do not add overlapping track, machine, or project totals. Cukup does not decide when the owner must stop work.

The summary endpoint without `track` retains its legacy global response and target policy. Existing synchronization and status commands keep that contract. The new client requires the requested track and timezone in the response, so an older service that ignores the query cannot appear track-aware. Deploy the compatible service before activating this tool.

## Publication and protected deployment operator

Use the protected GitHub `production` environment for deployment. Do not use the retired off-site operator deployment operator.

Before an approved release, run non-mutating local checks:

```sh
kamal config -c config/deploy.service.yml
docker build -f Dockerfile.service -t cukup-service-rc .
```

After deployment, verify API health, authenticated API behavior, dashboard login, database integrity, preservation, and one normal restart.

Record the deployed immutable image and the prior known-good v4-aware image. Keep both available for rollback.

SQLite `user_version=4` is the production floor. Never run a pre-v4 binary against a database opened by v4.

For attribution rollback, prefer event schema v1 only for future starts. Continue to accept delayed and active v2 evidence.

For application rollback, deploy only a tested v4-aware image. Do not replace SQLite to reverse application behavior.

## Physical-machine bearer lifecycle

Use a protected administrative session. Set `umask 077`. Redirect new token output to a protected file.

```sh
umask 077
bun run service:token issue /var/lib/cukup/cukup.sqlite \
  > /secure-transfer/new-machine-token.json
```

Deliver the token through an approved narrow secret channel. Keep the nonsecret token ID for later operations.

Keep every physical hostname in the Fleet allowlist before v2 starts. A hostname binding is exact and cannot rename a lineage.

Rotate a token with:

```sh
bun run service:token rotate TOKEN_ID /var/lib/cukup/cukup.sqlite \
  > /secure-transfer/replacement-token.json
```

Confirm the replacement. Then remove the transfer file. Rotation already revokes the old token.

For emergency revocation and inspection, run:

```sh
bun run service:token revoke TOKEN_ID /var/lib/cukup/cukup.sqlite
bun run service:token list /var/lib/cukup/cukup.sqlite
```

Treat list output as machine-identifying operational data. Never give a physical token to an Amp orb.

## Integrity and online backup

Run these commands for integrity, backup, and verification:

```sh
bun run service:db integrity /var/lib/cukup/cukup.sqlite
bun run service:db backup /srv/example-cukup-backups /var/lib/cukup/cukup.sqlite
bun run service:db verify BACKUP.sqlite BACKUP.json
```

Keep each SQLite file with its JSON metadata. A backup succeeds only after integrity and metadata verification.

Create and verify local backups at the approved interval. Apply the configured retention policy.

Pull backup pairs from the production host to an independent backup host. Verify each pair after retrieval and apply the configured retention policy.

Prune off-site pairs only after a successful inventory check. Record backup verification success or alert Zain Fathoni on failure.

Do not count a push from the VPS as independent recovery. A missed pull can degrade the recovery point objective.

## Clean restore and replacement

Perform clean restore drills at the approved interval. Also perform one before a recovery-path change.

1. Retrieve one backup pair into a new protected directory.
2. Verify the pair before you touch any service database.
3. Restore to a new path.
4. Run database integrity.
5. Start an isolated service with the restored database.
6. Verify mixed v1/v2 evidence, summary schema 1, attribution, target overrides, and token rotation.
7. Record only backup identity, creation time, integrity result, and pass or fail.

```sh
bun run service:db verify /retrieved/BACKUP.sqlite /retrieved/BACKUP.json
bun run service:db restore /retrieved/BACKUP.sqlite \
  /restore-drill/cukup.sqlite /retrieved/BACKUP.json
bun run service:db integrity /restore-drill/cukup.sqlite
```

For incident replacement, get explicit approval. Stop the service. Preserve the failed database and sidecars.

Only then run:

```sh
bun run service:db restore /retrieved/BACKUP.sqlite \
  /var/lib/cukup/cukup.sqlite /retrieved/BACKUP.json --replace
bun run service:db integrity /var/lib/cukup/cukup.sqlite
```

Never use `--replace` on a live service. Use only a v4-aware binary after migration starts.

After replacement, verify health, authentication, delayed replay, targets, summary, rotation, and one additional restart.

Stop if any integrity, checksum, authentication, attribution, target, or summary check fails. Retain all artifacts. Do not repeat restores blindly.

## Incident boundaries

- Revoke only the affected physical token.
- Change the allowed OIDC user only as an intentional policy change.
- Never mutate accepted evidence to make a conflict pass.
- Use authenticated checks and database tools for diagnosis.
- Treat unauthenticated health as liveness only.
- Keep credentials, request bodies, target dates, private identities, claims, and database rows out of logs and public incident records.
