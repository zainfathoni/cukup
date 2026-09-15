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
| 5C | Complete inactive physical-client slice | [Durable physical cloud shadow outbox](docs/stage-5c-physical-shadow-outbox.md): independent persisted collector identity/order, enqueue-before-network, exact Stage 5B upload, physical bearer/profile reuse, persistent bounded FIFO/backoff, fixed aggregate status, and durable terminal blockers. Explicit enqueue/drain only; no runtime activation or support claim. |
| 5D | Complete default-off experimental slice | [Physical Amp shadow integration](docs/stage-5d-physical-amp-shadow.md): exact physical-only opt-in, existing supported hook collector and file bearer/profile, dedicated durable outbox, bounded lifecycle/explicit drains, aggregate-only status, and legacy isolation. In-process integration verification only; no physical production run, installer integration, or support claim. |
| 5E | Complete internal shadow slice | [Pure shadow aggregation](docs/stage-5e-shadow-aggregation.md): accepted human 15-minute windows and closed execution intervals, independent global unions, occurrence-time civil day/week reporting with as-of clipping, and non-additive immutable project/site lanes. No production caller, authority, dashboard, target comparison, or cutover. |
| 5F | Complete internal reporting slice | [Cutover clipping](docs/stage-5f-cutover-clipping.md): caller-supplied exact Monday 00:00 Asia/Jakarta validation and post-boundary clipping of generic shadow Engagement Windows and closed execution intervals. No cutover selection, persistence, approval, activation, production caller, or legacy reinterpretation. |
| 5G | Complete design-contract slice | [Shadow coverage contract](docs/stage-5g-shadow-coverage-contract.md): orthogonal closed vocabulary and ownership for capability declarations, explicit irreversible loss, availability, pending execution, and separately reported synchronization. Defines privacy-safe durable facts and acceptance cases without schema, API, runtime, aggregate, or dashboard implementation. |
| 5H | Complete internal persistence slice | [Coverage protocol and persistence](docs/stage-5h-shadow-coverage-persistence.md): closed capability declarations and irreversible-loss facts with schema-7 append-only storage and collector/site isolation. No HTTP route, collector activation, projection, or backfill. |
| 5I | Complete internal projection slice | [Shadow disclosures](docs/stage-5i-shadow-disclosures.md): consumes Stage 5H accepted coverage facts and evidence snapshots; source-scoped effective-time metric capability intervals, independently clipped immutable losses, occurrence-scoped pending starts, and synchronization fixed at unknown. No totals coupling, availability wrapper, public route/schema, migration, dashboard, or runtime caller. |
| 5J | Complete design-contract slice | [Current synchronization observations](docs/stage-5j-shadow-synchronization-contract.md): closed bounded physical-bearer wire contract, independent durable observation order, revision-safe latest snapshot without history, expiry to unknown, privacy and failure isolation. Documentation only; no status upload, protocol/persistence implementation, projection integration, or dashboard. |
| 5K | Complete service-only slice | [Synchronization service](docs/stage-5k-shadow-synchronization-service.md): physical-bearer route, schema-8 latest snapshot, revision ordering, explicit trusted clock, and fresh/unknown internal reads. Default production clock remains untrusted; no client or dashboard activation. |
| 5L | Complete inactive physical-client slice | [Synchronization client](docs/stage-5l-shadow-synchronization-client.md): bounded spool snapshot, independent durable observation revision, and explicit one-step transport. Nothing schedules or invokes it automatically. |
| 5M | Complete internal projection slice | [Synchronization disclosures](docs/stage-5m-shadow-synchronization-projection.md): Stage 5K read hardening plus a pure classified-result input, registered status-only lanes, exact collector/site isolation, and current fresh state projection without totals, history, or project attribution. No production caller or activation. |
| 5N | Complete internal delivery slice | [Shadow availability delivery](docs/stage-5n-shadow-availability-delivery.md): ready delivery may expose current synchronization; stale delivery redacts it to unknown; unavailable carries no disclosures. Other dimensions remain independent and unchanged. No cache/report consumer, public schema, dashboard, or activation. |
| 5O | Complete authenticated dashboard slice | [Shadow disclosures dashboard](docs/stage-5o-shadow-disclosures-dashboard.md): schema-2 independent report panel, privacy-safe labels, Stage 5M/5N ready/stale/unavailable delivery, and accessible capability/loss/pending/synchronization rendering without totals coupling. No collector scheduling, clock-trust activation, cutover, migration, deployment, or support claim. |
| 5P | Complete design-contract slice; implementation externally blocked | [Workload OIDC execution-site contract](docs/stage-5p-oidc-execution-site-contract.md): required Amp-attested incarnation lifecycle, opaque service identity, immutable collector/replay ownership, and generic-only claim/privacy policy. Current documented tokens do not establish recreation-safe identity. Project attribution remains Unassigned and OIDC synchronization unsupported; legacy OIDC unchanged. No implementation or activation. |
| 5Q | Complete design-contract slice | [Legacy history and reporting authority](docs/stage-5q-legacy-history-authority.md): rejects legacy-to-generic evidence backfill and heuristic cross-authority deduplication; preserves legacy semantics and separates authority at a future owner-approved account-wide Stage 5F boundary. Defines independent reconciliation vectors and approval/backup/privacy gates; an optional audit ledger is non-authoritative and deferred. No implementation or activation. |
| 5R | Complete design-contract slice | [Durable authority activation](docs/stage-5r-authority-activation-contract.md): one owner-approved account-wide Monday 00:00 Asia/Jakarta boundary, durable approval and atomic activation, trusted-time and restoration fences, separate report/API/target routing, unavailable behavior and explicit coverage/readiness gates. No implementation, selected date, or activation. |
| 5S | Complete design-contract slice | [Authority control storage and recovery checkpoint](docs/stage-5s-authority-control-storage.md): closed account-owned decision/approval/idempotency records, serializable external journal and checkpoint-before-acknowledgment protocol, verified SQLite materialization, accepted-write restore frontier, retention and compatibility floors, and disposable-storage acceptance vectors. No persistence code, owner HTTP/auth or clock implementation, selected date, or activation. |
| 5T | Complete default-off delivery slice | [Physical coverage-fact delivery](docs/stage-5t-physical-coverage-delivery.md): strict physical-bearer Stage 5H route; one migrated evidence/coverage FIFO; exact retry, site/order, bounded failure and persist-before-ack semantics; and one truthful restart-idempotent prospective declaration from the existing opt-in Amp owner. No synthesized loss, OIDC, authority, report, dashboard, target, cutover, publication, deployment, or activation. |
| 5U | Complete default-off invocation slice | [Explicit physical synchronization](docs/stage-5u-explicit-physical-synchronization.md): one distinct command action invokes the existing Stage 5L singleton step and reports only its fixed result plus aggregate spool status. No startup/background/post-drain invocation, retry policy, FIFO coupling, clock/authority activation, service change, publication, deployment, or activation. |
| 5V | Complete design-contract slice | [Owner-approved evidence-time project attribution](docs/stage-5v-project-attribution-contract.md): immutable account-owned Project UUIDv4s, exact site-scoped native/explicit approvals, deterministic ambiguity, fresh serialized capture, immutable replay/start inheritance, restricted local proofs and rollback-safe recovery. No registry/mapping/collector implementation; Stage 5P remains Unassigned and blocked. |
| 5W | Complete design-contract slice; native support blocked | [Amp native project eligibility and recoverable capture](docs/stage-5w-amp-project-capture-contract.md): bounded exact path-free key/fingerprint policy, no currently eligible native source, separate owner approval and event-context gates, fresh serialized capture and fenced lost-ack recovery. No runtime implementation; production remains Unassigned and Stage 5P stays blocked. |
| 5X | Complete design-contract slice; implementation blocked | [Closed owner project and mapping controls](docs/stage-5x-owner-project-control-contract.md): exact owner-session HTTP operations, strict same-origin/pre-body auth, bounded duplicate-key-safe codecs, prospective revision/idempotency semantics, restricted mapping boundary and linearizable recovery-safe responses. No implementation until Stage 5S journal/commit-authority, trusted-time and recovery dependencies plus cross-boundary registry/mapping/capture fencing exist. |
| 5Y | Complete provider-comparison slice; no provider selected | [External commit authority and trusted-time decision](docs/stage-5y-commit-authority-provider-decision.md): bounded authoritative-source comparison of Spanner/TrueTime, single-Region DynamoDB/EC2 ClockBound and external etcd/ClockBound. No reviewed pair establishes atomic commit-time proof/predicates plus finalized recovery; registration, privilege, retention and rehearsal gates remain. No dependency, provisioning or implementation approved. |
| 5Z | Complete design-contract slice; implementation blocked | [Authority-aware report delivery](docs/stage-5z-authority-report-envelope.md): closed versioned legacy/generic sections, independent targetless runtime, unavailable versus observed-zero semantics, truthful legacy-only compatibility, private cache provenance and initial/refresh/release fences. No runtime/schema/API/client change, selected cutover, trusted clock or activation. |
| 5AA | Complete inactive wire-contract slice; implementation blocked | [Inactive authority-report transport](docs/stage-5aa-inactive-authority-report-transport.md): separate owner-session POST/version/media contract, bounded strict UTF-8 codecs, fixed failures, snapshot-only current-use refusal and session/generation/release fences. No route or consumer enabled; current-capable proof needs a new reviewed version. |
| 5AB | Complete inactive pure-codec slice | [Authority-report codec](docs/stage-5ab-authority-report-codec.md): bounded strict request/response parsing, closed Stage 5AA/5Z semantic validation, and canonical response encoding. No route, authority read/construction, dashboard/client import, current-use permission, or activation. |
| 5AC | Complete inactive pure-builder slice | [Authority-report snapshot builder](docs/stage-5ac-authority-report-builder.md): caller-classified exact authority partitions, independently floored globally unioned/clipped metric milliseconds, Stage 5N stale disclosure redaction, private-identity removal, and Stage 5AB-validated snapshot/refusal output. No authority/time proof, reads, route, consumer, selected cutover, current use, or activation. |
| 5AD | Complete inactive pure-client-state slice | [Authority-report client state](docs/stage-5ad-authority-report-client-state.md): opaque local session epochs, monotonic request-generation and exact-range settlement fences, strict codec-only snapshot admission, same-snapshot failure retention, and explicit lifecycle clearing. No fetch, route, timer, auth, storage, render, legacy fallback, runtime import, current use, or activation. |
| Remaining Stage 5 work | Deferred to separate slices | Resolve Stage 5P's external attestation/durability blockers before proposing OIDC/Amp-orb ingestion; separately resolve Stage 5W native lifecycle/non-reuse and event-context guarantees and implement/review Stage 5V/5W project registry, mapping authority and collector capture/recovery interfaces under Stage 5X's owner-control contract and refusal gates; separately review OIDC synchronization, any Stage 5Q audit tooling, and implementations of Stage 5R/5S control/recovery state and external journal, accounting owner controls, trusted time, report/API/client/target routing and activation gates. Legacy evidence backfill is rejected, not an implementation task. |

