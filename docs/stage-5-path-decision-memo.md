# Stage 5 decision: preserve contracts and pause blocked implementation

2026-09-15 · Asia/Jakarta · **Owner-adopted Option A.** This decision supersedes the
earlier draft option comparison. Options B (weaker authority/time) and C (bounded
physical-shadow release) are not selected or authorized work.

## Decision and evidence

Preserve all current Stage 5 contracts and pause blocked implementation pending
supported provider/API and Amp guarantees. No provider, cutover date, project mapping,
new support scope, publication, deployment or activation is selected. The baseline is
[PR #16](https://github.com/zainfathoni/cukup/pull/16) at the
[reviewed head](https://github.com/zainfathoni/cukup/commit/ef8fd9205ad74c01bfe1118cf874ffd7a12591c4).

Retain the complete evidence matrices and exact citations in these unchanged research
reports. Their descriptions of the original checkout, uncommitted artifacts and checks
are historical investigation metadata, not claims about this adoption commit:

- [Issue #9: Spanner qualification](issue-9-spanner-qualification.md): **NO-GO for stock
  managed Spanner under unchanged Stage 5R/5S/5X.** Published SQL restrictions preclude
  pending commit timestamps in scalar expressions, CHECK constraints and generated-column
  inputs. No supported interface was established for actual-commit interval/epoch/freshness
  guards and finalized digested/encrypted recovery in one atomic durable decision.
- [Issue #10: Amp platform guarantees](issue-10-amp-platform-guarantees-investigation.md):
  **NO-GO for new Stage 5P/5W runtime support.** Reviewed public guarantees do not establish
  recreation-safe non-reusable execution incarnation, verifiable same-incarnation storage,
  non-recycled native-project lifecycle or atomic occurrence/project/owner/incarnation context.
  This is insufficient published evidence, not a claim that Amp lacks internal support.

**Research completion for #9/#10 is not implementation readiness.** A documented no-go
satisfies the research decision outcome without supplying an eligible provider interface or
platform source. It must not be treated as permission to resume dependent implementation.
No issue status or dependency relationship is changed by this record.

## Paused work and unchanged dependencies

| Issue | Paused scope | Existing blocked-by relationships, unchanged |
| --- | --- | --- |
| [#11](https://github.com/zainfathoni/cukup/issues/11) | Recoverable authority, owner operations and trusted-time fencing | [#9](https://github.com/zainfathoni/cukup/issues/9) |
| [#12](https://github.com/zainfathoni/cukup/issues/12) | Project registry, mappings and capture recovery | #11 and [#10](https://github.com/zainfathoni/cukup/issues/10) |
| [#13](https://github.com/zainfathoni/cukup/issues/13) | Attested Amp-orb generic ingestion and synchronization | #10 |
| [#14](https://github.com/zainfathoni/cukup/issues/14) | Authority-report route and dashboard consumer | #11 |
| [#15](https://github.com/zainfathoni/cukup/issues/15) | Full Stage 5 recovery rehearsal and activation | #11, #12, #13 and #14 |

[#8](https://github.com/zainfathoni/cukup/issues/8) remains incomplete. Stage 5R permits
owner-accepted missing OIDC coverage and Unassigned attribution, while #15's full-rollout
scope currently requires #12/#13. This decision changes neither rule and does not adopt a
reduced-scope completion milestone. No deadline, automatic retry, monitoring or vendor outreach
is authorized; the pause lasts until applicable evidence is reviewed and the owner resumes work.

Production shadow attribution stays `Unassigned`; generic OIDC ingestion stays disabled;
OIDC synchronization stays unsupported/unknown and public shadow synchronization stays unknown.
Legacy behavior and existing default-off physical collection boundaries remain unchanged.
Preserve privacy, immutable evidence/replay, no-backfill, non-additive metrics/lanes and no
runtime-derived human time. Authority-report v1 remains permanently `current_use: forbidden`
with null validity/proof; its route and consumers remain inactive.

## Evidence-based reopening criteria

Reopen only the affected scope after an explicit owner decision based on reviewed evidence:

1. **Provider/API:** a supported versioned interface and concrete delayed-commit trace must
   establish atomic actual-time interval/freshness/epoch/boundary checks and finalized
   records, StateDigest, encrypted recovery/RecoveryDigest and authenticated head in the
   same durable decision. Independently protected non-reusable registration, retained exact
   recovery, all-mutator/authorization fencing, bounded fresh reads and final release remain
   separate qualification gates. Apply [Stage 5R](stage-5r-authority-activation-contract.md),
   [5S](stage-5s-authority-control-storage.md), [5X](stage-5x-owner-project-control-contract.md)
   and [5Y](stage-5y-commit-authority-provider-decision.md) unchanged. A client precheck,
   post-commit repair, emulator success or another generic provider comparison is insufficient.
2. **Amp identity and context:** authoritative documentation or explicit supported platform
   confirmation must define the exact assertion/API, lifecycle/non-reuse, same-incarnation
   durable storage and pre-upload binding, owner scope, occurrence-bound context and
   invalidation/revocation guarantees required by [Stage 5P](stage-5p-oidc-execution-site-contract.md)
   and [5W](stage-5w-amp-project-capture-contract.md). Syntax, token possession, observed IDs,
   implementation behavior and repeated successful tests cannot prove those public guarantees.
   P-only evidence does not qualify W, or vice versa; independent
   [5V](stage-5v-project-attribution-contract.md)/5X owner approval, clock, serialization,
   capture recovery and terminal no-commit fencing still gate implementation.
3. **Implementation and rollout:** evidence reopening research is not provider selection,
   completed application conformance or activation approval. Pin the exact interface and
   acceptance plan before coding its owning slice; pass the applicable independent recovery,
   privacy, capacity, authorization, compatibility and failure rehearsals before rollout.
   Purchase/provisioning, credentials, publication/deployment, cutover and activation each
   retain their separate owner approvals. No contract weakening is implied by resumption.

## Separate PR and release blocker

**This decision does not establish that PR #16 is merge-ready.** Fleet containment and
schema-8 recovery remain a separate blocker. The cumulative PR changes service publication
inputs; the [operations runbook](service-operations.md) describes a protected Fleet operator
following qualifying main publications. Contain that path and verify a schema-8-aware
recovery/rollback target before any separately authorized release; the historical v4 automatic
rollback target is unsuitable. Local physical spools require schema-3-aware compatibility.
Never lower schema versions, delete accepted records/queues or restore an old backup over
later accepted writes to force rollback. No Fleet or production state was inspected or changed
by this adoption. The docs-only decision introduces no runtime/API/schema/config/workflow/UI
change and does not authorize merging, publishing or deploying the cumulative foundation.
