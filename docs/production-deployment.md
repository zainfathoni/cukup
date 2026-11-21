# Cukup production deployment path

GitHub Actions is the active production deployment authority. The protected `production` environment controls access to the VPS, registry, database, and runtime secrets.

Do not deploy from an ordinary checkout. Keep the retired off-site operator LaunchAgent disabled or revoke its authority. Two operators must not mutate production concurrently.

## Release path

1. Merge the service change to signed `main`.
2. Wait for `Publish service image` to verify the source and publish the immutable `linux/amd64` image.
3. Confirm that the image tag is the full `main` commit SHA.
4. Let `Deploy service` select the successful push publication for that exact SHA.
5. Let the protected job verify ancestry, image labels, architecture, database integrity, and the remote deployment lock.
6. Let the job create and independently verify a fresh backup.
7. Let Kamal redeploy the exact Cukup image without rebuilding it, booting the shared proxy, or pruning recovery assets.
8. Confirm API, dashboard, database, preservation, restart, and rollback gates.

Automatic deployment accepts only a successful push publication from `main`. Manual, failed, cancelled, and non-main publications do not enter this path.

Changes outside service image inputs do not publish an image. The source paths are listed in [the publication workflow](../.github/workflows/publish-service.yml).

## Deployment authority boundary

Do not copy production secrets into Git, command arguments, issues, or Amp messages. Provision each secret from an approved source.

Do not clear a remote lock only because its original machine is offline. First reconcile the prior mutation.

## GitHub Actions deployment

Before merging a change that publishes a service image, set these variables in the protected `production` environment:

| Variable | Value to supply |
| --- | --- |
| `CUKUP_DEPLOY_HOST` | Current deployment SSH hostname or IPv4 address. Keep its verified host key in `SSH_KNOWN_HOSTS`. |
| `CUKUP_SSH_USER` | Current deployment SSH account. |
| `CUKUP_API_HOSTNAME` | Current public API hostname, with no scheme or port. |
| `CUKUP_DASHBOARD_HOSTNAME` | Current public dashboard hostname, with no scheme or port. |
| `CUKUP_WORK_PROJECTS` | Exact Amp project slugs, separated by commas with no spaces. Set this to `bta,bta-notes` to keep the current production reports. |
| `CUKUP_DATA_DIRECTORY` | Current SQLite bind mount source on the host. |
| `CUKUP_BACKUP_DIRECTORY` | Directory where the existing backup service writes verified pairs. |
| `CUKUP_DNS_ZONE` | Active Cloudflare zone. Required only for the manual DNS workflow. |

The workflows derive the source repository and GHCR image from the GitHub repository. Kamal uses its owner as the registry username. Keep the existing credentials. Do not rotate runtime secrets or change owner IDs as part of this migration: preflight checks the two hostnames, the database bind mount, and the runtime secrets against the running container before any deploy.

The deploy check verifies the new Work list on the candidate container. The prior container can have a different list or no list. All other runtime hash inputs must match. If Kamal recreates the prior container during rollback, it uses the prior Work list or omits the setting if it was absent. The rollback check compares the full prior runtime hash. A changed list takes effect on a new release, not a repeat deployment of the current SHA.

Leave the four `CUKUP_TRUST_BASE_*` variables unset for a deployment already running a verified GHCR release. If the host still runs the retained legacy trust-repair container, set all four to its approved exact identity: `CUKUP_TRUST_BASE_VERSION` (full commit SHA with suffix), `CUKUP_TRUST_BASE_IMAGE` (image and tag), `CUKUP_TRUST_BASE_IMAGE_ID` (`sha256:` digest), and `CUKUP_TRUST_BASE_CONTAINER_ID` (full container ID). This does not bypass the pinned runtime checks.

The manual DNS workflow also requires `CLOUDFLARE_API_TOKEN` and `CUKUP_DEPLOY_IPV4` secrets. Do not run it to migrate deployment settings. The current DNS records do not need to change.

Use manual `preflight` for one exact full SHA when you need a non-mutating check. Use manual `deploy` only with explicit production approval.

The workflow requires protected SSH, registry, OIDC, Fleet, OAuth, and session secrets. `CUKUP_API_TOKEN` is optional and enables authenticated read-only probes.

An older publication does not run automatically after the workflow trigger reaches `main`. Use manual exact-SHA deployment or wait for a later qualifying push.

Do not republish manually to bypass the push-event gate.

## Release verification

Check source verification, publication, and public liveness without exposing identity-bearing responses:

```sh
gh api "repos/{owner}/{repo}/commits/$CUKUP_REVISION" --jq '.commit.verification'
gh run list \
  --workflow publish-service.yml \
  --json headSha,status,conclusion,event,url
curl --fail --silent "https://$CUKUP_API_HOSTNAME/up"
curl --fail --silent "https://$CUKUP_API_HOSTNAME/healthz"
```

These HTTP checks prove liveness only. The protected job must verify authentication, backup, database, preservation, and dashboard behavior.

## Follow-up issues

Deployment reliability work is tracked by [issue #3](https://github.com/zainfathoni/cukup/issues/3) and its linked child issues.

## Current example

Do not use a historical release record as the current production source of truth. Read the protected workflow record and live image reference instead.
