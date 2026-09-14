# Stage 5U: explicit physical synchronization invocation

Stage 5U adds one **Synchronize status** action to the existing
`experimental-physical-shadow` plugin command. It is registered only after the unchanged exact
`CUKUP_EXPERIMENTAL_PHYSICAL_AMP_SHADOW=1` and local physical-executor checks and successful outbox
initialization. Default, unset, nonexact, remote/OIDC/Amp-orb, unknown, and failed initialization paths
create no command, action, spool state, credential access, or synchronization request.

## Explicit invocation and ownership

Choosing the action invokes the already-implemented Stage 5L
`PhysicalShadowEvidenceOutbox.synchronizationStep()` once. Merely loading the plugin, starting Amp,
opening the command, recording evidence, enqueueing coverage, draining the FIFO, or disposing does not
invoke it. There is no timer, startup call, background loop, autonomous retry, or post-drain call.

Stage 5L remains the sole owner of the behavior: a new/restarted outbox waits 60000 ms of valid monotonic
elapsed time; attempts, including failures, restart that cadence; concurrent explicit command calls share
its singleton in-flight promise; and its independent durable revision, pending candidate, stale suspension,
total deadline, bearer reread, no-network-under-lock rule, and fixed terminal/waiting outcomes are unchanged.
The plugin does not select retry mode, repair clocks or registration, inspect pending state, or reinterpret
`waiting`, `disabled`, `suspended`, `unavailable`, `accepted`, `duplicate`, `retryable`,
`registration_required`, or `clock_repair_required`.

The notification contains only that fixed result and the existing aggregate spool status. It contains no
bearer, host, collector/evidence/fact/project ID, candidate, timestamp, request/response body, URL, or raw
error detail. Existing fixed warnings remain the only log output. Synchronization neither drains nor
reorders the shared evidence/coverage FIFO and does not create evidence, capability, loss, completeness,
availability, report, dashboard, target, cutover, or authority facts.

Disposal unregisters the command and prevents a new step, then waits for the underlying shared
synchronization promise before closing the outbox. If the plugin's 2.5-second completion budget expires,
cleanup continues in place and retains exclusive spool ownership until Stage 5L settles and permits close;
failures remain fixed warnings and cannot leak request detail. A replacement owner is refused meanwhile.

## Publication and limits

This slice changes plugin, plugin tests, and documentation only. It does not touch service runtime/schema,
dashboard, workflows, packages, shared settings/databases, production data/access, clock trust, OIDC,
Stage 5Q–5S authority, or cutover, and is neutral under the service publication workflow. It does alter the
plugin build: publishing a compatible plugin would make the action available only inside the existing
default-off physical experiment, so plugin publication and owner activation remain separate explicit acts.
The Stage 5K service route and Stage 5T schema-3-compatible physical spool/service prerequisites must remain
compatible. No push, publication, deployment, migration, or activation is performed or authorized here.
