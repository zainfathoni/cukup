---
status: accepted
---

# Do not infer Working Time from agent runtime

Cukup will not ship **Modeled collaboration time · experimental**. The [issue #25 investigation](https://github.com/zainfathoni/cukup/issues/25) found no trustworthy Amp evidence that an interaction came from a person. `agent.start` can follow an automatic message or continuation. `awaiting-approval` proves only that execution waits. Missing evidence makes the metric unavailable; it does not prove zero human work.

Agent Runtime, elapsed time, tokens, cost, and model confidence cannot supply human-origin evidence. Runtime heuristics include unattended work and omit reading, planning, and prompt composition. A model can score features but cannot create evidence that the source does not provide. Do not use runtime rules or model inference to create Engagement Observations or repair gaps.

The deployed v1/v2 turn-based Working Time stays authoritative. Keep its targets, records, and historical meaning. Do not recalculate or relabel history. This decision does not resume generalization, deploy research code, or change [ADR 0007](0007-generic-harness-evidence-boundary.md).

Reconsider only after Amp provides a supported, privacy-safe human-origin event contract. Validate origin, occurrence time, delivery, duplication, recovery, and loss. A valid contract permits evaluation, not shipment. Evaluation still requires owner approval of privacy fields, ground truth, error limits, confidence limits, and retention. More runtime data or a different model is not sufficient.

See the [investigation](https://ampcode.com/threads/T-01a0b80e-7aef-717b-a911-6f27cea3ac89) and the [owner-approved closure](https://ampcode.com/threads/T-01a0b8a8-87a4-7598-bd6e-d83a0d79c6de).