Stages 5A and 5B change service persistence and are **not deployment-neutral**: an eventual main push may trigger service publication and requires explicit owner approval. Stage 5C is deployment-neutral because its experimental client is not imported by a runtime, installer, receiver, or service build entrypoint; activation still requires the already reviewed Stage 5B/schema-6 service. No deployment or production migration is authorized by this ledger. Support claims and top-level Stage 6 real-collector validation and owner-approved opt-in cutover remain separate gates.

Stage 5D imports the Stage 5C client into the plugin behind a separate default-off opt-in. Its plugin/docs-only paths do not trigger service publication; no service schema, route, deployment configuration, or activation setting changes. This does not remove the separate publication/migration implications of the Stage 5A/5B prerequisites.

Stage 5E has no production caller or migration, but its `service/**` paths match the existing main-push service-publication workflow. It is **not publication-neutral**; any push/publication still needs explicit owner approval. Its zero totals or absent lanes describe only contributing intervals, not observation completeness or proof of no work.

Stage 5F remains a pure internal reporting boundary with no production importer. Its caller supplies the separately approved account-wide cutover; this slice neither chooses nor activates one. Like Stage 5E, its `service/**` paths are not publication-neutral and require explicit owner approval before any eventual push/publication.

Stage 5G is documentation-only and publication-neutral. It does not infer historical gaps, expose Stage 5C/5D local backlog to the cloud, or authorize a schema, API, dashboard, collector change, cutover, publication, or deployment. Its future coverage dimensions remain source- and occurrence-scoped rather than an account-wide completeness boolean.

