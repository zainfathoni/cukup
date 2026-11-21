# Cukup product vision

## Why does Cukup exist?

Cukup helps a developer understand AI-assisted work across projects and executors without collecting prompts or source code. Editor activity and AI billing do not answer the same question.

The intended distinction is human collaboration versus autonomous execution. Time, tokens, cost, and output are not productivity scores.

## Who is it for now?

Cukup is open source. It supports one owner's personal Amp workflow per installation. Zain has verified [self-hosting](../self-hosting.md) only on his own installation. Other harnesses, a stable SDK, and multi-user support are paused indefinitely.

Cukup means “enough” in Indonesian. AI can produce more work, but people still choose, review, and own the results. Working Time is one prompt to pause and consider enough. It does not decide for the user.

Production remains Amp-only v1/v2. Its turn-based Working Time is not measured attention. The [roadmap](../../ROADMAP.md) records priorities and conditions for resuming broader work.

## Which principles constrain future work?

- Collect the minimum evidence. Do not collect tracked prompts or source content.
- Disclose missing evidence. Do not treat missing data as zero or invent human activity from runtime.
- Preserve accepted evidence and its historical meaning.
- Prefer Unassigned work to attribution guessed from private paths or repository metadata.
- Do not infer attention allocation from concurrent project activity.
- Do not let measurement failures indefinitely stop AI work.
- Keep routine name changes automatic. Occasional stale labels are acceptable; privacy and metric errors are not.

## What remains a future decision?

[ADR 0007](../adr/0007-generic-harness-evidence-boundary.md) separates future interaction-based Working Time from Agent Runtime and legacy totals. These are accepted design constraints, not deployed metrics.

The [experimental protocol](../experimental-local-harness-evidence-protocol.md) does not establish official support. [Tycho guidance](../tycho-adapter.md) does not make an unmerged fork a dependency.

[ADR 0008](../adr/0008-do-not-infer-working-time-from-agent-runtime.md) rejects runtime-derived human collaboration estimates. More runtime data or model confidence cannot replace human-origin evidence.

Team surveillance, productivity scoring, prompt collection, and reinterpretation of historical v1/v2 evidence remain outside the product's goals.
