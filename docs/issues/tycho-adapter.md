# Draft issue — Implement the Tycho Harness Adapter

**Not filed.** This is a draft for review. File it with `gh issue create --title "Implement the Tycho Harness Adapter" --body-file docs/issues/tycho-adapter.md` when the upstream reads are agreed.

Authoritative contracts: [`docs/tycho-adapter.md`](../tycho-adapter.md), [ADR 0006](../adr/0006-harness-adapter-ports.md), [`CONTEXT.md`](../../CONTEXT.md), [`docs/service-api.md`](../service-api.md). This issue scopes work; it does not restate or amend those decisions.

## Outcome

A per-machine Cukup reconciler observes Tycho and produces two metrics: Agent Runtime from managed runs, and Working Time from explicit human interactions. It reads only supported Tycho surfaces, reuses the machine's existing Bearer Lineage under a distinct source instance, and transmits nothing beyond Cukup's closed event schema.

## Blocked on

Tycho's two reads are proposed but unreviewed and unmerged — see [Upstream Tycho reads](../tycho-adapter.md#upstream-tycho-reads). Do not start shipped implementation until they are agreed. A local prototype against private files may inform design but cannot satisfy acceptance.

## Lifecycle mapping

| Tycho fact | Cukup evidence |
|---|---|
| One managed run (`run_id`) | one Agent Runtime interval |
| A resumed native session (new `run_id`) | another runtime interval |
| `prompt_submitted` | one Engagement Observation |
| `inquiry_answered` | one Engagement Observation |
| `run_taken_over` | one Engagement Observation |
| Native session ID, prompt count, PID, liveness | nothing |

Runtime is finalized-first. A terminal event comes only from a durable terminal timestamp; no `liveness` value produces one.

## Non-goals

- Implementing composition observation, or treating submission coverage as complete rather than a disclosed lower bound.
- Forwarding Tycho hooks as evidence. Hooks are optional wake-ups only.
- Reading `managed_agents.json`, `memory.jsonl`, raw logs, or any other private file in shipped code.
- Synthetic heartbeat sessions, service-side liveness, or any change to aggregation semantics.
- Reinterpreting existing v1/v2 evidence, or changing the wire protocol, dashboard, or targets.
- Attributing a remote Tycho host to the local Machine Label.

## Privacy constraints

No absolute path, workspace, command, prompt, draft, summary, structured result, native session ID, model, provider, PID, agent key, or derived measure of content may be persisted by the adapter or leave the machine. `run_id` and `observation_id` are local reconciliation identities; the Cukup core mints wire identities. The adapter never constructs a wire event and never writes the outbox.

## Acceptance criteria

Each criterion names a command and a decisive observable result. `bun run check` must pass throughout.

1. **Idempotent reconciliation.** A test runs reconciliation twice over the same fixture state and asserts the second pass adds no outbox row and changes no existing row. Command: `bun test`.
2. **Ordering.** For every run, the emitted start has a lower `source_sequence` than its end. Asserted directly on outbox rows.
3. **Convergence without hooks.** With no hook configured and reconciliation invoked only on its timer, a fixture containing a finalized run, an open run, an archived agent, and more than ten historical runs yields exactly the expected intervals.
4. **No fabricated ends.** A fixture open run with `liveness: dead` and no terminal timestamp emits a start and no end. A later fixture that finalizes it emits the end at the durable `finished_at`.
5. **Timestamp normalization.** A run whose `started_at` is read once at full precision and once after a simulated restart produces byte-identical `occurred_at`, and `monotonic_duration_ms` is absent on every Tycho event.
6. **Working Time is engagement-only.** A fixture with a scheduled run and no interaction yields Agent Runtime greater than zero and Working Time of zero. Adding one interaction opens exactly one 15-minute window.
7. **Union without inflation.** Overlapping Amp and Tycho evidence in `createLocalStack()` produces a summary equal to the union, not the sum. Command: `bun test service/integration.test.ts`.
8. **Attribution.** An exact normalized `project_key` maps automatically; a differing identity without an alias is Unassigned; an unmappable key is Unassigned and surfaces a warning. No case consults a path or Git metadata.
9. **Schema precondition surfaced.** With the local service on `preferred_new_event_schema_version: 1`, the reconciler logs the negotiated version and its evidence is Unassigned rather than silently dropped.
10. **Prohibited fields rejected.** A test asserts every prohibited field is absent from persisted adapter state and from every outbox row, by key-set equality rather than substring search.
11. **Credential-free.** All of the above run through `createLocalStack()` with no Fleet access, production credential, DNS, or network egress. `env -i PATH=$PATH HOME=$HOME bun run check` passes.
12. **Documented.** Installation, authentication, project mapping, status, troubleshooting, and removal are documented, including that Working Time is a lower bound until composition is observable.

## Not expressible as a runnable criterion

Two contract requirements are review obligations rather than tests, and should be confirmed in the pull request description:

- that the adapter reads only surfaces Tycho documents as supported;
- that capability coverage is presented to the user as coverage rather than as accuracy.

## Sequencing

1. Move Amp behind the harness ports with no behavior change (separate pull request).
2. Land the agreed upstream Tycho reads.
3. Add the reconciler, its `run_id`-keyed checkpoints, and normalization.
4. Add Engagement Window and Agent Runtime persistence and aggregation, which need their own reviewed protocol and migration design.

Steps 3 and 4 must not land as one change.