Stage 5I remains pure and internal, with no production importer or migration. Its `service/**` paths are not publication-neutral. Stage 5H's separate schema-7 prerequisite and rollback constraints remain unchanged; no push, publication, deployment, or activation is authorized here. Empty disclosures do not establish completeness or no work.

Stage 5J is documentation-only and publication-neutral. It narrows Stage 5G's observation-history assumption without changing evidence/coverage immutability. Stage 5I still returns synchronization `unknown`; the design authorizes no implementation, activation, migration, push, or deployment.

Stages 5K and 5M change `service/**` paths covered by the main-push service-publication workflow and
are not publication-neutral. Stage 5K's default clock remains untrusted, and Stage 5M has no production
caller. Stage 5L had no caller before Stage 5U's explicit default-off action. None authorizes client scheduling,
clock-trust activation, publication, migration of a shared database, deployment, or production access.

Stage 5N is also pure and internal but changes `service/**`, so it is not publication-neutral. It has
no production importer or cache/report consumer. Availability cannot strengthen any coverage
dimension, stale delivery cannot retain current synchronization, and unavailable delivery carries no
usable disclosure result. No public schema, dashboard, activation, push, publication, or deployment
is authorized.

Stage 5O imports the Stage 5M projection and Stage 5N delivery boundary into the authenticated
dashboard's existing service runtime path, so it is not publication-neutral. Dashboard report schema
2 is an application response change, not a SQLite migration or authority switch. The default
production synchronization clock remains untrusted; no push, publication, deployment, shared-setting
change, production activation, or support claim is authorized.

