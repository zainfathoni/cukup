---
status: superseded
date: 2026-09-06
---

# Separate Harness Adapters from Cukup's measurement core

> **Historical record — superseded by [ADR 0007](0007-generic-harness-evidence-boundary.md).** The original rationale below is retained unchanged. Its Tycho ownership, runtime mapping, crash-cap, provisional-duration, and attribution rules are not current implementation requirements.

## Context

Cukup currently obtains evidence from Amp lifecycle callbacks and thread-state observations. The latter recover activity when a callback is absent, then persist the same ordinary start/end evidence. Tycho is the next Harness: it has durable managed-run identity and finalized usage records, but its shell hooks are best-effort notifications without run IDs, timestamps, acknowledgement, or replay.

Treating every Harness like Amp would leak Amp concepts into the domain. Forwarding Tycho hooks directly would lose evidence and expose payloads containing paths, native session IDs, summaries, or structured model output. A full Tycho managed run is also not evidence that a human remained engaged for its duration.

## Decision

1. Cukup adopts ports and adapters for Harness integration. Amp becomes the first Harness Adapter and Tycho the second.
2. The harness-neutral core accepts two evidence families:
   - Engagement Observations, which open or renew 15-minute Working Time windows;
   - runtime observations, which describe complete Agent Runtime independently of human targets.
3. Each adapter declares observable capabilities such as composition, submission, approval, and runtime. Capability differences affect coverage disclosure, not metric definitions.
4. Adapters own native observation, supported-state reconciliation, local project-identity resolution, and bounded scan checkpoints. They never construct wire events or write the transactional outbox.
5. The core owns local durable evidence, random privacy identities, ordering, schema negotiation, attribution snapshots, outbox delivery, retries, clock checks, and prohibited-field enforcement. The service owns immutable ingestion, global interval union, authoritative targets, and summaries.
6. Amp is moved behind the ports in a behavior-preserving change before any metric or protocol behavior changes.
7. Tycho hooks are optional wake-ups only. Correctness comes from periodic reconciliation against supported durable Tycho state. A shipped adapter requires a privacy-clean supported read of open runs; direct reading of Tycho's private files is prototype-only.
8. Tycho owns its native read contract and optional hook improvements. Cukup owns the reconciler, adapter state, normalization, and delivery. No Cukup outbox implementation is duplicated in Ruby.
9. One Tycho managed run is one Agent Runtime interval. It is not automatically one Working Time interval. Scheduled execution and automatic orchestration do not create Engagement Observations; explicit composition, submission, follow-up, approval, or takeover may do so when observable.
10. A periodic per-machine reconciler is authoritative; a 60-second interval is the initial target. It uses the machine's existing Bearer Lineage but a distinct local database and source instance. One reconciler never attributes remote Tycho hosts to its own Machine Label.
11. A runtime end requires a durable terminal timestamp. A crash without one remains unmatched and crash-capped until Tycho durably finalizes it. Last-seen time is diagnostic, not a fabricated end.
12. Agent Runtime is finalized-first in the initial adapter. Open runtime may be provisional and correct on finalization; synthetic segments and service-side liveness are deferred.
13. An exact normalized Harness-native project identity may map automatically. A differing identity requires an explicit local alias; invalid, absent, or ambiguous identity is visibly Unassigned. Paths and Git metadata are never consulted.
14. Future Agent Runtime evidence may carry a closed canonical Harness Type. Working Time remains globally unioned across Harnesses.
15. Existing v1/v2 evidence retains its historical Working Time meaning. The refined Working Time and Agent Runtime model begins prospectively at an explicit transition and never reinterprets history.
16. The adapter port remains internal until a third Harness integrates without changing the core. Cukup makes no public adapter-SDK compatibility promise before that validation.

## Consequences

- A Harness with composition observations measures more Working Time than one limited to submission events; the product exposes this as coverage rather than changing the metric.
- Neither current Amp nor Tycho APIs expose a supported timestamp-only prompt-composition signal. Initial Working Time is therefore a lower bound until each Harness adds one.
- Tycho needs a supported open-run read containing only run ID, project key, start time, status, and liveness. Finalized runtime comes from its supported usage-metrics surface.
- Hooks can reduce latency but their loss cannot lose evidence.
- Concurrent Amp and Tycho intervals are unioned by the service rather than deduplicated by adapters.
- New metric semantics require a separately reviewed protocol, persistence, aggregation, dashboard, and migration design.

## Rejected alternatives

- **Direct Tycho hook forwarding:** lacks identity, time, and delivery guarantees and exposes sensitive fields.
- **A Tycho-resident Cukup client:** duplicates durability and privacy enforcement in Ruby.
- **Private-file integration in production:** couples Cukup to mutable formats containing sensitive local data.
- **Synthetic periodic runtime sessions:** invents boundaries and amplifies event volume.
- **Treating all Agent Runtime as Working Time:** makes scheduled or overnight automation count toward a human target.
- **Lowest-common-denominator adapters:** permanently discards richer privacy-safe evidence instead of disclosing capability differences.
