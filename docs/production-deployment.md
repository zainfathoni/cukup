# Cukup production deployment path

GitHub Actions is the active production deployment authority. The protected `production` environment controls access to the VPS, registry, database, and runtime secrets.

Do not deploy from an ordinary checkout. Keep the retired Vikas LaunchAgent disabled or revoke its authority. Two operators must not mutate production concurrently.

## Release path

1. Merge the service change to signed `main`.
2. Wait for `Publish service image` to verify the source and publish the immutable `linux/amd64` image.
3. Confirm that the image tag is the full `main` commit SHA.
4. Let `Deploy service` select the successful push publication for that exact SHA.
5. Let the protected job verify ancestry, image labels, architecture, database integrity, and the remote deployment lock.
6. Let the job create and independently verify a fresh backup.
7. Let Kamal deploy the exact image without rebuilding it.
8. Confirm API, dashboard, database, preservation, restart, and rollback gates.

Automatic deployment accepts only a successful push publication from `main`. Manual, failed, cancelled, and non-main publications do not enter this path.

Changes outside service image inputs do not publish an image. The source paths are listed in [the publication workflow](../.github/workflows/publish-service.yml).

## Deployment authority boundary

Do not copy production secrets into Git, command arguments, issues, or Amp messages. Provision each secret from an approved source.

Do not clear a remote lock only because its original machine is offline. First reconcile the prior mutation.

## GitHub Actions deployment

Use manual `preflight` for one exact full SHA when you need a non-mutating check. Use manual `deploy` only with explicit production approval.

The workflow requires protected SSH, registry, OIDC, Fleet, OAuth, and session secrets. `CUKUP_API_TOKEN` is optional and enables authenticated read-only probes.

An older publication does not run automatically after the workflow trigger reaches `main`. Use manual exact-SHA deployment or wait for a later qualifying push.

Do not republish manually to bypass the push-event gate.

## Release verification

Check source verification, publication, and public liveness without exposing identity-bearing responses:

```sh
gh api repos/zainfathoni/cukup/commits/<sha> --jq '.commit.verification'
gh run list --repo zainfathoni/cukup \
  --workflow publish-service.yml \
  --json headSha,status,conclusion,event,url
curl --fail --silent https://api.cukup.dev/up
curl --fail --silent https://api.cukup.dev/healthz
```

These HTTP checks prove liveness only. The protected job must verify authentication, backup, database, preservation, and dashboard behavior.

## Follow-up issues

Deployment reliability work is tracked by [issue #3](https://github.com/zainfathoni/cukup/issues/3) and its linked child issues.

## Current example

Do not use a historical release record as the current production source of truth. Read the protected workflow record and live image reference instead.
