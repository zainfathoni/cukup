# Contributing to Cukup

Cukup welcomes design contributions now. Implementation contributions are ready only after the relevant roadmap checkpoint is green. Zain Fathoni is the initial maintainer and owns Cukup's domain, protocol, privacy, and production decisions. A contribution never implies access to production, Fleet, credentials, or deployment authority.

Contributions are provided under the [MIT License](LICENSE). Changes submitted upstream to another project, including Tycho, follow that project's contribution terms.

## Start with the contracts

Read these before proposing a behavior change:

- [Product vision](docs/product/vision.md)
- [Domain language](CONTEXT.md)
- [Roadmap](ROADMAP.md)
- [Harness-adapter ADR](docs/adr/0006-harness-adapter-ports.md)
- [Service API](docs/service-api.md)
- [Tycho adapter contract](docs/tycho-adapter.md) for Tycho work

The deployed v1/v2 protocol still measures Amp turn intervals under its historical semantics. The accepted Working Time/Agent Runtime split is prospective and must not be described as already implemented.

## Local setup and verification

Clone and check out `origin/main`. A stale local `main` in an existing clone may be a replayed history that does not contain the current contracts, so verify `git rev-parse HEAD` against `origin/main` before reading or branching.

Use Bun 1.3.10 and install the lockfile exactly:

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` runs tests, TypeScript checking, and plugin/service/browser builds. It is the required local gate.

`.github/workflows/checks.yml` runs the same gate on every pull request and branch push. It holds read-only permissions, reads no secrets, and has no registry or deployment step, so it cannot publish or deploy. Publication remains confined to `publish-service.yml` on `main`.

Two things to expect. This repository may require maintainer approval before workflows run on a first-time contributor's pull request; if your first run appears not to start, it is waiting for approval rather than broken. And `bun install --frozen-lockfile` executes dependency lifecycle scripts, matching the documented local gate; the runtime dependency surface is deliberately one package.

### Credential-free verification

`service/fixture.ts` exports `createLocalStack()`, the supported way to exercise the adapter path and the service contract together without Fleet access, a production credential, DNS, or network egress. It gives you a plugin store, a service store, the service application in-process, and a sync engine wired between them, with SQLite in a temporary directory, a bearer issued by the local store, workload OIDC always denying, and an injected clock. `close()` removes everything.

Use it for new adapter or service behavior instead of assembling stores by hand, and never reach for a real token, hostname, or remote URL in a test. `service/integration.test.ts` is the worked example. The fixture is test-only and is not re-exported from a shipped entry point. It currently covers the local service and the Amp adapter path; a Tycho fixture arrives with the Tycho adapter.

## Architecture boundaries

- Harness Adapters observe native systems and emit harness-neutral evidence.
- The Cukup core owns durable local evidence, privacy normalization, identity generation, schema negotiation, outbox ordering, retry, and synchronization.
- Adapters never construct wire events, write the outbox, infer from workspace paths or Git metadata, or transmit native conversation identifiers.
- The service owns immutable ingestion, global interval union, authoritative targets, and summaries.
- Preserve existing behavior before changing metric semantics. Refactor Amp behind the adapter ports separately from introducing new event schemas or aggregation behavior.

## Privacy and repository hygiene

Never commit or include in issues, tests, fixtures, logs, screenshots, or review artifacts:

- credentials, tokens, cookies, OAuth codes, or identity claims;
- prompts, model output, transcripts, or source code from tracked work;
- private workspace paths, Git remotes, machine details, native session IDs, or Amp thread/message IDs;
- production database rows or sensitive operational output.

Use synthetic fixtures and random identifiers. Unknown event fields must continue to fail closed.

## Pull requests

Before implementation, link a scoped issue and any decision-bearing ADR. A pull request should include:

- the intended outcome and explicit non-goals;
- contracts and invariants affected;
- verification commands and decisive results;
- migration and rollback implications;
- privacy review, including fields observed locally, persisted locally, transmitted, and logged;
- visual evidence for dashboard changes.

Do not combine a behavior-preserving adapter refactor with a metric, protocol, or aggregation change. Do not deploy, publish, rotate credentials, modify production, or update Fleet state as part of ordinary contribution verification.
