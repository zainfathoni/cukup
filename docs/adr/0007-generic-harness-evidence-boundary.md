---
status: accepted
---

# Keep harness-specific collection outside Cukup's measurement core

Cukup owns the generic evidence receiver, accounting, and delivery; Harness Adapters may be maintained by Cukup, harness authors, or third parties and may run inside harnesses or as separate processes. First-party reference collectors establish supported examples without requiring upstream adoption or making protocol compatibility equivalent to official support. This separates native API compatibility from measurement policy without requiring every ecosystem to duplicate Cukup's outbox or cloud client.

Agent Runtime means evidenced agent execution, including inference and tool execution, not CPU utilization or elapsed process lifetime. Explicit waiting for human input is excluded: five minutes of execution, 55 minutes awaiting approval, and ten more minutes of execution contribute 15 minutes, not 70. A collector that cannot distinguish execution from waiting must disclose that limitation rather than report the entire run as execution. A third elapsed-run metric is deferred; run-lifetime diagnostics remain local, and independently supported human observations remain eligible for Working Time.

Initial Agent Runtime totals include only closed execution intervals with defensible endpoints. Observable unfinished work is marked pending without contributing provisional duration; a missing endpoint never receives a fabricated completion time or the historical Working Time crash cap.

The privacy promise is reviewed, minimized collection with strict closed-schema validation, not containment of malicious collectors. Installing a collector is a trust decision, and first-party review must be distinguished from third-party compatibility. Schema validation cannot prevent covert leakage through allowed values or network access outside the protocol; malicious-collector containment would require a separately designed and verified isolation boundary.

## Decision scope

These decisions were approved during the completed owner interview. This ADR supersedes [ADR 0006](0006-harness-adapter-ports.md), retaining separation of native collection from measurement policy and preservation of v1/v2 history, while replacing mandatory Cukup-owned Tycho collection, rejection of harness-resident collection, and unconditional managed-run-to-runtime mapping. ADR 0006 remains a historical design record, not an implementation contract.

Future Working Time uses 15-minute Engagement Windows opened or renewed only by explicit human interactions; agent execution does not extend them. Working Time is an interaction-based estimate, not measured attention. Missing observations make it a lower bound on the window metric obtainable with richer observation coverage, not on actual human effort. Deployed v1/v2 continues to count completed turn intervals plus 15-minute grace, and historical interpretation remains unchanged.

The dashboard presents target-bearing **Working Time · estimated**, separate targetless **Agent Runtime**, and **Legacy Working Time · turn-based** for historical v1/v2 measurements with their original totals. These overlapping measurements are never added together; the distinction must survive charts, filters, and summaries. This distinction is required before the new measurements become authoritative in the dashboard, not an optional follow-up after rollout. Layout remains for scoped design review; no dashboard implementation is authorized by this interview record.

Coverage disclosure distinguishes limited capability, known collection gaps, and unavailable data. Available evidence may be shown with a visible warning, but missing data is not replaced by zero or described as proof of no human work. Live-only collectors may participate with explicit loss/recovery limitations rather than an invented replay guarantee.

## Deployment, attribution, and compatibility

Separate-process collectors may use a Cukup background receiver so authentication, durable delivery, and retries are implemented once. Approved Amp packaging may embed the same core; a daemon is not mandatory for every harness. Initial first-party deployment scope is macOS and Linux physical machines plus Amp-managed orbs, with installation, durable delivery, restart, and removal verified before support is claimed. Native Windows and other cloud environments are deferred; protocol portability does not imply first-party support there.

Initially, collection and receiver deployment belong at the actual execution site with its own authenticated executor binding. A collector querying a remote machine must never attribute that evidence to its own Machine Label. Cross-host collection requires a separately reviewed attribution and authentication design.

Where a harness lacks a stable path-free project identity, the user may explicitly bind a launch or session to an existing Cukup Project, selected by its name/slug. Missing or ambiguous binding remains Unassigned; directory names, repository metadata, and prompt content never supply inferred attribution. This broadens ADR 0006's native-project-only rule without changing existing evidence.

Matching normalized project names alone must not merge work across harnesses. Native identities remain local and require approved mappings to stable Cukup Project identities; collectors may propose mappings but must not silently merge distinct projects. Explicit launch/session bindings select from the same approved projects. Refreshing the name of an already identified native project is not a new cross-harness mapping and requires no additional owner approval.

