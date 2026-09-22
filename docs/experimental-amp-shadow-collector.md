# Experimental Amp shadow collector

**Status:** opt-in and undeployed. This collector is not an official Amp support claim. It does not write to the deployed v1/v2 store or cloud sync path.

The collector sends local execution evidence to the [experimental local protocol](experimental-local-harness-evidence-protocol.md). [ADR 0008](adr/0008-do-not-infer-working-time-from-agent-runtime.md) explains why this evidence cannot create human Working Time.

## Verified Amp capability

The inspected Amp API does not establish human origin for `agent.start`. Waiting for approval does not prove that a human acted.

Read the [collector](../plugin/experimental-amp-shadow-collector.ts) for hook handling. Read the [corrected orb proof](incidents/2026-09-13-experimental-amp-proof.md) for observed results and limits.

## Deliberate omissions and recovery limit

The collector has no recovery capability. It does not inspect active threads at startup. After a restart, an old open segment stays pending and has no duration. The collector never creates a synthetic end.

Current Amp Project identity is not an approved Cukup Project UUID mapping. Therefore, shadow evidence is Unassigned.

## Opt in and run the credential-free harness

Start the experimental receiver at the same execution site. Then set:

```sh
export CUKUP_EXPERIMENTAL_AMP_SHADOW=1
export CUKUP_EXPERIMENTAL_RUNTIME_STATE_DIR=/absolute/owner-only/runtime-state
export CUKUP_EXPERIMENTAL_AMP_SHADOW_STATE_DIR=/absolute/owner-only/collector-state
```

The collector-state variable is optional. Its default is below the existing `XDG_STATE_HOME/amp-work-hours` directory.

Initial discovery failure records no evidence. A runtime restart on a new port requires a plugin reload. Queued evidence survives in the collector spool. Retry occurs at startup and on later live events. There is no background delivery timer.

Run the synthetic harness against non-production state:

```sh
bun run experimental/amp-shadow-collector-harness.ts \
  /absolute/owner-only/runtime-state \
  /absolute/owner-only/harness-collector-state
```

Success prints a fixed accepted-record count. A collector failure emits one privacy-safe warning. It does not stop Amp work or deployed legacy tracking.
