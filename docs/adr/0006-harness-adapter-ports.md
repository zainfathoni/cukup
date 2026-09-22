---
status: superseded
date: 2026-09-06
---

# Separate Harness Adapters from Cukup's measurement core

> **Historical record. [ADR 0007](0007-generic-harness-evidence-boundary.md) supersedes this decision.** Its Tycho ownership, runtime mapping, crash-cap, provisional-duration, and attribution rules are not current requirements.

## Context

Cukup obtained evidence from Amp callbacks and thread-state observations. Tycho had durable run identity and finalized usage records. Its shell hooks lacked run IDs, timestamps, acknowledgement, and replay.

Treating each Harness like Amp would put Amp concepts in the domain. Direct Tycho hook forwarding could lose evidence and expose paths, session IDs, summaries, or model output. A full run also did not prove human engagement.

## Decision

1. Use ports and adapters. Amp is the first Harness Adapter and Tycho is the second.
2. The harness-neutral core accepts two evidence families:
   - Engagement Observations open or renew 15-minute Working Time windows.
   - Runtime observations describe Agent Runtime without human targets.
3. Adapters declare observable capabilities. Differences change coverage disclosure, not metric definitions.
4. Adapters own native observation, reconciliation, local project identity, and bounded checkpoints. The core owns durable evidence, privacy IDs, ordering, schema negotiation, snapshots, delivery, retries, clock checks, and field validation. The service owns immutable ingestion, interval union, targets, and summaries.
5. Move Amp behind the ports without behavior changes before changing metrics or protocols.
6. Use Tycho hooks only as wake-ups. Reconcile supported durable state. Do not use private files in production.
7. Tycho owns its native read contract. Cukup owns reconciliation and delivery. Do not duplicate the outbox in Ruby.
8. Treat one Tycho managed run as one Agent Runtime interval, not Working Time. Scheduled work does not create Engagement Observations.
9. Reconcile each machine periodically, initially every 60 seconds. Do not attribute a remote Tycho host to the reconciler's Machine Label.
10. Require a durable terminal timestamp for runtime completion. Keep a crashed run unmatched and crash-capped until Tycho finalizes it. Do not use last-seen time as an end.
11. Start with finalized runtime. Open runtime can be provisional and corrected at finalization. Defer synthetic segments and service-side liveness.
12. Map exact native project identity automatically. Require an explicit alias when identities differ. Keep invalid, absent, or ambiguous identity Unassigned. Do not use paths or Git metadata.
13. Keep v1/v2 Working Time meaning. Start new semantics only at an explicit future transition.
14. Keep the adapter port internal until three Harnesses validate it.

## Consequences

- Coverage differs when a Harness cannot observe composition.
- At decision time, Amp and Tycho had no supported timestamp-only composition signal.
- Tycho needed a privacy-safe open-run read. Hooks could reduce latency but could not be required for correctness.
- The service would union concurrent intervals.
- New metrics required separate protocol, storage, dashboard, and migration reviews.

## Rejected alternatives

- **Direct Tycho hook forwarding:** It lacked identity, time, and delivery guarantees and could expose sensitive fields.
- **A Tycho-resident Cukup client:** It duplicated durability and privacy controls.
- **Private-file integration:** It depended on mutable formats with sensitive data.
- **Synthetic runtime sessions:** They invented boundaries.
- **Runtime as Working Time:** It counted unattended automation toward a human target.
- **Lowest-common-denominator adapters:** They discarded richer safe evidence.
