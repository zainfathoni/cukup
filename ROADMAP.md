# Cukup roadmap

> **Status: accepted product direction.** Outcomes are commitments of direction, not claims that their implementations exist. The deployed product remains Amp-only with event schemas v1/v2 until prospective outcomes pass their own review and rollout. [ADR 0007](docs/adr/0007-generic-harness-evidence-boundary.md) is the current Harness Adapter authority.

Cukup is a privacy-first WakaTime for AI-assisted work. Future Working Time is an interaction-based estimate from explicit human observations; Agent Runtime measures evidenced execution separately, excluding explicit waiting for human input. Tokens, cost, prompts, and output volume are not substitutes for either metric.

GitHub issues own scoped work and acceptance criteria; ADRs record durable decisions. Review this roadmap monthly and change outcomes when evidence changes.

## Now — establish the product foundation

- Reconcile and close or rescope completed Fleet rollout issues #30–#33.
- Make deployment failures externally visible and rehearse backup restoration and rollback on a routine schedule.
- Keep path-aware release automation and its deployment-operator selection contract covered by regression checks: documentation-only, plugin-only, and other non-image changes must not publish an image, create a service release version, or trigger production deployment.
- Complete external-implementation-contributor readiness: safe pull-request CI, credential-free integration fixtures, and scoped work with executable acceptance criteria.
- Establish the generic Harness Adapter foundation below. GitHub issue **#3 (production deploy speed/self-healing)** has a separate owner and is outside this initiative; operations bullets above are not adapter deliverables.

## Generic Harness Adapter initiative

Each stage is independently reviewable. Routine engineering decisions belong within its scope; return to the owner for changes to metric semantics, privacy, compatibility, or first-party support scope. These stages are a plan, not blanket implementation or deployment authorization.

| Stage | Deliverable | Gate before proceeding |
| --- | --- | --- |
| 1. Documentation foundation | Supersede ADR 0006; reconcile product language, contribution boundaries, and candidate Tycho guidance with ADR 0007. | No active-doc claim that the new metrics/protocol are deployed or that an unmerged Tycho contract is accepted. |
| 2. Preserve Amp behavior | Isolate native Amp observation behind an internal legacy boundary. | Existing and focused characterization tests preserve v1/v2 records, recovery, ordering, attribution, synchronization, and totals. No new metric semantics. |
| 3. Experimental protocol | Review version negotiation, explicit capabilities, closed evidence families, identity, timing, and conformance fixtures. | Rich, partial, and process-lifecycle-only sources map without invented human origin or execution time. Specify conflicts, unsupported versions, clocks, duplicates, and recovery. No stable SDK promise. |
| 4. Durable receiver | Implement bounded delivery, persist-before-acknowledgement, safe retries, execution-site binding, and secure caller-managed local runtime provisioning; allow separate collectors and approved embedded packaging. Immediate, retry-safe receiver-token rotation with no overlap, Cukup-project Amp-orb service packaging, and a standalone user-level installer are implemented for the experimental runtime. | Restart, offline delivery, storage failure, replay, conflicting IDs, prohibited-field, lifecycle, ownership, stale-discovery, rotation-boundary, and one-host native macOS LaunchAgent and Linux systemd-user tests pass; measurement failure cannot indefinitely block AI work. |
| 5. New measurements in shadow | Separately review cloud protocol/persistence, aggregation, migration, and dashboard slices. | v1/v2 and queued data remain unchanged; union, late evidence, cutover clipping, and unresolved runtime are tested. Dashboard distinguishes estimated, runtime, and legacy metrics, coverage gaps, and unavailable data. |
| 6. Real collectors and opt-in cutover | Validate supported Amp, Tycho, Claude Code, or other surfaces without fixing their order in advance. | Stable compatibility requires three real harness integrations plus weak-capability/recovery tests. Authoritative cutover separately requires shadow validation, dashboard readiness, and explicit owner acceptance of coverage and one Monday 00:00 Asia/Jakarta account-wide transition. |

