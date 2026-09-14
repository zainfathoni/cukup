# Stage 5K: service synchronization snapshots

Local-only implementation of the server-owned [Stage 5J contract](stage-5j-shadow-synchronization-contract.md).
This slice itself added no client, scheduling, upload activation, Stage 5I integration, dashboard, or
production clock provider. Stage 5M later consumes its classified internal reads through a pure value
boundary; no deployment is authorized.

## API and persistence

`POST /v1/shadow-synchronization` uses the existing API hostname and TLS/proxy boundary (HTTPS remains
mandatory even when other local API routes disable that requirement). Authentication and physical
Executor Profile checks precede body reading. The service accepts exactly the eight Stage 5J fields,
at most 1024 raw bytes read into a bounded buffer, strict UTF-8 and JSON with duplicate decoded keys
rejected at every depth. Only JSON with optional UTF-8 charset is accepted; any Content-Encoding is
rejected. Shape/consistency precedes unsupported-version selection. Bodies, response errors and
headers follow Stage 5J; no request values or diagnostics are returned. No limiter is added here, so
the reserved `429 rate_limited` outcome has no new producer. Storage exceptions map to closed 500;
untrusted clocks map to 503 for new observations. Logs for this route family contain only fixed
`shadow_synchronization` event/level and HTTP status, without method, path, duration or diagnostics.

`ServiceStore.synchronization.observe(tokenId, input)` is internal. The token ID must come from app
authentication. An immediate SQLite transaction rechecks active bearer/profile, validates the record,
checks an existing collector/site binding, and compares the latest observation sequence. It cannot
register a collector. Revocation/rotation committed first prevents acceptance and duplicate lookup.
Lower sequence is stale; equal normalized fields at equal sequence are duplicate without writes;
changed equal revision conflicts. Only first/greater revisions reach the receipt-time check. Accepted
replacements commit before acknowledgment. The independent evidence/coverage source order is untouched.

Schema 8 adds only `shadow_synchronization`, one row keyed by the existing collector foreign key. It
stores the normalized eight fields, receipt R and expiry min(R + 120000, O + 120000). New observations
require R − 60000 ≤ O ≤ R + 10000. There is no history, TTL deletion, backfill, site copy, or new binding.
Expired content remains for lifetime replay protection. Future collector deletion must remove its
snapshot and separately solve identity reuse; this change adds no collector deletion policy. SQLite
and backups may retain superseded bytes under the existing backup policy.

`ServiceStore.synchronization.read(collector, site)` is internal only. It returns `{state:'fresh',
snapshot}` exactly when a trusted sample N satisfies R ≤ N < expiry at the requested site. Missing,
expired, malformed retained content or receipt/expiry invariants, backward/invalid clock, wrong site
and failed reads yield only `{state:'unknown'}`. There is no fallback to evidence receipts, source
order, previous reads, availability caches, or report panels.

## Explicit clock trust, not a guessed UTC repair

The optional second ServiceStore constructor argument is a service-owned clock source with `now()`
(integer UTC milliseconds) and `trusted()` (host UTC-health attestation). Startup samples and checks
both; ordinary sampling rechecks trust and detects backward samples. Failure latches unhealthy for
that store/service process. Even when time catches up, it does not recover automatically. After host
clock repair/revalidation, an internal operator integration may explicitly call
`synchronization.clock.restoreTrust()`. No HTTP control, settings, NTP implementation or production
caller is introduced. Trust attestation must come from a real host health check, not a constant true
in production; injectable true is used only by disposable tests. The default source is untrusted,
so the unchanged production entrypoint cannot accept new snapshots and internal reads remain unknown.

Replays still receive their order/duplicate/conflict classifications while clock health is degraded;
they do not write or refresh status. Read times before a retained receipt remain unknown even after
explicit revalidation or restart. The boundary detects sampled backward jumps, not undetectable clock
errors or jumps between samples; client counts/state are bounded claims, never proof of completeness.

## Publication and rollback

Service files match the existing `publish-service.yml` main-push filter. Publishing this slice and its
prerequisite chain therefore requires separate authorization; documentation-only publication neutrality
does not apply to Stage 5K. Package, workflow, Docker inputs and service entrypoints are unchanged.
The restricted service build uses only the existing service/package/lock/config inputs.

Opening any supported older database applies schema 8 under the existing immediate migration
transaction. Migration is additive from schema 7, restart safe, future-refusing and does not backfill
snapshots or rewrite legacy v1/v2, evidence, coverage, credentials, bindings or target overrides.
Earlier schema-aware binaries refuse version 8. After migration, use a schema-8-aware binary; do not
decrement user_version or delete snapshots to force rollback. A separately authorized stopped-service
restore of a verified pre-migration backup loses subsequent accepted data and may lose synchronization
replay protection. Preserve the current database/sidecars before incident recovery. Existing backup
retention and independent retrieval obligations remain unchanged. No shared database is migrated here.
