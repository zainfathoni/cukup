---
status: accepted
---

# Do not infer Working Time from agent runtime

Cukup will not ship **Modeled collaboration time · experimental**. The investigation in [issue #25](https://github.com/zainfathoni/cukup/issues/25) found that currently inspected Amp capabilities do not provide trustworthy evidence that an interaction originated with a human: `agent.start` may result from a programmatically appended message or automatic continuation, and `awaiting-approval` proves that execution is waiting but not that a human approved, rejected, or otherwise acted. Missing human-origin evidence makes the proposed metric unavailable; it does not establish zero human work.

Agent Runtime, elapsed process time, tokens, cost, and model confidence cannot supply the missing evidence. Runtime heuristics can include unattended execution while omitting reading, planning, prompt composition, and other human work. TypeSafe or another model could assign confidence to supplied features, but confidence cannot turn features without a human-origin contract into evidence of human activity. Cukup therefore will not use deterministic runtime heuristics or model inference to create Engagement Observations, repair collection gaps, or estimate human collaboration time from the current signals.

The deployed v1/v2 turn-based Working Time remains authoritative with its existing targets and historical interpretation; accepted records and history are not recalculated or relabeled. This decision does not activate the paused generalized rollout, deploy the research replay, or alter [ADR 0007](0007-generic-harness-evidence-boundary.md): future Working Time still uses 15-minute Engagement Windows opened or renewed only by explicit human-interaction evidence, while Agent Runtime remains separate and targetless.

Reconsideration requires a supported, privacy-safe Amp human-origin event contract validated for origin and occurrence-time semantics and for delivery, duplication, recovery, and loss limitations. Such a contract permits a new evaluation, not shipment. Any evaluation still requires separate owner approval of its privacy boundary and closed metadata allowlist, ground-truth labels, error and confidence tolerances, and decision-retention policy. Runtime heuristics, additional runtime metadata, or a different model alone are not grounds to reopen the decision.

The supporting research and owner-approved closure are recorded in the [investigation conversation](https://ampcode.com/threads/T-01a0b80e-7aef-717b-a911-6f27cea3ac89) and [closure conversation](https://ampcode.com/threads/T-01a0b8a8-87a4-7598-bd6e-d83a0d79c6de).
