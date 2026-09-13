# Incident record: experimental Amp-orb adapter proof

**Date:** 2026-09-13  
**Disposition:** accepted and documented as bounded impact  
**Scope:** experimental orb-only proof; no macOS, Linux, support, or cutover claim

## Summary

An initial temporary project-plugin proof wrapper did not actually disable legacy cloud sync for a remote Amp executor because workload OIDC remained available. The resulting bounded impact was limited to isolated legacy v1 lifecycle delivery and its possible dashboard accounting described below. The immutable rows are unchanged, no compensating production action was taken, and the owner disposition is to accept and document the bounded impact with no remediation.

## Observed facts

- Fifteen isolated legacy v1 lifecycle rows were delivery-confirmed and stored once under the immutable service contract.
- The exact final accepted-versus-duplicate response statuses were not retained.
- One additional pending v1 start has unknown remote presence because the remote side could have committed it before the response was lost.
- The incident shape was 9 starts and 6 ends across 9 turns: 6 complete intervals and 3 unmatched starts, plus the potentially stored additional start.
- All affected records were legacy v1, Unassigned, and amp-orb, within one Jakarta day/week reporting window.
- At the final server cutoff, the complete possible 16-row set had certified incremental globally-unioned daily/weekly worked-minutes bounds of 0–61 for Overall and the corresponding Unassigned/amp-orb dashboard view. These are cutoff-specific bounds, not a likely value and not a lifetime cap.
- The exact counterfactual effect is unavailable. Concurrency, interval count, last-activity and synchronization metadata, and possibly labels may differ.

## Inference and impact boundary

The confirmed rows establish that the service stored one immutable copy of each delivered fact; they do not establish the exact final response-status sequence. Given the fresh source identity, each confirmed row had to have been accepted once before any later duplicate acknowledgement. This is an inference from the delivery evidence, not a retained response record. The possible sixteenth row is bounded as pending/unknown rather than treated as definitely remote or definitely absent. The dashboard range is therefore reported as a certified incremental bound for the complete possible set, not as an asserted total or reconstructed historical value. No inference is made about any activity outside the stated legacy v1, Unassigned, amp-orb scope or reporting window.

## Containment and investigation

- The temporary wrapper was removed and reloaded out of the proof setup. The proof receiver was stopped, incident state was preserved, and the pending row was disconnected.
- The corrected proof configuration fails closed for cloud access.
- An authorized read-only HTTP investigation made exactly 3 workload token mints and 4 GET requests: capabilities once and summary three times. It made no write requests.
- A later protected database verification stopped before any production connection because non-mutation of the WAL read-only filesystem could not be certified under the authorization.
- No compensating production action was taken.

## Preventive changes

- Proof-only service clients now fail closed for every executor kind.
- Remote regression coverage proves zero OIDC minting and zero non-loopback requests while the legacy outbox accumulates.
- A real same-thread proof found and fixed stale `ThreadState` subscription release on matching `agent.end`; a consecutive-turn regression was added.

## Technical proof limits and result

The valid corrected proof established that actual Amp hooks produced consecutive closed generic execution segments. A supervised outage durably spooled unblocked records; receiver restart alone retained them, and supported plugin reload rediscovered and drained them. The protocol-v1 collector-observation result remained unrecovered Unassigned with zero engagement.

This was an orb-only experimental proof. It makes no macOS, Linux, support, or cutover claim. Endpoint changes still require plugin reload, and the proof has no autonomous retries.

## Owner disposition

Accept and document the bounded impact. Leave immutable rows unchanged. No remediation.

## Prevention checklist

- [ ] Use default-deny production clients in proof wrappers.
- [ ] Assert executor kind and verify zero network requests and zero token mints.
- [ ] Use fresh isolated state for every proof.
- [ ] Inspect the outbox before and after the exercise.
- [ ] Obtain Oracle review before any live exercise.

## Verification

Final source-checkout verification passed: 258 tests, 0 failures, 1,470 assertions, typecheck, and builds. Nothing was pushed or deployed for these local commits.
