# Stage 5D: opt-in physical Amp shadow integration

Stage 5D connects the existing [experimental Amp hook collector](experimental-amp-shadow-collector.md)
to the [Stage 5C physical outbox](stage-5c-physical-shadow-outbox.md). It is runnable in the existing
Cukup plugin, but **off by default**. It is an experimental physical Amp slice, not a generic Harness
support claim, native installer integration, production rollout, or accounting cutover.

## Activation and storage

Only the exact environment value below, present when the plugin loads, enables this path:

```sh
export CUKUP_EXPERIMENTAL_PHYSICAL_AMP_SHADOW=1
```

Reload the installed Cukup plugin or restart Amp after changing activation. Unset the variable and
reload to disable; this retains the spool. The older `CUKUP_EXPERIMENTAL_AMP_SHADOW=1` remains the
independent local-runtime experiment and does not activate cloud delivery. No receiver is needed
for Stage 5D. Do not enable both experiments unless intentionally collecting into both independent
destinations; no cross-destination deduplication is claimed.

The physical path accepts only Amp's supported executor kind `local`, with the same local executor
profile and `os.hostname()` convention as legacy sync. `remote` (including Amp-orb execution) and
`unknown` fail closed before hooks, commands, spool creation, or credential use. The plugin passes
its existing physical file TokenProvider, never its remote OIDC provider, to an active physical
collector. This relies on Amp's executor classification; it does not infer physical identity from
an environment variable or a checkout path.

Existing configuration supplies `CUKUP_SERVICE_URL` (default `https://api.cukup.dev`) and
`CUKUP_TOKEN_FILE` (default `$HOME/.config/cukup/token`). The existing service URL validator and
owner-only `0600` token-file checks apply. Each attempted drain rereads the file; rotation does not
require plugin reload. The physical hostname must already be accepted by the Stage 5B service's
fleet/profile policy. This slice neither provisions credentials nor changes that policy.

The dedicated spool is
`${XDG_STATE_HOME:-$HOME/.local/state}/amp-work-hours/experimental-physical-amp-shadow/spool.sqlite`.
Its directory must be canonical, owner-owned, and `0700`; files and SQLite sidecars are `0600`.
One owner holds the companion SQLite lock. There is no arbitrary spool-path override. The existing
collector also stores its random `collector-instance-id` in this directory for its internal
envelope seam; cloud identity and source order are assigned independently and durably by the
physical outbox. No legacy source identity, sequence, state, or queued row is reused or migrated.

## Evidence and bounded lifecycle

The unchanged collector emits only `execution.segments`: a live `running` observation following
`agent.start` opens a segment; a non-running transition or matching `agent.end` closes it.
An approval wait ends the current segment, and resumed execution opens a different one. Native
thread/message IDs are used only for in-memory correlation. Prompts, output, tool payloads, paths,
hostname, and bearer credentials never enter the spool or aggregate diagnostics. Evidence remains
Unassigned because no approved Cukup Project UUID mapping exists. No engagement, bootstrap state,
process-liveness duration, recovered endpoint, or cross-restart hook deduplication is claimed.

The collector's bounded observation queue persists each fact locally before requesting delivery.
On the first successful ownership of a durable spool, Stage 5T first persists one prospective declaration
of the collector's exact static `execution.segments` set. Its identity/effective instant are restart-idempotent;
it does not cover older evidence and no loss fact is inferred. Evidence and coverage then share one FIFO.
Hooks return without awaiting network. Startup requests one drain step; enqueues request bounded
steps and coalesce requests while a step is in flight. A step handles only the oldest record and
uses at most two requests (profile then shadow ingestion), each with a 1-second abort timeout.
There is no timer-driven retry, poller, daemon, or promise to empty a backlog automatically.

The opt-in-only **Cukup → Experimental physical shadow** command displays fixed aggregate spool
counts and offers **Drain one record**. Merely opening status sends nothing. An explicit drain
honors persistent backoff and terminal FIFO blockers and reports only its fixed outcome plus
aggregate status. Neither operation changes legacy status, totals, recording, or synchronization.
Operators must investigate blockers separately; this slice offers no destructive skip/repair button.

Disposal unsubscribes the command and hooks first, flushes already queued local observations, waits
for existing hook/command drains, and closes the outbox only afterward. It does not invent an end
for an open segment or start a final backlog drain. A missing end remains pending after restart.
Command drain waits and disposal return within a 2.5-second wait budget if a broken transport ignores abort;
the original cleanup continues and retains ownership until that request settles. A replacement
owner is refused in the meantime. Abrupt process death can lose observations still in memory,
but not evidence already committed to the spool. No hard real-time guarantee is made for a blocked
event loop or filesystem.

Failures produce only fixed warnings and aggregate counts, never exception/response text. A
blocked or unavailable shadow path does not mark legacy tracking incomplete. Normal replay,
duplicate acknowledgement after response loss, bearer rotation, and outage retention inherit
Stage 5C's exact-record FIFO contract.

## Verification and deployment boundary

Credential-free, in-process fixtures exercise real collector hooks, SQLite spooling, Stage 5B
ingestion, outage/restart/replay, response-loss duplicate handling, file-token rotation, bounded
commands/disposal, subscription/ownership ordering, legacy byte isolation, concurrent legacy
recording/sync, and privacy sentinels. No physical production run or actual cloud call is claimed.

Stage 5D originally changed plugin code and documentation only. Stage 5T also adds a service route and is
therefore not publication-neutral; see its compatibility and rollout constraints. Stage 5D changes no
authority setting and remains default-off. Stage 5T changes no service schema, service declaration,
installer, deployment setting, or production activation. An owner-approved future activation requires
the current schema-8 service with the Stage 5T route; earlier Stage 5D-only deployments are incompatible
with capability delivery. Stage 5D itself did not trigger the path-filtered service publication workflow.

OIDC/Amp-orb cloud execution-site design, non-Amp collectors, unsupported engagement evidence,
aggregation/union, clipping, dashboard/coverage, historical migration/backfill, production rollout,
and cutover remain separate work. This integration does not change authoritative work-hour totals.