Attribution snapshots are immutable: engagement observations capture their project mapping when recorded, and execution intervals retain the project mapping captured at their start. Mapping changes affect subsequent evidence only, including when prior evidence is Unassigned; an explicit historical correction mechanism is outside the initial design. This preserves which project owns the evidence, not permanently frozen dashboard text.

Project identity is distinct from its name/slug, but renaming must remain lightweight. Native name changes should be picked up automatically for future activity without an approval workflow, owner-selected effective times, reserved former slugs, or a week-specific naming ledger. Native project identifiers remain local. Existing recorded names and attribution may remain as captured; this initiative does not require historical relabeling or rename-driven backfilling of v1/v2 evidence.

The rename week may show both old and new names. Once collectors refresh their native project information, subsequent activity should use the new name, so the following week's activity normally no longer uses the old name. This is a best-effort freshness expectation, not an absolute weekly invariant: occasional stale labels or slight data inconsistencies are acceptable for this personal, non-mission-critical product. Old names may remain in historical evidence. This clarification replaces the earlier strict next-week naming requirement; detailed rename presentation is not an architecture gate.

Third-party collectors initially target an explicitly experimental, version-negotiated local protocol. A stable compatibility promise requires three real harness integrations plus weak-capability and recovery tests. Experimental protocol changes do not permit reinterpreting accepted evidence or queued cloud records.

## Accounting transition

The new target-bearing Working Time begins at one account-wide, owner-approved Monday at 00:00 Asia/Jakarta, after shadow validation and dashboard readiness. Collector upgrades may precede that point without changing authoritative totals; cutover is not selected independently by each collector.

Collectors lacking human-interaction evidence do not necessarily block cutover, but the owner must explicitly accept the coverage limitations before proceeding. Their legacy runtime-like evidence never fills the human-time gap, and the dashboard shows those limitations beside target progress rather than implying zero human work.

Work crossing cutover retains its complete legacy record separately. Only independently collected new evidence may contribute to new metrics after cutover: legacy grace never fills new Working Time, and a defensible closed execution interval may contribute its post-cutover portion. Clipping is a reporting operation, not an invented execution boundary.

Evidence belongs to when it occurred, not when uploaded or finalized. Late observations and subsequently closed execution intervals may update earlier daily and weekly totals. The dashboard discloses pending evidence and synchronization status rather than implying that past weeks are permanently finalized; weeks are reporting units, not storage units.

After cutover, rollback of a faulty collector or other component may pause new collection and expose incomplete coverage, but must retain accepted records, queued uploads, and compatible ingestion. It must not silently restore turn-based evidence as new Working Time. A return to legacy target accounting requires a separate explicit owner decision.

## Collection failures

Measurement failures must not stop AI work. Collectors attempt bounded local delivery or a sanitized durable spool, never acknowledge evidence that was not persisted, and never block harness work indefinitely when the receiver is unavailable or storage is exhausted. Surface collection failure, replay where supported, and disclose irrecoverable gaps rather than inventing evidence.

Invalid or uncertain evidence must not be silently repaired into a valid measurement. Reject unknown or prohibited fields without raw payload logging; identity conflicts remain visible and never overwrite accepted facts. Unknown human origin creates no Working Time, and unsupported timing claims do not become execution intervals. Retain only privacy-safe diagnostics and retry state, never prohibited content for debugging.

Prefer simple automatic behavior over approval workflows and machinery for rare attribution edge cases. This tolerance for occasional label inconsistencies does not relax the agreed privacy boundary, metric separation, or preservation of historical measurement semantics.

## Scope of subsequent design reviews

This interview settles product and ownership decisions, not a frozen SDK. Exact transport framing, database layouts, batch limits, retry timings, and detailed dashboard layout belong in independently reviewable implementation designs. Those designs must preserve the decisions here and return to the owner if evidence forces a semantic, privacy, compatibility, or support-scope change. The more elaborate weekly rename presentation, rename approval, and legacy-linkage proposals from the interview are not requirements.

The owner confirmed shared understanding and authorized the documentation consistency slice. Subsequent implementation proceeds in independently reviewable slices through the [roadmap gates](../../ROADMAP.md#generic-harness-adapter-initiative). The unmerged Tycho fork is not an accepted dependency, and GitHub issue #3 (production deploy speed/self-healing) is outside this initiative.
