# Cukup roadmap

> **Status: accepted product direction as of 2026-09-06.** Outcomes below are commitments of direction, not claims that their implementations exist. The deployed product remains Amp-only with event schemas v1/v2 until each prospective outcome passes its own review and rollout.

Cukup is a privacy-first WakaTime for AI-assisted work. Its primary metric is Working Time: evidenced human collaboration with AI. Agent Runtime measures full scheduled and unattended execution separately. Token usage, model cost, prompt count, and output volume are distinct optional dimensions, not substitutes for either time metric.

This roadmap records outcomes, not an implementation backlog. GitHub issues own scoped work and acceptance criteria; ADRs record durable decisions. Review the roadmap monthly and move outcomes only when evidence changes.

## Now — establish the product foundation

- Reconcile and close or rescope completed Fleet rollout issues #30–#33.
- Make deployment failures externally visible and rehearse backup restoration and rollback on a routine schedule.
- Keep path-aware release automation and its deployment-operator selection contract covered by regression checks: documentation-only, plugin-only, and other non-image changes must not publish an image, create a service release version, or trigger production deployment.
- Complete external-implementation-contributor readiness: safe pull-request CI, credential-free integration fixtures, and a scoped Tycho issue.
- Agree and land Tycho's supported privacy-clean open-run read contract.
- Add privacy-safe prompt-composition observations independently to Harnesses that can support them. Until then, disclose submission-only Working Time as a lower bound.

## Next — support Tycho and broaden personal use

- Move the existing Amp lifecycle integration behind the harness port without changing its behavior, making Amp the first adapter rather than the core domain model.
- Design and roll out prospective protocol semantics that preserve historical v1/v2 Working Time while separately representing Engagement Window-based Working Time and Agent Runtime from an explicit transition.
- Ship Tycho as the second adapter: a per-machine 60-second reconciler over supported durable Tycho state, with hooks only as optional wake-ups.
- Prove that concurrent Amp and Tycho Working Time and Agent Runtime are globally unioned rather than double-counted and remain attributable to the correct project and Executor.
- Make installation and onboarding repeatable for a user who does not have access to the creator's Fleet repository or production environment.
- Add useful personal exports, goals, and project/agent activity views while keeping working time distinct from tokens, cost, and outcomes.

## Later — expand the product surface

- Validate the internal adapter port with a third Harness before publishing an adapter SDK or compatibility promise.
- Evaluate further Harnesses based on user demand, lifecycle fidelity, and privacy-safe evidence coverage.
- Offer token and cost telemetry as optional, separately named dimensions if it can preserve the privacy contract.
- Explore multi-user tenancy, team privacy controls, aggregate reporting, and organization-level workflow trends.
- Decide whether the long-term distribution model is hosted, self-hosted, or both.

## External-contributor readiness checkpoint

Cukup is ready for design contribution now. It is ready for external implementation contribution only when every unchecked gate is complete:

- [x] MIT contribution terms are explicit.
- [x] `CONTRIBUTING.md` documents setup, boundaries, review expectations, and `bun run check`.
- [x] Product language, Harness ports, and the Tycho contract are independent of the Amp implementation.
- [x] Zain Fathoni is the initial Cukup maintainer; Tycho's creator reviews Tycho-owned contract changes.
- [ ] Contributor-branch CI runs all non-secret checks and cannot publish or deploy.
- [ ] Credential-free fixtures exercise the relevant local service and adapter path without Fleet or production access.
- [ ] A scoped Tycho issue records lifecycle mapping, non-goals, privacy constraints, and executable acceptance criteria.
- [ ] Tycho's supported open-run read contract is agreed for implementation.

Implementation readiness never requires exposing production operations or granting deployment authority.

## Tycho adapter acceptance outcomes

The Tycho adapter is complete when:

- one Tycho managed run produces one Agent Runtime interval, while only explicit human interactions open or renew 15-minute Working Time windows;
- scheduled starts, automatic orchestration, liveness, generated output, finalization, and waiting do not independently create Working Time;
- interrupted, offline, duplicate, and delayed delivery converge through the same append-only semantics as other Cukup sources;
- reconciliation remains correct without hooks, runs every 60 seconds per machine, and reads only supported privacy-clean Tycho state;
- terminal runtime ends require durable terminal timestamps; crashes without one remain unmatched and crash-capped;
- project and Executor attribution use canonical non-sensitive identifiers, require explicit aliases when identities differ, and fail closed when ambiguous;
- transmitted and logged data stay within Cukup's documented privacy boundary;
- overlapping Amp and Tycho intervals do not inflate either metric;
- missing composition capability is visibly disclosed as lower-bound Working Time;
- local end-to-end tests cover lifecycle mapping, retries, replay, attribution, aggregation, and prohibited fields;
- installation, authentication, troubleshooting, and removal are documented without relying on the creator's machine configuration.
