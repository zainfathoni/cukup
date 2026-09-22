---
status: accepted
---

# Keep harness-specific collection outside Cukup's measurement core

> **Current scope:** Generalization is paused. Production remains Amp-only with schemas v1/v2. This ADR is the authority if generalization resumes.

## Context

Cukup must separate native Harness APIs from measurement policy. A common outbox and receiver avoid duplicate delivery implementations. Compatibility does not imply first-party support.

Agent Runtime means evidenced inference and tool execution. It excludes waiting for a person. It is not CPU use or process lifetime. A collector that cannot detect waiting must disclose this limit. Count only closed intervals with defensible endpoints. Mark unfinished work pending. Do not fabricate an end or apply the legacy Working Time crash cap.

Closed schemas and review reduce collected data. They do not contain a malicious collector. Installation is a trust decision.

## Decision

The owner approved these decisions. This ADR supersedes [ADR 0006](0006-harness-adapter-ports.md). It keeps native collection separate from policy and preserves v1/v2 history. It removes mandatory Cukup-owned Tycho collection, the ban on harness-resident collection, and automatic run-to-runtime mapping.

1. Cukup owns the generic receiver, accounting, and delivery. Cukup, Harness authors, or third parties can own collectors. Collectors can run in-process or separately. First-party examples do not require upstream adoption.
2. Future Working Time uses 15-minute Engagement Windows. Only explicit human interactions open or renew them. Agent execution does not. This metric estimates interaction windows, not attention. Missing observations are a lower bound on observable windows, not on human effort.
3. Deployed v1/v2 keeps completed-turn intervals, 15-minute grace, and its historical meaning.
4. Keep target-bearing **Working Time · estimated**, targetless **Agent Runtime**, and **Legacy Working Time · turn-based** separate. Never add them. The dashboard must show this distinction before a cutover.
5. Distinguish limited capability, known gaps, and unavailable data. Do not replace missing data with zero. Permit live-only collectors only with visible loss and recovery limits.
6. Use the Cukup background receiver for separate processes when practical. Embedded packaging can use the same core.
7. Initial first-party support, if resumed, covers macOS and Linux physical machines and Amp orbs only after install, delivery, restart, and removal tests. Defer native Windows and other clouds.
8. Collect at the execution site with its own authenticated executor binding. Cross-host collection needs a separate attribution and authentication decision.
9. Map stable native project identities to Cukup Projects. Matching names alone must not merge projects. If no stable path-free identity exists, permit an explicit launch or session binding. Keep missing or ambiguous mappings Unassigned. Never infer from paths, repositories, or prompts.
10. Snapshot project mapping when an observation is recorded or an execution interval starts. Later mapping changes affect future evidence only. Permit automatic future-name refresh without an approval workflow or historical relabeling. Old and new names can coexist.
11. Keep native project IDs local. Treat occasional stale labels as acceptable for this personal product. Do not relax privacy or metric separation.
12. Keep the local protocol experimental and version-negotiated. Protocol changes must not reinterpret accepted or queued cloud evidence.
13. Require three real Harness integrations plus weak-capability and recovery tests before a stable compatibility promise.

## Transition and failure rules

- Start new Working Time at one owner-approved Monday, 00:00 Asia/Jakarta. Require shadow validation, dashboard readiness, and explicit acceptance of coverage gaps.
- Keep crossing legacy records complete. Only independent new evidence can contribute to new metrics after cutover. Clip closed execution intervals for reporting; do not invent boundaries.
- Assign evidence to occurrence time, not upload or finalization time. Late evidence can update earlier totals. Show pending and synchronization state.
- A rollback can pause collection but must retain accepted records and queued uploads. Do not silently restore turn-based evidence as new Working Time. A return to legacy target accounting needs a new owner decision.
- Do not let measurement failure stop AI work. Persist with bounded effort, report failures, replay where possible, and disclose gaps. Never acknowledge evidence that was not persisted.
- Reject invalid or uncertain evidence. Do not repair it into a measurement or log raw payloads. Identity conflicts do not overwrite facts. Unknown human origin creates no Working Time.

## Rejected or deferred alternatives

- Do not equate protocol compatibility with official support.
- Do not report an elapsed run as Agent Runtime when waiting cannot be excluded.
- Defer a separate elapsed-run metric. Keep run-lifetime diagnostics local.
- Do not promise malicious-collector containment without a designed isolation boundary.
- Do not freeze transport, database layout, batch size, retry timing, or dashboard layout in this ADR.
- Do not require the unmerged Tycho fork. GitHub issue #3 is outside this decision.

## Consequences

- Generalization requires independently reviewed implementation slices under the [roadmap gate](../../ROADMAP.md#generic-harness-adapter-initiative).
- A semantic, privacy, compatibility, or support-scope change requires a new owner decision.
- The owner interview did not authorize dashboard implementation.
- Current production behavior and historical records remain unchanged while work is paused.