Stage 5P is documentation-only and publication-neutral. It defines required future platform support,
not claims Amp currently attests or permission to enable generic OIDC ingestion. Existing physical
routes and legacy `amp-orb` attribution remain unchanged. Prerequisite publication/schema constraints
still apply; no clock, collector, API, dashboard, cutover, deployment, or support activation is authorized.

Stage 5Q is documentation-only and publication-neutral. Legacy rows cannot supply the missing generic
provenance or a deterministic cross-authority identity. Legacy remains target authority until a separate
owner-approved activation; historical legacy totals retain their semantics, including late revisions.
No migration, authority selection, database operation, publication, deployment, or support is activated.
Cumulative prerequisite publication/schema and rollback constraints remain unchanged.

Stage 5R is documentation-only and publication-neutral. Its future armed boundary prevents delayed
activation or restoration from silently extending legacy target authority; active post-boundary
targets use only independent generic engagement. Storage, clocks, owner controls, compatible consumers
and recovery remain implementation gates, and Stage 5P's OIDC blocker remains explicit. No date is
selected, no authority activated, and no cumulative prerequisite publication implication is removed.

Stage 5S is documentation-only and publication-neutral. SQLite may materialize the closed control
history, but cannot independently prove a backup has not rolled back. The external journal must
retain every committed authority/data frontier before acknowledgment; missing proof fails closed.
Version 1 retains committed recovery content from genesis; deletion/compaction needs a separate
policy. No owner operation, clock, storage migration, production infrastructure or authority is
activated, and cumulative prerequisite publication/schema implications remain unchanged.

Stage 5T changes both plugin and `service/**` publication inputs and is **not publication-neutral**.
The service schema remains 8, while the private physical spool advances additively to schema 3 and
preserves queued evidence plus AUTOINCREMENT high water. The owner remains exact-opt-in/default-off;
no production activation, publication, deployment, OIDC support, loss inference, or Stage 5R authority
decision is included. Rollback must retain a schema-3-aware spool owner and schema-8-aware service.

