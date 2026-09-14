# Stage 5L: inactive physical synchronization client

The existing `PhysicalShadowEvidenceOutbox` now owns the client portion of
[Stage 5J](stage-5j-shadow-synchronization-contract.md). Nothing invokes it automatically.
`synchronizationStep()` performs one fresh sample and one upload at most; passing `'retry'`
reuses an existing exact pending candidate, or samples if none exists. It never runs from
`drainStep`, Stage 5D, plugin hooks, a timer, or a poller. A fresh observation is preferred:
an exact duplicate cannot renew server freshness.

## Snapshot and transport boundaries

One immediate SQLite transaction reads all retained evidence rows and persists the independent
observation sequence plus exact eight-field candidate before network work. Participation is
defined only for current `engagement`, `execution_start`, and `execution_end` evidence using
their original `timing.wall_time`, including recovered evidence. Unknown families, malformed
rows, unreadable storage, and invalid clocks produce no new candidate, never a guessed clear.
The minimum occurrence is taken over every retained row, not just the FIFO head. Queued plus
blocked counts once; retry markers remain a subset of queued. Precedence is empty/clear,
blocked, retrying, queued. Records and stored payload bytes saturate independently at 10000
and 8388608. No snapshot accessor exposes identifiers, payloads, counts, or timestamps.

Sampling/attempts require 60000 ms of monotonic elapsed time between invocations. Construction
starts a new full wait, including when pending state survives restart. `monotonicNow` is an
injectable monotonic clock for tests; the default is `performance.now`. Backward/nonfinite
monotonic values disable this lane for the owner. UTC snapshot time uses the existing `now`.

The singleton status request runs independently of the evidence single-flight guard and FIFO
backoff. SQLite lock wait is at most 100 ms; no network occurs under the snapshot transaction
or a lock over evidence transport. Each request rereads `TokenProvider`, POSTs only the exact
candidate to `/v1/shadow-synchronization`, makes no profile write, forbids redirects, reads at
most 1024 raw response bytes, and has a 5000 ms total deadline including credential reload,
fetch, and response reading. Abort and a deadline race prevent a noncooperative asynchronous
provider from extending the step or causing late storage mutations. Close refuses both active
transport lanes; ownership cannot transfer while an old step can mutate the spool.
If recording a stale rejection fails, subsequent explicit steps retry only that local write.
Close also retries it and refuses to release ownership until the singleton suspension is durable.
As with any response-driven local write, an abrupt crash before persistence can lose that
response; this guarantee covers orderly shutdown, not an atomic server/client transaction.

Results are fixed strings only: `waiting`, `disabled`, `suspended`, `unavailable`, `accepted`,
`duplicate`, `retryable`, `registration_required`, or `clock_repair_required`. There is no
logging surface. Closed HTTP/semantic classification follows Stage 5J. Invalid/oversized
responses, network loss, 401, 429, and 5xx retain pending for a later bounded attempt. Valid
terminal HTTP errors and repair-required semantic rejections suspend this owner; deliberate
restart permits another bounded attempt without resetting sequence. Registration/time errors
permit a later fresh observation after normal evidence registration or local clock repair;
the caller owns that repair and invocation. Status never manufactures evidence for registration.
Accepted/duplicate clears only a byte-identical pending revision.

## Local schema, repair, and compatibility

Local spool schema 2 adds only `physical_shadow_synchronization`: one constrained singleton row
with the last allocated observation sequence, nullable exact pending JSON, and a stale-suspension
bit. It is not the service database schema. Zero means no observation has been allocated; the
first candidate is sequence 1. A recognized schema-1 spool transitions transactionally, preserving
collector identity, settings, evidence AUTOINCREMENT high water, every FIFO row/retry/block marker,
and existing owner-only directory/file modes. A fresh spool creates the same status state.

Opening schema 2 never recreates status state. Missing/corrupt counter or pending state cannot
reset sequence and prevents upload; evidence continues using its existing state. Exhaustion at
9007199254740991 disables synchronization, not evidence. There is at most one pending revision,
not a status FIFO or observation history. The table contains no bearer, hostname, Executor Profile,
project ID, evidence ID, response, or diagnostic. SQLite pages/WAL/backups may retain superseded
bytes under the existing spool backup policy; this is not secure deletion.

Back up the spool consistently while respecting its single-owner lock and SQLite WAL rules;
retain the identity, evidence sequence, and synchronization state together. Do not delete status
state, downgrade `user_version`, relabel evidence, or guess a higher sequence to repair it.
Restoring an old backup can yield `stale_observation`. That rejection persists suspension across
restart; recovery requires retained newer local state and explicit offline repair under exclusive
ownership, not a server high-water guess. This slice supplies no automated repair/reset command.
If newer state is unavailable, leave synchronization disabled and handle evidence separately.

Older Stage 5C binaries reject schema 2. Rollback therefore requires a compatible binary, not
destructive schema downgrades or replaying an old backup as though it were current. The local
migration occurs when this outbox is constructed, even without synchronization invocation.

## Deployment neutrality and limits

Only the existing experimental owner/tests and this document change. Stage 5D invocation,
plugin activation, service routes/schema, Stage 5I projections, dashboard, availability,
workflows/packages/Docker, settings, and legacy behavior are unchanged. The service publication
workflow does not include these paths. The client requires the separately reviewed Stage 5K
service route if a future caller explicitly uses it; this slice is no rollout authorization.
There is no production caller, scheduler, backfill, loss/capability fact, support claim,
deployment, push, or production data/access change.
