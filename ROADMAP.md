# Cukup roadmap

Cukup is a privacy-first WakaTime for AI-assisted work. It measures time spent collaborating with AI agents across projects and executors without collecting prompts, source code, workspace paths, or conversation identifiers.

The primary metric is **AI-assisted working time** inferred from agent activity. Token usage, model cost, prompt count, and output volume are separate dimensions and are not substitutes for working time.

This roadmap records product outcomes, not an implementation backlog. GitHub issues should own scoped work and acceptance criteria; ADRs should record durable product and architecture decisions. Review this document at least monthly and move outcomes as evidence changes.

## Now — establish the product foundation

- Record the completed final-runtime fleet canary and reconcile the completed Fleet rollout issues.
- Update repository and operations documentation to reflect the deployed service, dashboard, attribution, backup, and automated deployment paths.
- Define the canonical AI-assisted-working-time metric, terminology, limitations, and user-facing explanation.
- Make deployment failures externally visible and rehearse backup restoration and rollback on a routine schedule.
- Reach the external-contributor readiness checkpoint below.
- Define and record a ports-and-adapters architecture for agent harnesses. The harness-neutral port must accept normalized activity while the Cukup core retains ownership of session durability, timing, attribution, outbox delivery, and privacy enforcement.
- Co-design the Tycho adapter contract with Tycho's creator: map Tycho's natural lifecycle to the harness-neutral port, settle which repository owns the adapter, and preserve Cukup's semantics without requiring production credentials.

## Next — support Tycho and broaden personal use

- Move the existing Amp lifecycle integration behind the harness port without changing its behavior, making Amp the first adapter rather than the core domain model.
- Ship and document Tycho as the second adapter, with deterministic local tests and end-to-end acceptance against a local Cukup service.
- Prove that concurrent Amp and Tycho activity is unioned rather than double-counted and remains attributable to the correct project and executor.
- Make installation and onboarding repeatable for a user who does not have access to the creator's Fleet repository or production environment.
- Validate that a third harness can implement the port without changing Cukup's core or weakening the closed event schema.
- Add useful personal exports, goals, and project/agent activity views while keeping working time distinct from tokens, cost, and outcomes.

## Later — expand the product surface

- Evaluate integrations with other coding-agent environments based on user demand and lifecycle fidelity.
- Offer token and cost telemetry as optional, separately named dimensions if it can preserve the privacy contract.
- Explore multi-user tenancy, team privacy controls, aggregate reporting, and organization-level workflow trends.
- Decide whether the long-term distribution model is hosted, self-hosted, or both.

## External-contributor readiness checkpoint

Cukup is ready to invite an external implementation contribution when all of these are true:

- Repository access and licensing or other contribution terms are explicit.
- `CONTRIBUTING.md` documents setup, architecture boundaries, coding conventions, review expectations, and `bun run check` as the required local gate.
- A contributor can run the relevant service and integration tests locally with fixtures, without Fleet access, production credentials, personal tokens, DNS, or deployment access.
- The harness port and the event, timing, attribution, authentication, and privacy contracts needed by an adapter are documented independently of the Amp implementation.
- Fork or contributor-branch CI runs all non-secret checks and cannot publish images or deploy production code.
- The Tycho adapter has a GitHub issue defining repository ownership, lifecycle mapping, non-goals, privacy constraints, and executable acceptance criteria.
- At least one maintainer is named to answer design questions and review the contribution through completion.

Meeting this checkpoint means the contribution path is safe and understandable. It does not require exposing production operations or granting deployment authority.

## Tycho adapter acceptance outcomes

The Tycho adapter is complete when:

- ordinary Tycho activity reaches the harness-neutral port and creates durable starts and ends without synthetic production events;
- interrupted, offline, duplicate, and delayed delivery converge through the same append-only semantics as other Cukup sources;
- project and executor attribution use canonical, non-sensitive identifiers and fail closed when attribution is ambiguous;
- transmitted and logged data stay within Cukup's documented privacy boundary;
- overlapping Amp and Tycho sessions do not inflate global working time;
- local end-to-end tests cover lifecycle mapping, retries, replay, attribution, aggregation, and prohibited fields;
- installation, authentication, troubleshooting, and removal are documented without relying on the creator's machine configuration.