Stable SDK publication and accounting cutover are distinct gates; neither implies the other. Collectors may be first-party, harness-owned, or third-party, embedded or separate. Protocol compatibility is not official support. An unmerged Tycho fork cannot satisfy a supported integration gate.

### Stage 4 durable receiver substage ledger

This ledger is the authoritative implementation sequence within top-level Stage 4. Completion means the experimental slice and its focused contract tests exist; it does not claim deployment, stable compatibility, or first-party operating-system support.

| Substage | Status | Independently reviewable deliverable |
| --- | --- | --- |
| 4A | Complete | Transport-independent durable receiver core with persist-before-outcome, immutable negotiation/site binding, replay, conflict, and pending-segment behavior. |
| 4B1 | Complete | Authenticated, bounded IPv4-loopback HTTP transport around the caller-owned receiver. |
| 4B2 | Complete | Explicit-drain collector client with a bounded sanitized durable spool and retry-safe FIFO delivery. |
| 4B3A | Complete | Caller-managed secure state-directory provisioning, SQLite runtime ownership, endpoint publication/discovery, and clean stop. |
| 4B3B | Complete | Immediate synchronous receiver-token rotation with no credential overlap and reconcile-or-withdraw failure behavior. |
| 4B3C | Complete | Foreground Bun receiver command with strict arguments and serialized `SIGHUP` rotation plus `SIGTERM`/`SIGINT` shutdown. No daemonization or autonomous delivery poller. |
| 4B3D | Complete experimental slice | Committed non-portal `.amp/services.yaml` packaging for Cukup project orbs, using Amp's assigned port and an owner-only durable state directory. Actual ensure, restart, stop/withdrawal, persistence, and idempotent re-ensure were verified without making an official Amp support claim. |
| 4B3E | Complete experimental slice | Standalone user-level install/start/status/stop/remove with session-only systemd/LaunchAgent definitions, active replacement refusal, rollback, retained state, and fixed diagnostics. Deterministic platform boundaries, native systemd syntax, standalone Linux foreground lifecycle, and one-host native macOS LaunchAgent and Linux systemd-user lifecycles verified. |
| Experimental Amp shadow collector | Complete experimental slice | Real supported Amp hooks produce live, Unassigned execution segments without claiming engagement evidence, recovery, or official Amp support. |
| Actual Amp-orb technical proof | Complete experimental slice | [Corrected proof](docs/incidents/2026-09-13-experimental-amp-proof.md) used temporary activation—not installer or service packaging—and established actual hooks across consecutive turns, supervised receiver lifecycle, durable outage spooling, receiver-restart retention, and plugin-reload rediscovery and drain. The expected restart-lost open segment remained pending. There are no autonomous retries; endpoint changes require plugin reload; no engagement evidence was established. This is not macOS, Linux, official support, packaging-completion, deployment, or cutover evidence. |
| Remaining Stage 4 work | Complete for the current experimental scope | Persistent login/restart policy remains outside the explicit session-only installer. One-host lifecycle evidence does not establish general OS support, and the Cukup-project Amp-orb declaration does not install the receiver in arbitrary non-Cukup projects. |

### Stage 5 shadow measurement substage ledger

| Substage | Status | Independently reviewable deliverable |
| --- | --- | --- |
| 5A | Complete internal foundation | [Service-side shadow persistence](docs/stage-5a-shadow-persistence.md): closed generic evidence validation, append-only isolated schema 5 tables, immutable collector/site and evidence identity, source ordering, and durable pending/closed endpoints. No cloud route, collector connection, or measurement totals. |
| 5B | Complete service-only slice | [Authenticated cloud shadow ingestion](docs/stage-5b-shadow-ingestion-api.md): physical bearer-only HTTPS route, required immutable executor profile, server-derived random execution site retained through rotation, closed outcomes, and no legacy mutation. No uploader or OIDC/Amp-orb ingestion. |
| Remaining Stage 5 work | Deferred to separate slices | Collector upload/outbox, execution-site design for OIDC/Amp-orb ingestion, aggregation/union, cutover clipping, dashboard/coverage presentation, and historical migration/backfill. |

