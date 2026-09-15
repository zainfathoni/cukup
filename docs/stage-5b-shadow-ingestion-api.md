# Stage 5B: authenticated cloud shadow ingestion

Stage 5B adds only the service HTTP boundary that connects an authenticated physical execution site to Stage 5A shadow persistence. It remains non-authoritative: no collector uploader, aggregation, clipping, dashboard, coverage, migration/backfill, deployment, cutover, or legacy v1/v2 behavior changes are included.

## Authentication and site binding

`POST /v1/shadow-evidence` uses the existing API hostname, HTTPS, bearer authentication, bounded JSON body, fixed errors, and privacy-safe route logging. Only a Cukup physical bearer is eligible. Amp workload OIDC receives `physical_bearer_required`; generic OIDC/Amp-orb ingestion is deferred until a separate execution-site design is reviewed.

The bearer must already have its immutable Executor Profile. Profile binding creates an independent server-side random UUIDv4 execution-site ID. Schema 6 backfills one for each active bound schema-5 bearer, and atomic token rotation copies it to the replacement. The ID is not derived from or exposed as the hostname, Executor Label, token, source ownership, or collector identity. An unbound bearer fails before body handling and without shadow or credential mutation.

## Closed wire contract

The JSON root contains exactly `source_sequence` and `envelope`. It cannot contain a caller-supplied execution site, hostname, Executor Label, source instance/ownership, metadata, or any additional field. After body parsing, `ServiceStore.appendPhysicalEvidence` revalidates bearer activity and site binding under the same immediate writer transaction as `ServiceStore.shadow.append`, then constructs exactly `{executionSiteId, sourceSequence, envelope}`. A revocation or rotation committed first prevents both a new append and a duplicate acknowledgement. Stage 5A remains the single closed evidence-validation and persistence authority.

Successful append and replay return only `accepted` or `duplicate`. Parser, identity, and ordering failures return only `invalid_record`, `unsupported_version`, `identity_conflict`, or `invalid_order`. All are fixed closed JSON values and never reflect identifiers, payload values, database diagnostics, or stack traces. Transport and authentication failures retain the existing service error contract.

A collector first accepted from one bearer lineage remains bound to that lineage's random site. Submission of that collector from another physical lineage therefore returns `identity_conflict`; a client-provided site cannot bypass this check. Rotation within the original lineage preserves exact retry and subsequent ordering continuity.

## Compatibility and deployment

Legacy tables, source ownership, v1/v2 routes and response schemas, summaries, targets, and dashboard behavior remain unchanged; shadow records remain isolated. This change is not deployment-neutral: service startup moves SQLite to schema 6 and a service-path push may publish an image. Pre-schema-6 binaries must not open the migrated database. No push, release, deployment, production access, or production migration is part of this slice.
