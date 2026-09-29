# Cukup roadmap

**Current scope: personal Amp maintenance and public-release preparation.** Other harnesses, stable SDK work, and multi-user support are paused indefinitely. Production remains Amp-only v1/v2.

## What does public-release preparation mean?

[Issue #27](https://github.com/zainfathoni/cukup/issues/27) sets the intended direction: an Amp-first open-source release that others can inspect, adapt, and host. This is intended adoption, not current capability. The repository stays private, the hosted dashboard stays restricted to its owner, and independent self-hosting is not verified. The public page at `cukup.dev` must describe that status until a release is complete and verified.

GitHub issues own scoped work and acceptance criteria. ADRs own durable decisions. Review priorities monthly; retained plans do not authorize implementation or deployment.

## What work is active?

- Preserve the owner's personal Amp workflow.
- Reconcile completed Fleet rollout issues [#30–#33](https://github.com/zainfathoni/fleet/issues/30).
- Make deployment failures externally visible.
- Rehearse backup restoration and rollback regularly.
- Preserve the release policy: changes outside service-image inputs must not cause automatic service publication or deployment.

## Generic Harness Adapter initiative

**Paused.** Resume only after a new owner decision and a concrete user need. [ADR 0007](docs/adr/0007-generic-harness-evidence-boundary.md) governs this work. [ADR 0008](docs/adr/0008-do-not-infer-working-time-from-agent-runtime.md) rejects runtime-based estimates of human collaboration.

The retained sequence is:

1. Agree on language, ownership, and privacy.
2. Separate Amp observation without changing existing behavior.
3. Validate an experimental evidence protocol.
4. Verify durable local delivery and installation.
5. Validate separate measurements without changing authoritative totals.
6. Validate real collectors before an owner-approved accounting transition.

The experimental receiver and Amp collector exist. The [orb proof](docs/incidents/2026-09-13-experimental-amp-proof.md) used temporary activation. It did not establish repeatable installation, service packaging, physical-machine support, or human-interaction evidence.

Remaining gates:

- Verify installation, restart, delivery, and removal on macOS, Linux, and Amp orbs before claiming support.
- Review cloud storage, aggregation, migration, and dashboard changes separately.
- Require three real harness integrations plus limited-capability and recovery tests before stable SDK compatibility.
- Require shadow validation, dashboard readiness, and explicit owner acceptance of coverage before changing authoritative accounting.
- Use one owner-approved Monday at 00:00 Asia/Jakarta for the account-wide transition.

Stable compatibility and accounting transition are separate approvals. Neither experimental conformance nor an unmerged Tycho fork establishes official support.

## What must precede external contributions?

If external adoption resumes, require contributor-branch checks without secrets or publication access. Also require credential-free fixtures for the relevant adapter path, scoped issues, and verified collector capabilities.

Repeatable onboarding, exports, further harnesses, optional cost telemetry, team features, and distribution choices remain possibilities, not commitments.
