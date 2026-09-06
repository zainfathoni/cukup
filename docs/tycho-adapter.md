# Tycho Harness Adapter contract

**Status:** accepted design; implementation has not started.

This contract was derived from Cukup `545aa68cb1079d27d07a674db30a6717b9f65ed5` and Tycho `f6031d83038e83e87da95a3e96746a9f0c7cdd0e`. Later implementation must reverify both current revisions and record any changed assumptions.

## Supported integration boundary

The Tycho adapter lives in Cukup. Tycho supplies supported privacy-clean native facts; it does not implement Cukup's outbox or wire protocol.

Tycho shell hooks are optional wake-ups. Their current lifecycle payloads omit `run_id` and timestamps, have no acknowledgement or replay, and may contain absolute workspace paths, native session IDs, summaries, or structured model output. They are never forwarded and are not authoritative evidence.

Correctness comes from a 60-second periodic reconciliation of supported durable Tycho state:

- **Open runs:** a required upstream read exposing only `run_id`, `project_key`, `started_at`, terminal/running status, and liveness.
- **Finalized runs:** Tycho's supported run-scoped usage-metrics surface, including durable run identity and start/finish timestamps.

Reading `managed_agents.json`, `memory.jsonl`, raw logs, or other private files is not permitted in the shipped adapter. A local prototype may investigate them but cannot satisfy acceptance.

## Metric mapping

One Tycho managed run maps to one Agent Runtime interval. Resuming a native session creates another managed run and therefore another runtime interval. Prompt count and native session identity do not define intervals.

A Tycho interaction creates or renews Working Time only when the adapter observes an explicit human action:

- composing or submitting a prompt;
- sending a follow-up;
- approving an action;
- explicitly taking over an automatically owned run.

Scheduled starts, automatic orchestration/resume, process liveness, generated output, finalization, and waiting for input do not create Working Time. Tycho currently exposes submission/enqueue but no supported privacy-safe composition observation, so initial coverage begins no earlier than submission. A future Tycho TUI/Remote UI capability may emit debounced timestamp-only composition observations; it must never expose drafts, keys, or content.

Agent Runtime is finalized-first initially. An open run may remain provisional and correct when a durable terminal timestamp appears. No synthetic heartbeat sessions are created. A run that crashes without a durable terminal fact remains unmatched and crash-capped.

## Identity and attribution

- `run_id` is native reconciliation identity and remains local. The Cukup core creates wire identities.
- `agent_key`, native session ID, PID, workspace, command, prompt, summary, structured result, model, and provider never cross Cukup's event boundary.
- Tycho `project_key` is normalized locally. An exact canonical match may map automatically; a differing Amp/Tycho identity requires an explicit local alias.
- Missing, invalid, or ambiguous mappings are visibly Unassigned. The adapter never falls back to workspace paths, Git remotes, or directory names.
- Each physical machine runs its own reconciler. It reuses that machine's protected bearer lineage but has a distinct local SQLite database and source instance.
- Future Agent Runtime may carry closed Harness Type `tycho`. Working Time remains globally unioned with Amp and other Harnesses.

Tycho timestamps are parsed to epoch milliseconds, truncated rather than rounded forward, and serialized as UTC RFC 3339 with exactly three fractional digits. Tycho's wall-clock duration must not populate Cukup's monotonic-duration field.

## Upstream Tycho requirement

Before shipped implementation, Tycho must expose a supported run-scoped open-run read with:

- stable random `run_id`;
- stable `project_key`;
- durable `started_at` with documented precision;
- running/terminal status;
- a supported liveness signal.

It must exclude workspace, command, prompt, summary, structured result, native session ID, model output, and credentials. Adding `run_id` and `occurred_at` to hook wake-ups is useful but not required for correctness.

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

Design review may begin now. Implementation contribution is not ready until the repository also has safe pull-request CI, credential-free integration fixtures, a scoped Tycho issue, and the agreed upstream open-run contract.
