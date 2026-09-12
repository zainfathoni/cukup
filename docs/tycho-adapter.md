# Tycho Harness Adapter contract

**Status:** accepted design. The Cukup adapter is not implemented. The upstream Tycho reads it depends on have a candidate implementation that is unreviewed and unmerged — see [Upstream Tycho reads](#upstream-tycho-reads).

This contract was derived from Cukup `545aa68cb1079d27d07a674db30a6717b9f65ed5` and Tycho `f6031d83038e83e87da95a3e96746a9f0c7cdd0e`, and reverified on 2026-09-12 against Cukup `6e61228b024040c2ad351d7143b2c504cc5c29ed` and Tycho `ec3100c4710751d85f1927c6bf43cda800b8bc7e`. No assumption in this contract changed. Later implementation must reverify both current revisions again and record any changed assumptions.

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

Two reads are required before shipped implementation. Both now have a candidate implementation, and **neither is reviewed or merged**.

The work sits on branch `feat/open-run-read-contract` in the fork `zainfathoni/tycho` — commits `7c7dea6`, `7ff601e`, and `35183e2` on top of upstream `ec3100c`. It is a fork because this maintainer has read-only access to `firewalker06/tycho`, whose creator reviews Tycho-owned contract changes. The contract is therefore proposed, not agreed.

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

## Verified constraints

Facts confirmed in source that an implementation depends on. Each is a precondition or a bounded limitation, not a defect.

**Project Slug attribution requires event schema 2.** Schema v1 permits no `project_slug`, so on a service advertising `preferred_new_event_schema_version: 1` every Tycho event lands as Unassigned Work — silently, because a v1 event without a slug is valid. Production pins `CUKUP_NEW_TURN_EVENT_SCHEMA_VERSION: 2` in `config/deploy.service.yml`, but the service default is 1. A reconciler must log the negotiated schema version at startup so this is visible rather than inferred.

**One bearer credential may own several source instances.** `source_owners` keys on `source_instance` with a non-unique owner index, and ingestion rejects only a *different* owner submitting to a claimed source. A machine's Amp plugin and its Tycho reconciler therefore coexist under one Bearer Lineage, inherit the same Machine Label from one executor-profile binding, and need no new machinery: overlapping Amp and Tycho intervals are merged by the service's global union rather than deduplicated by either adapter.

**An open run under-reports until it finalizes.** Aggregation has no live branch: a start with no matching end contributes at most the unmatched-start crash cap. A long Tycho run therefore reads as that cap in the authoritative summary and corrects to its true interval once finalization supplies the terminal timestamp. Daily and weekly totals are exact because the union is recomputed from scratch on every summary; only the live view lags. This is why Agent Runtime is finalized-first and why synthetic heartbeat sessions are rejected rather than merely unnecessary.

**Tycho's agent manifest is not a run history.** It retains only the last ten runs per agent, which is why reconciliation must converge from the supported reads rather than from manifest state, and why the acceptance criterion below names more than ten historical runs. Open runs are always within that window; finalized runs come from the usage-metrics surface, which is never trimmed and survives archival.

**A run lost before Tycho persists it is unrecoverable.** If Tycho dies between spawning a run and saving its agent state, that run appears in neither the manifest nor the usage-metrics surface and is invisible to Cukup permanently. This is a bounded gap in the source of truth, not an adapter defect; do not add recovery machinery hunting for it.

**A `project_key` outside the supported character set becomes Unassigned.** Slug normalization accepts letters, digits, spaces, underscores, and hyphens; a key containing anything else — a dot or a slash, both legal in Tycho configuration — yields no valid slug. That evidence is visibly Unassigned and the reconciler surfaces a warning, rather than guessing from any other identity.

**Tycho's own prompt-queue design carries the human/automatic distinction.** Upstream separates `enqueue_prompt!` from `enqueue_prompt_from!`, and the latter requires an actor and stamps each queued entry `source: "user"` or `"parent"`. The interaction observation attaches to that actor-aware entry point rather than to the lower-level queue write, so a delegated parent enqueueing work for its child is structurally incapable of producing an Engagement Observation.

**`memory.jsonl` is excluded on correctness grounds, not only privacy.** A user-triggered rebuild overwrites it with synthetic run summaries and does not restore inquiry events, so any checkpoint keyed on its sequence could replay or skip. Reconciliation checkpoints key on `run_id` instead.

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