Stages 5A and 5B change service persistence and are **not deployment-neutral**: an eventual main push may trigger service publication and requires explicit owner approval. No deployment or production migration is authorized by this ledger. Support claims and top-level Stage 6 real-collector validation and owner-approved opt-in cutover remain separate gates.

### First independently reviewable code slice

After documentation review, extract only the native Amp observation responsibility from the existing plugin into an internal legacy adapter boundary. Preserve the existing persistence transaction, local native-key recovery, random wire identities, sequence/outbox behavior, project resolution, v1/v2 payloads, and historical grace/crash-cap aggregation. Keep the legacy boundary explicitly separate from future Engagement Observations and execution intervals.

Use existing tests plus focused characterization cases for callback/state recovery, duplicates and restart, completed versus unmatched turns, and attribution. Run `bun run check`. This slice must not introduce a daemon, new protocol, new metric, Tycho collector, project-rename fix, dashboard change, or historical migration. Review its diff as a behavior-preserving refactor before starting protocol behavior changes.

### Rollout invariants

- Explicit human interactions alone open or renew 15-minute estimated Working Time windows; execution does not extend them. Missing observations bound a richer-observation window metric, not actual human attention.
- Agent Runtime initially includes only defensible closed execution intervals, excluding explicit human-input waits. Pending work contributes no provisional duration; missing endpoints remain unresolved.
- The dashboard keeps target-bearing **Working Time · estimated**, targetless **Agent Runtime**, and historical **Legacy Working Time · turn-based** distinct across charts, filters, and summaries. Never add these overlapping metrics together or fill missing evidence with zero.
- Account-wide cutover preserves complete legacy records separately; only independently collected new evidence contributes to new metrics after the boundary. Late evidence belongs to occurrence time and may increase past totals.
- Rollback may pause collection and disclose gaps, but retains accepted records, queues, and compatible ingestion. Returning to legacy target accounting requires a separate owner decision.
- Attribution uses approved project mappings or explicit bindings, never paths or repository guesses. Native renames refresh future activity automatically; no rename approval workflow or historical relabeling is required.

## External-contributor readiness checkpoint

Cukup is ready for design contribution now. External implementation needs the relevant gates below, not production access:

- [x] MIT contribution terms are explicit.
- [x] `CONTRIBUTING.md` documents setup, boundaries, review expectations, and `bun run check`.
- [x] Accepted generic ownership and metric decisions are independent of native Amp/Tycho APIs.
- [x] Zain Fathoni is the initial Cukup maintainer; upstream maintainers own acceptance of their native API changes.
- [ ] Contributor-branch CI runs all non-secret checks and cannot publish or deploy.
- [ ] Credential-free fixtures exercise the relevant local service and adapter path without Fleet or production access.
- [ ] Each implementation slice has scoped work recording non-goals, privacy constraints, and executable acceptance criteria.
- [ ] Each collector proposal verifies its actual supported surfaces and capability limits; no assumed Tycho open-run contract.

## Next — broaden personal use

- Make installation and onboarding repeatable without access to the creator's Fleet repository or production environment.
- Add privacy-safe composition observations where supported, independently of other harness capabilities.
- Add useful personal exports, goals, and project/agent activity views while keeping time distinct from tokens, cost, and outcomes.

## Later — expand the product surface

- Evaluate further Harnesses based on demand, evidence fidelity, and privacy-safe coverage.
- Offer token and cost telemetry as optional, separately named dimensions if it preserves the privacy contract.
- Explore multi-user tenancy, team privacy controls, aggregate reporting, and organization-level workflow trends.
- Decide whether long-term distribution is hosted, self-hosted, or both.
