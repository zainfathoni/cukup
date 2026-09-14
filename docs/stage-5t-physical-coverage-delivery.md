# Stage 5T: physical coverage-fact delivery

Stage 5T connects the Stage 5H coverage persistence boundary to the existing default-off Stage 5C/5D
physical transport. It adds no report, dashboard, target, cutover, or authority activation. The exact
`CUKUP_EXPERIMENTAL_PHYSICAL_AMP_SHADOW=1` gate remains required; OIDC and Amp-orb coverage ingestion
remain unsupported, and Stage 5P remains blocked.

## Authenticated service boundary

`POST /v1/shadow-coverage` accepts exactly `{source_sequence,envelope}` from an authenticated physical
bearer with an existing immutable executor profile. HTTPS/API-host, method, authentication, and
authentication-derived profile/site checks precede body parsing. The route rejects OIDC, caller-supplied
site/profile/project attribution, query parameters, content encoding, non-JSON media, invalid UTF-8,
duplicate JSON keys, malformed JSON, and bodies beyond the existing service request-byte limit. It logs
only the fixed route and response metadata, never payloads or raw errors.
After body parsing, bearer activity and site binding are revalidated under the same immediate writer
transaction as append, so revocation or rotation during a streamed request fences even an exact retry.

After strict framing, the existing Stage 5H parser and append transaction own validation and persistence.
Accepted, exact duplicate, `invalid_record`, `unsupported_version`, `identity_conflict`, and
`invalid_order` outcomes are unchanged. An acknowledgement is produced only after the append transaction
commits. Evidence and coverage use the same bearer-derived site, collector binding, and accepted source
high-water. Legacy v1/v2 and synchronization behavior are unchanged.

## One physical FIFO

The Stage 5C spool schema advances from 2 to 3 by adding one closed `record_kind` discriminator to the
existing AUTOINCREMENT queue. Existing evidence rows become `evidence` in place. Their bytes, state,
block reason, retry state, collector identity, source sequence, and `sqlite_sequence` high water are
preserved transactionally and survive restart. New `coverage` rows share the same count/byte/record
limits, oldest-first blocking, persistent backoff, profile request, timeout, redirect refusal, bounded
response parser, closed terminal outcomes, and deletion-after-accepted-or-duplicate behavior. Exact
retries reuse the stored envelope, fact identity, sequence, and service receipt.
Migration does not recreate or reset missing/corrupt Stage 5L synchronization state, and preserves a
valid nonzero synchronization revision/pending/suspension unchanged.

`enqueueCoverage` is an explicit local boundary. Its caller remains responsible for the truth and exact
affected capabilities of an irreversible-loss fact. The outbox never derives loss from a sequence gap,
warning, retry, blocked row, shutdown, pending endpoint, missing evidence, or storage pressure.
Synchronization sampling counts either queued family and uses each retained fact's explicit occurrence
time; synchronization remains an independent dimension and does not imply loss or completeness.

## Truthful default-off declaration

When—and only when—the existing physical Amp owner passes its exact opt-in and local-executor checks, it
atomically enqueues one prospective capability declaration for its exact static
`execution.segments` capability set before installing hooks. Its effective instant is the first successful
initialized ownership of that durable spool. The random fact ID and effective instant are recorded with
the queued row, and a durable marker prevents another declaration after acknowledgement or restart.
An older spool therefore declares only prospectively; Stage 5T does not backfill capability over prior
evidence. If declaration persistence fails or the bounded spool is full, physical shadow initialization
fails closed rather than collecting evidence without the declaration. No loss fact is emitted.

## Compatibility, publication, and rollback

This slice is **not publication-neutral**. `service/**` changes alter the service image inputs and add an
authenticated route; `plugin/**` changes alter the plugin build; activating a migrated physical spool can
publish the declaration after a compatible service is deployed. No production access, shared database or
setting mutation, push, publication, deployment, or activation is performed or authorized here.

The service database schema remains 8: Stage 5T uses the already-settled schema-7 coverage table and adds
no service migration. The local physical spool migration is automatic and restart-safe, but a schema-2
outbox binary refuses schema 3. Rollback must retain the schema-3 spool and all queued/blocked evidence and
coverage rows and use a schema-3-aware plugin/outbox, or pause the physical experiment. Never lower
`user_version`, delete the declaration marker, skip a blocker, or restore an older spool over accepted or
queued facts. Service rollback must remain schema-8 compatible and retain Stage 5H facts. Publication must
ship compatible service and plugin revisions before owner-approved activation; partial rollout may leave
the declaration durably queued/blocked but cannot create loss or authority.
