# Cukup production deployment path

This repository owns the Cukup service source, container image, and Kamal configuration. Production execution is intentionally separated from this checkout because the deployment requires the protected VPS, database, registry, and runtime-secret boundary.

## Release path

1. Merge the service change to the signed `main` branch.
2. The `Publish service image` workflow runs on `push` to `main` when an image input changes (`service/`, `Dockerfile.service`, `package.json`, `bun.lock`, or `tsconfig.json`). It validates the source, builds `linux/amd64`, and publishes `ghcr.io/zainfathoni/cukup:<main-sha>` with the service and revision labels.
3. When that publication completes, the `Deploy service` workflow admits the run only when the upstream event was `push`, its branch was `main`, and its conclusion was `success`. It selects the exact `workflow_run.head_sha` and forces the `deploy` operation. Manual publications, non-main publications, failed or cancelled publications, and other upstream events do not enter the protected deployment job.
4. The protected job revalidates the signed `main` ancestry and successful push publication for that exact SHA, verifies the immutable image and architecture, creates and independently retrieves a database backup, then deploys through Kamal using:

   ```bash
   VERSION=<workflow-run-head-sha> kamal deploy --skip-push
   ```

5. It verifies public API and dashboard health, authenticated API/dashboard behavior, database integrity and preservation, and retains the prior migration-aware image for verified rollback after a post-switch failure.

A manually dispatched publication is not selected automatically. Documentation-only, plugin-only, workflow-only, and other changes outside the image inputs therefore do not create a service release or trigger deployment.

## Deployment authority boundary

Do not deploy from an ordinary Cukup checkout or copy production secrets into the repository, command arguments, GitHub issues, or Amp messages. GitHub's protected `production` environment is the active Kamal boundary. The retired off-site operator LaunchAgent must remain disabled or have its deploy authority revoked so that two operators cannot mutate production concurrently.

## GitHub Actions deployment

`Deploy service` runs automatically after an admitted successful publication and retains `workflow_dispatch` for an exact-SHA `preflight` or `deploy`. Its `preflight` operation verifies an exact full SHA, successful push publication, signed-main ancestry, immutable image contract, rendered Kamal configuration, absence of a remote deploy lock, current runtime/database integrity, and public service behavior without mutation. Its `deploy` operation additionally creates and independently verifies a fresh backup, proves pre-deploy preservation, deploys the exact image, repeats the runtime/public/database/preservation gates, and attempts a verified rollback after a post-switch failure.

The workflow uses a protected GitHub `production` environment and supports these variables:

- optional deployment overrides; the checked-in defaults use `zainfathoni/cukup`, VPS address `192.0.2.10`, SSH user `deploy-user`, and registry user `zainfathoni`;
- optional hostname/path overrides, which otherwise use `api.cukup.dev`, `cukup.dev`, `/srv/example-cukup-data`, and `/srv/example-cukup-backups`.

It requires environment secrets `SSH_PRIVATE_KEY`, `SSH_KNOWN_HOSTS`, and every runtime secret named by `config/deploy.service.yml`. Kamal uses the job's short-lived repository token to pull the associated GHCR image unless an environment-scoped `KAMAL_REGISTRY_PASSWORD` overrides it. `CUKUP_API_TOKEN` is optional and enables the existing authenticated read-only acceptance probes; without it, public API/dashboard, OAuth-start, image, backup, and database gates still run. Secret values must be provisioned from an approved source rather than copied from another repository's GitHub secrets.

Do not release a remote lock merely because its originating machine is offline; reconcile the prior mutation first. Enabling `workflow_run` does not replay publications that completed before the trigger reached the default branch. Such an already-published SHA must use the retained manual exact-SHA deployment path, or wait for a later qualifying push publication; do not republish manually to bypass the upstream-event gate.

## Release verification

For a release at `<sha>`, confirm the following without exposing credentials or identity-bearing responses:

```bash
gh api repos/zainfathoni/cukup/commits/<sha> --jq '.commit.verification'
gh run list --repo zainfathoni/cukup --workflow publish-service.yml --json headSha,status,conclusion,event,url
curl --fail --silent https://api.cukup.dev/up
curl --fail --silent https://api.cukup.dev/healthz
```

The first two checks prove the signed source and same-revision push publication. The unauthenticated endpoints prove liveness only; the protected deployment job is responsible for the authenticated, database, backup, and dashboard acceptance checks.

## Follow-up issues

The reliability improvements are tracked under parent issue [#3](https://github.com/zainfathoni/cukup/issues/3):

- [#4 — Add bounded deployment preflight and self-healing](https://github.com/zainfathoni/cukup/issues/4) can start immediately.
- [#5 — Reduce production deployment detection latency](https://github.com/zainfathoni/cukup/issues/5) is a child of #3 and is blocked by #4.
- [#6 — Add deployment observability and failure alerting](https://github.com/zainfathoni/cukup/issues/6) is a child of #3 and is blocked by #4.

## Current example

PR #2 merged as [`586d8fa`](https://github.com/zainfathoni/cukup/commit/586d8fa27d31a4c7c0505ed8d5521e92eaa849f8). Its push publication completed successfully in [workflow run 34596552634](https://github.com/zainfathoni/cukup/actions/runs/34596552634). The off-site operator operator then completed the deployment with `outcome=success`, retaining the prior `545aa68` release for rollback. The running image is `ghcr.io/zainfathoni/cukup:586d8fa27d31a4c7c0505ed8d5521e92eaa849f8` with image digest `sha256:e1a8a133751d95f396ea7229a761da585c141fa4632b405ed0a189e17eed57a0`. Public API, dashboard, authenticated contract, backup/preservation, SQLite v4 integrity, and restart gates passed.
