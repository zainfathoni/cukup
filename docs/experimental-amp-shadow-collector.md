# Experimental Amp shadow collector

This is Cukup's first real generic Harness Adapter collector. It is explicitly experimental,
opt-in, shadow-only, and not an official Amp support claim. It emits the existing experimental
local Harness evidence protocol to a separately running local runtime. It never writes generic
evidence to the deployed legacy v1/v2 store or cloud sync path.

[ADR 0008](adr/0008-do-not-infer-working-time-from-agent-runtime.md) records why these execution
signals must not be used to infer human Working Time or modeled collaboration time.

## Verified Amp capability

The collector uses supported `@ampcode/plugin` APIs available to this repository:

- `agent.start` identifies a turn for process-local correlation. The API also supports automatic
  continuation and programmatically appended user messages but exposes no origin discriminator,
  so this hook does not defensibly establish human submission, follow-up, approval, or takeover.
- `ThreadState.running` explicitly means inference or tool execution is in progress.
- `ThreadState.awaiting-approval` explicitly means the agent is blocked waiting for tool approval.
  A live transition to that state closes an open execution segment, and a later live transition to
  `running` opens a distinct segment. No approval engagement is emitted because the state proves a
  wait, not who approved it.
- `agent.end`, plus live transitions from `running` to a non-running state, supplies an observed
  execution endpoint. `agent.start` alone is not used as an execution start because handlers can
  still prevent the turn from starting; a live `running` observation opens the segment instead.

The exact declaration is only `execution.segments`; no engagement evidence is emitted. All
records use collector-observation timing. Amp thread/message identities are used only for process-local
deduplication and correlation and never enter protocol values, spool diagnostics, logs, or errors.
Prompt/output/tool data is not read or retained.

## Deliberate omissions and recovery limit

`session.start`, active-thread focus, and process/plugin lifetime are not evidence. The collector
does not call `ThreadState.get()` at startup and declares no recovery capability. After collector
restart, an earlier open execution start remains pending with no duration; disappearance, idle
state, or a later hook never synthesizes its end. Collection resumes only with a new live
`agent.start`. A plugin-process restart can also make a replayed duplicate start indistinguishable
from a new delivery, so no cross-restart hook deduplication is claimed.

The existing Amp Project resolution seam returns a native Amp identity and legacy Project Slug,
not an approved mapping to a Cukup Project UUID. Exporting that native identity would violate the
generic protocol, so production shadow evidence is explicitly Unassigned. The collector has a
typed synchronous attribution seam for a future approved mapping; values are copied at execution
start. Rename refresh remains future work and this collector does not implement a rename fix.

## Opt in and run the credential-free harness

The local evidence runtime must already be running at the same execution site. Enable the plugin
collector only with the exact value `1`:

```sh
export CUKUP_EXPERIMENTAL_AMP_SHADOW=1
export CUKUP_EXPERIMENTAL_RUNTIME_STATE_DIR=/absolute/owner-only/runtime-state
# Optional; defaults below the existing XDG_STATE_HOME/amp-work-hours directory:
export CUKUP_EXPERIMENTAL_AMP_SHADOW_STATE_DIR=/absolute/owner-only/collector-state
```

If runtime discovery or measurement fails, the plugin emits only one fixed privacy-safe warning;
Amp work and legacy tracking continue. The durable client spool and collector UUID remain in the
collector state directory. Enqueue and each event-triggered drain step retain the protocol's
existing count, byte, SQLite-busy, request, and response bounds.

Discovery is intentionally narrow in this slice. Initial discovery failure records no evidence.
The client retains the discovered loopback origin, so a runtime restart on a new port requires a
plugin reload; queued evidence then survives in the spool and is retried. Retry attempts happen at
startup and on later live events rather than from a timer, and each trigger performs bounded drain
steps rather than promising autonomous eventual delivery.

With a local runtime already running, exercise the real discovery, spool, negotiation, receiver,
wait segmentation, and disposal path using synthetic events and the runtime's provisioned local
token (no credential is passed or embedded):

```sh
bun run experimental/amp-shadow-collector-harness.ts \
  /absolute/owner-only/runtime-state \
  /absolute/owner-only/harness-collector-state
```

Success prints only the fixed accepted-record count. Do not use production state for this
experimental harness.