Stage 5U changes plugin/tests/docs only and is neutral under the service publication workflow, but it is a
plugin-build change: publishing it exposes the action only behind the existing exact physical/local opt-in.
It does not activate that opt-in, schedule synchronization, trust the service clock, mutate shared state,
or authorize a push, plugin publication, deployment, production access, or authority/cutover decision.

Stage 5V is documentation-only and publication-neutral. Only the existing project UUID/basis or
Unassigned reason may enter generic evidence; native selectors and approval/capture proofs stay
at the restricted collector/mapping authority. No offline positive lookup, historical relabeling,
legacy backfill, OIDC unblock, registry implementation or authority activation is included.
Cumulative prerequisite publication/schema/rollback constraints remain unchanged.

Stage 5X is documentation-only and publication-neutral. The allowed immutable GitHub owner session
is not an ingestion principal; physical bearer, OIDC, token-admin and native membership cannot approve.
No route or helper is implemented. Service registry writes require Stage 5S's all-mutator frontier,
and mapping/capture state remains restricted with equivalent rollback-resistant serialization.
Missing journal, time, authorization or recovery mechanisms block implementation, not merely rollout.
Cumulative prerequisite publication/schema/rollback constraints and Stage 5P/5W blockers remain.

Stage 5Y is documentation-only and publication-neutral. No provider is selected from the reviewed
public guarantees; Stage 5R/5S/5X implementation remains blocked on a supported atomic commit-time
proof/guard and finalized-recovery interface, independent non-reusable lineage and retained history.
Spanner is a research priority, not an accepted dependency. ADR 0003's backup policy remains intact;
new provider, credential, retention, cost and restore approvals remain separate. No external service
is provisioned or accessed with credentials; cumulative publication/schema/rollback gates remain.

Stage 5Z is documentation-only and publication-neutral. Old or stale reports cannot establish current
authority; generic absence never falls back to legacy or runtime-derived working time. Stage 5AA
pins wire budgets and a snapshot/refusal-only profile; compatible consumers and a current-capable
authenticated client validity proof remain implementation gates alongside
Stage 5R/5S/5Y's unresolved authority/time/recovery dependencies. No runtime, schema, API, dashboard,
client, target, clock trust, cutover or activation changes; cumulative publication gates remain.

Stage 5AA is documentation-only and publication-neutral. Its separate owner-session transport is
inactive and cannot supply current target progress: null validity/proof explicitly forbids current
use. Existing summary/dashboard routes and plugin fallback remain unchanged and cannot receive
generic data. Even snapshot implementation awaits 5R/S/Y authority/recovery and session fencing;
current delivery needs a new reviewed proof-capable version and all-consumer compatibility gates.

Stage 5AB implements only the pure inactive Stage 5AA request/response codec. Nothing imports it
from an application, route, store, dashboard, client, plugin, or build entrypoint, and it constructs
no authority data. Its `service/**` path nevertheless matches the main-push service-publication
workflow, so the slice is not publication-neutral. No push, publication, deployment, migration,
cutover, current-use permission, or activation is authorized; rollback is removal of the isolated
module/tests/docs while retaining all prerequisite schema-8 data and publication precautions.

Stage 5AC adds only a pure caller-classified builder atop Stage 5AB and Stage 5N. It consumes exact
already globally unioned/clipped millisecond metric snapshots, never reads or combines authorities,
and emits only codec-validated stale/refusal envelopes with current use forbidden. There is no
runtime importer or activation, but its `service/**` paths are publication-sensitive. Rollback
removes the isolated builder/tests/docs while preserving the cumulative schema-8 prerequisites.

Stage 5AD adds only a pure authority-report request/state reducer atop Stage 5AB. It admits response
bytes exclusively through the strict codec, installs only matching latest-generation HTTP 200
snapshots, and retains only an immutable same-session/range snapshot after fixed-category failure.
No runtime or browser bundle imports it. Its `service/**` paths remain publication-sensitive; rollback
removes this isolated module/tests/docs while preserving cumulative schema-8 prerequisites.

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
