# Tycho Harness Adapter contract

**Status:** accepted design. The Cukup adapter is not implemented. The upstream Tycho reads it depends on have a candidate implementation that is unreviewed and unmerged — see [Upstream Tycho reads](#upstream-tycho-reads).

This contract was derived from Cukup `545aa68cb1079d27d07a674db30a6717b9f65ed5` and Tycho `f6031d83038e83e87da95a3e96746a9f0c7cdd0e`, and reverified on 2026-09-07 against Cukup `65f9c50b991886efb3dfdc5f9027b51ab26201dc` and Tycho `cd4684e87ae2493379a116a10a54fb4dd1df464d`. No assumption in this contract changed. Later implementation must reverify both current revisions again and record any changed assumptions.

## Supported integration boundary

The Tycho adapter lives in Cukup. Tycho supplies supported privacy-clean native facts; it does not implement Cukup's outbox or wire protocol.

Tycho shell hooks are optional wake-ups. Their current lifecycle payloads omit `run_id` and timestamps, have no acknowledgement or replay, and may contain absolute workspace paths, native session IDs, summaries, or structured model output. They are never forwarded and are not authoritative evidence.

Correctness comes from a 60-second periodic reconciliation of supported durable Tycho state:

- **Open runs:** `GET /metrics/open-runs`, or `tycho metrics open-runs`, exposing only `run_id`, `project_key`, `started_at`, `status`, and `liveness`.
- **Finalized runs:** Tycho's supported run-scoped usage-metrics surface, `GET /metrics` or `tycho metrics query`, including durable run identity and start/finish timestamps.
- **Human interactions:** `GET /metrics/interactions`, or `tycho metrics interactions`, exposing only `observation_id`, `project_key`, `kind`, and `observed_at`.

All three accept the same window contract: `from` inclusive, `to` exclusive, and a named IANA timezone required for any offset-free boundary. The reconciler polls windows rather than whole histories.

Reading `managed_agents.json`, `memory.jsonl`, raw logs, or other private files is not permitted in the shipped adapter. A local prototype may investigate them but cannot satisfy acceptance.

## Metric mapping

One Tycho managed run maps to one Agent Runtime interval. Resuming a native session creates another managed run and therefore another runtime interval. Prompt count and native session identity do not define intervals.

A Tycho interaction creates or renews Working Time only when the adapter observes an explicit human action:

- composing or submitting a prompt;
- sending a follow-up;
- approving an action;
- explicitly taking over an automatically owned run.

Scheduled starts, automatic orchestration/resume, process liveness, generated output, finalization, and waiting for input do not create Working Time.

Tycho's interactions read supplies three kinds, in Tycho's own vocabulary: `prompt_submitted`, `inquiry_answered`, and `run_taken_over`. The adapter maps each to one Engagement Observation. It records nothing for scheduled prompts, a parent agent prompting its delegated child, prompt-queue dispatch, hook auto-answers, or Personal Assistant internal messages; a prompt queued while an agent is running is observed at the instant it was accepted rather than when it dispatches.

There is still no supported privacy-safe composition observation, on Tycho or on Amp, so coverage begins no earlier than submission and reported Working Time is a disclosed lower bound. Two further gaps are known and deliberate: restarting an existing agent with no authored input, such as `tycho agent run`; and suspending or restoring an inquiry without answering it. A future Tycho TUI/Remote UI capability may emit debounced timestamp-only composition observations; it must never expose drafts, keys, or content.

Agent Runtime is finalized-first initially. An open run may remain provisional and correct when a durable terminal timestamp appears. No synthetic heartbeat sessions are created. A run that crashes without a durable terminal fact remains unmatched and crash-capped.

`liveness` carries four best-effort process values — `alive`, `exited`, `dead`, and `unknown` — and none of them is a timestamp. **No value of that field ever satisfies the durable-terminal requirement**, including `dead`: it is subject to PID reuse and is computed at read time. Terminal timestamps come only from the finalized usage-metrics surface.

## Identity and attribution

- `run_id` is native reconciliation identity and remains local. The Cukup core creates wire identities.
- `agent_key`, native session ID, PID, workspace, command, prompt, summary, structured result, model, and provider never cross Cukup's event boundary.
- Tycho `project_key` is normalized locally. An exact canonical match may map automatically; a differing Amp/Tycho identity requires an explicit local alias.
- Missing, invalid, or ambiguous mappings are visibly Unassigned. The adapter never falls back to workspace paths, Git remotes, or directory names.
- Each physical machine runs its own reconciler. It reuses that machine's protected bearer lineage but has a distinct local SQLite database and source instance.
- Future Agent Runtime may carry closed Harness Type `tycho`. Working Time remains globally unioned with Amp and other Harnesses.

Tycho timestamps are parsed to epoch milliseconds, truncated rather than rounded forward, and serialized as UTC RFC 3339 with exactly three fractional digits. Tycho's wall-clock duration must not populate Cukup's monotonic-duration field.

The open-run read applies that rule at its source: `started_at` has a durable precision of one second and is floored, because the agent manifest persists it at one-second precision. An unfloored read would report one instant while Tycho is up and a different one after a restart, and a deterministic wire identity derived from `run_id` would then conflict. Interaction observations carry millisecond precision.

`observation_id` is the adapter's deduplication key for interactions, and it is stable only because the interactions log is written once per observation: no upsert by identity, and no rebuild path. That is the contrast with both the usage-metrics surface, which upserts, and `memory.jsonl`, which is regenerated from a raw log.

## Upstream Tycho reads

Two reads are required before shipped implementation. Both now have a candidate implementation in Tycho, and **neither is reviewed or merged**. The work sits on branch `feat/open-run-read-contract` in `firewalker06/tycho` as commits `e02a64b`, `6190ac5`, and `25da3dd` on top of `cd4684e`. Tycho's creator reviews Tycho-owned contract changes, so the contract is proposed, not agreed.

**1. Run-scoped open-run read** — required, proposed:

- stable random `run_id`;
- stable `project_key`;
- durable `started_at` with documented precision;
- running/terminal status;
- a supported liveness signal.

**2. Timestamp-only human-interaction read** — required for Working Time, proposed:

- stable `observation_id`;
- stable `project_key`;
- a closed interaction `kind`;
- `observed_at`.

Both must exclude workspace, command, prompt, summary, structured result, native session ID, model output, and credentials, and the interaction read must additionally exclude any derived measure of content such as message length or attachment count.

Adding `run_id` and `occurred_at` to hook wake-ups remains useful but is not required for correctness, and it was deliberately left out of the proposal to keep the change small.

## Acceptance

- Repeated reconciliation is idempotent and emits starts before ends.
- Missing hooks, restart, delayed finalization, duplicate observations, archive, and more than ten historical runs converge from supported state.
- A terminal event is emitted only from a durable terminal timestamp.
- Concurrent Tycho runs and overlapping Amp/Tycho intervals union without inflating either metric.
- Scheduled and unattended runtime never counts toward the Working Time target without an Engagement Observation.
- Capability coverage is visible; missing composition support is described as a lower bound.
- Project mismatches require aliases and invalid identities become Unassigned.
- Tests reject every prohibited field and require no Fleet access, production credential, DNS, or deployment.
- Installation, authentication, mapping, status, troubleshooting, and removal are documented.

Design review may begin now. Implementation contribution is not ready until the repository also has safe pull-request CI, credential-free integration fixtures, a scoped Tycho issue, and the agreed upstream reads. The reads are proposed rather than agreed, so that precondition is still open.
