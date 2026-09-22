# Incident record: experimental Amp-orb adapter proof

**Date:** 2026-09-13  
**Disposition:** accepted and documented as bounded impact  
**Scope:** experimental orb-only proof; no macOS, Linux, support, or cutover claim

## Summary

A temporary proof wrapper did not disable legacy cloud sync for a remote Amp executor. Workload OIDC remained available. The effect was limited to isolated v1 lifecycle delivery and possible dashboard accounting. The owner accepted this bounded effect without remediation. The rows remain unchanged.

## Observed facts

- Delivery evidence confirmed 15 isolated v1 rows. The immutable service stored each row once.
- The final `accepted` and `duplicate` response sequence was not retained.
- One pending v1 start can also exist remotely. The server might have committed it before the response was lost.
- The confirmed shape was nine starts and six ends across nine turns. It contained six complete intervals and three unmatched starts.
- All records were v1, Unassigned, and `amp-orb`. They were in one Asia/Jakarta day and week.
- At the final cutoff, the possible 16-row set added 0–61 globally unioned minutes.
- This bound applies to Overall and the matching Unassigned/`amp-orb` view. It is cutoff-specific, not likely or permanent.
- The exact counterfactual effect is unknown. Concurrency, interval count, activity state, synchronization data, and labels can differ.

## Inference and impact boundary

The 15 confirmed rows prove storage, but not the final response sequence. A fresh source identity means each row was accepted before any duplicate response. This is an inference from delivery evidence, not a retained response record. The possible sixteenth row stays unknown. The 0–61 range is an incremental bound, not a reconstructed total. No conclusion applies outside this v1, Unassigned, `amp-orb` reporting window.

## Containment and investigation

- The team removed the wrapper, reloaded the plugin, stopped the receiver, preserved state, and disconnected the pending row.
- The corrected proof configuration fails closed for cloud access.
- The authorized HTTP investigation made three token mints and four GET requests. It made no write requests.
- The database check stopped before production connection. The authorization did not permit an uncertain WAL filesystem mutation.
- No compensating production action was taken.

## Preventive changes

- Proof clients fail closed for every executor type.
- Regression tests require zero OIDC mints and zero non-loopback requests while the legacy outbox grows.
- A same-thread proof found a stale `ThreadState` subscription after `agent.end`. The fix includes a consecutive-turn regression test.

## Technical proof limits and result

The corrected proof showed that Amp hooks produced consecutive closed execution segments. During a supervised outage, records entered the durable spool. A receiver restart retained them. A supported plugin reload found and drained them. The protocol-v1 observation stayed unrecovered and Unassigned, with zero engagement.

This historical proof covered one orb only. It did not prove macOS, Linux, packaging, support, deployment, or cutover. Endpoint changes required plugin reload. The proof had no autonomous retry.

## Owner disposition

Accept and document the bounded effect. Keep immutable rows. Do not remediate.

## Prevention checklist

- [ ] Use default-deny production clients in proof wrappers.
- [ ] Assert executor kind and verify zero network requests and zero token mints.
- [ ] Use fresh isolated state for every proof.
- [ ] Inspect the outbox before and after the exercise.
- [ ] Obtain Oracle review before any live exercise.

## Verification

At the time, checkout verification passed 258 tests and 1,470 assertions. Typecheck and builds also passed. Nothing was pushed or deployed. These historical results do not verify the current checkout.
