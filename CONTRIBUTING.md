# Contributing to Cukup

Zain Fathoni owns domain, privacy, protocol, and production decisions. Contributions use the [MIT License](LICENSE). Upstream projects set their own contribution terms.

A public release is [in preparation](ROADMAP.md), not yet available. Discuss a scoped issue before implementation. A contribution does not grant production access or deployment authority.

## What must a change preserve?

Read the [product vision](docs/product/vision.md), [glossary](CONTEXT.md), and relevant [decisions](docs/adr/0007-generic-harness-evidence-boundary.md).

- Keep behavior-preserving refactors separate from metric or protocol changes.
- Preserve historical evidence and its meaning.
- Do not describe experimental compatibility as official support.
- Review collector trust separately from schema conformance. Validation does not contain a malicious collector.

## How do contributors verify work?

Use the Bun version in [package.json](package.json):

```sh
bun install --frozen-lockfile
bun run check
```

These are local checks, not publication steps. Use synthetic data and the [local integration fixture](service/fixture.ts), not production credentials or databases.

The `Cukup checks` CI job runs the same commands on Ubuntu for pull requests into `main` and pushes to `main`. CI does not publish or deploy. To block untested changes, require this check and require pull requests in the protection rules for `main`. A check on a direct push reports failures after the push; it does not block the push.

## What belongs in a pull request?

- The issue, intended outcome, and non-goals.
- Affected contracts and decisions.
- Verification commands and decisive results.
- Migration and rollback risks.
- Privacy review: data observed, stored, sent, and logged.
- Rendered evidence for visual changes.

Do not publish, deploy, rotate credentials, or change Fleet state during contribution checks.

## What must stay out of review artifacts?

Exclude secrets, identity claims, tracked prompts, output, and source content. Also exclude private paths, remotes, machine details, native session identifiers, and production rows. This applies to fixtures, logs, screenshots, and issues.

## What belongs in documentation?

Record purpose, rationale, external requirements, operating procedures, and unresolved decisions. Link to source for implemented behavior. Do not duplicate schemas, algorithms, or command registries.

Keep the README limited to context that source cannot provide. Use ASD-STE100 writing rules: short sentences, active voice, consistent technical terms, and one instruction per sentence. Keep necessary safety warnings.
