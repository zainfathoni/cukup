# Candidate Tycho collector guidance

**Status:** paused design guidance. No Tycho adapter is implemented or supported. [ADR 0007](adr/0007-generic-harness-evidence-boundary.md) supersedes the Tycho-specific design in ADR 0006. Do not treat unmerged fork work as a dependency.

## Boundary and ownership

A future collector can be maintained by Cukup, Tycho, or a third party. It must translate supported native facts into the [experimental local protocol](experimental-local-harness-evidence-protocol.md).

Keep native IDs, project keys, pagination, cursors, and timestamp interpretation inside the collector. Do not add Tycho concepts to the generic core. Recheck the supported upstream surface before any support claim.

## Evidence must justify the metric

- Create Working Time only from supported human composition, submission, follow-up, approval, or takeover evidence.
- Do not treat enqueue, scheduled start, automatic resume, output, finalization, or waiting as human engagement.
- Count Agent Runtime only from defensible closed execution segments.
- Exclude explicit waits for human input.
- Leave a missing endpoint unresolved. Do not add a crash cap or synthetic end.
- Declare live and recovery coverage separately. Missing evidence is not zero.

## Candidate reads and recovery

Before using a Tycho surface, prove stable local deduplication, timestamp meaning and precision, retention, pagination, and late-change discovery.

Do not use disappearance as a terminal timestamp. Do not replace a missing native endpoint with receipt or polling time. Claim replay only when a supported durable surface provides it.

Raw private files are not a default integration surface. They need separate compatibility and privacy review.

## Attribution and privacy

Map native identities to Cukup Projects only through approved mappings or explicit non-path bindings. Name equality is not sufficient. Keep absent or ambiguous attribution as Unassigned.

Run the collector at the execution site. Cross-host collection needs a separate design.

Never export prompts, output, drafts, commands, paths, repository metadata, credentials, native IDs, model details, or arbitrary metadata.

## Implementation gate

A proposal must name the supported upstream revision, supported surfaces, owner, package, capability matrix, and credential-free fixtures.

Tests must cover replay, conflicts, restart, offline delivery, late finalization, missing endpoints, and waiting. They must also cover origin, attribution, and prohibited fields.

Follow the paused generic initiative in the [roadmap](../ROADMAP.md). This document does not authorize Tycho implementation work.
