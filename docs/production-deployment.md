# Cukup production deployment path

This repository owns the Cukup service source, container image, and Kamal configuration. Production execution is intentionally separated from this checkout because the deployment requires the protected VPS, database, registry, and runtime-secret boundary.

## Release path

1. Merge the service change to the signed `main` branch.
2. The `Publish service image` workflow runs on `push` to `main` when an image input changes (`service/`, `Dockerfile.service`, `package.json`, `bun.lock`, or `tsconfig.json`). It validates the source, builds `linux/amd64`, and publishes `ghcr.io/zainfathoni/cukup:<main-sha>` with the service and revision labels.
3. The protected off-site operator operator on `backup-host` observes successful **push-triggered** publication runs every 300 seconds. Its installed LaunchAgent invokes:

   ```text
   <private-operator-checkout>
   ```

4. The operator validates the signed `main` tip, selects the newest qualifying published ancestor, verifies the immutable image and architecture, creates and independently retrieves a database backup, then deploys through Kamal using:

   ```bash
   VERSION=<selected-main-sha> kamal deploy --skip-push
   ```

5. It verifies public API and dashboard health, authenticated API/dashboard behavior, database integrity and preservation, and normal restart persistence. It records the deployed immutable image and retains the prior migration-aware image for rollback.

The operator selects the newest qualifying ancestor after the publication cutover commit, currently `65f9c50b991886efb3dfdc5f9027b51ab26201dc`, with a successful push publication. A manually dispatched publication is not selected automatically. Documentation-only and plugin-only changes therefore do not create a service release or trigger deployment.

## Local operator boundary

Do not deploy from an ordinary Cukup checkout or copy production secrets into the repository, command arguments, GitHub issues, or Amp messages. Until the staged Actions canary below succeeds, the off-site operator operator remains the active protected Kamal boundary. A local runner without either protected operator environment must stop after confirming the signed `main` commit and successful image publication, then report the deployment as pending operator reconciliation.

## Staged GitHub Actions canary

`Deploy service` is the staged replacement for the off-site operator execution boundary. It is intentionally manual-only until an owner-approved canary succeeds. Its `preflight` operation verifies an exact full SHA, successful push publication, signed-main ancestry, immutable image contract, rendered Kamal configuration, absence of a remote deploy lock, current runtime/database integrity, and public service behavior without mutation. Its `deploy` operation additionally creates and independently verifies a fresh backup, proves pre-deploy preservation, deploys the exact image, repeats the runtime/public/database/preservation gates, and attempts a verified rollback after a post-switch failure.

The workflow uses a protected GitHub `production` environment and supports these variables:

- optional deployment overrides; the checked-in defaults use `zainfathoni/cukup`, VPS address `192.0.2.10`, SSH user `deploy-user`, and registry user `zainfathoni`;
- optional hostname/path overrides, which otherwise use `api.cukup.dev`, `cukup.dev`, `/srv/example-cukup-data`, and `/srv/example-cukup-backups`.

It requires environment secrets `SSH_PRIVATE_KEY`, `SSH_KNOWN_HOSTS`, `KAMAL_REGISTRY_PASSWORD`, and every runtime secret named by `config/deploy.service.yml`. `CUKUP_API_TOKEN` is optional and enables the existing authenticated read-only acceptance probes; without it, public API/dashboard, OAuth-start, image, backup, and database gates still run. Secret values must be provisioned from an approved source rather than copied from another repository's GitHub secrets.

Run `preflight` before the first `deploy`. off-site operator may remain offline, but it must not return with its LaunchAgent able to mutate production: disable that operator or revoke its deploy authority before off-site operator comes back. Do not release a remote lock merely because its originating machine is offline; reconcile the prior mutation first. Automatic successful-publication triggering is enabled only after the manual canary and rollback readiness pass.

## Release verification

For a release at `<sha>`, confirm the following without exposing credentials or identity-bearing responses:

```bash
gh api repos/zainfathoni/cukup/commits/<sha> --jq '.commit.verification'
gh run list --repo zainfathoni/cukup --workflow publish-service.yml --json headSha,status,conclusion,event,url
curl --fail --silent https://api.cukup.dev/up
curl --fail --silent https://api.cukup.dev/healthz
```

The first two checks prove the signed source and same-revision push publication. The unauthenticated endpoints prove liveness only; the protected off-site operator operator is responsible for the authenticated, database, backup, and dashboard acceptance checks.

## Follow-up issues

The reliability improvements are tracked under parent issue [#3](https://github.com/zainfathoni/cukup/issues/3):

- [#4 — Add bounded deployment preflight and self-healing](https://github.com/zainfathoni/cukup/issues/4) can start immediately.
- [#5 — Reduce production deployment detection latency](https://github.com/zainfathoni/cukup/issues/5) is a child of #3 and is blocked by #4.
- [#6 — Add deployment observability and failure alerting](https://github.com/zainfathoni/cukup/issues/6) is a child of #3 and is blocked by #4.

## Current example

PR #2 merged as [`586d8fa`](https://github.com/zainfathoni/cukup/commit/586d8fa27d31a4c7c0505ed8d5521e92eaa849f8). Its push publication completed successfully in [workflow run 34596552634](https://github.com/zainfathoni/cukup/actions/runs/34596552634). The off-site operator operator then completed the deployment with `outcome=success`, retaining the prior `545aa68` release for rollback. The running image is `ghcr.io/zainfathoni/cukup:586d8fa27d31a4c7c0505ed8d5521e92eaa849f8` with image digest `sha256:e1a8a133751d95f396ea7229a761da585c141fa4632b405ed0a189e17eed57a0`. Public API, dashboard, authenticated contract, backup/preservation, SQLite v4 integrity, and restart gates passed.
