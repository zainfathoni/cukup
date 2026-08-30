# ADR 0002: Shared service release-candidate authority

- Status: Accepted
- Date: 2026-08-30

## Context

ADR 0001 established Cukup as the implementation owner while deliberately migrating no service. Fleet #31 now requires a reviewable shared-service release candidate before any VPS, DNS, TLS, credential, or rollout change. Fresh Amp orbs use workload OIDC; physical machines use independently managed bearer credentials.

## Decision

1. A Bun `fetch` application provides the four v1 routes and can run with direct TLS or behind a trusted TLS proxy. Only minimal `/healthz` is unauthenticated.
2. One SQLite database is authoritative. Events are immutable and uniquely identified by both UUIDv7 event ID and `(random source instance, monotonic sequence)`. Exact replay is a no-op; mismatches are visible and never overwrite data. HTTP field names and response shapes exactly match `plugin/protocol.ts`, including one result per batch input.
3. The API accepts a closed privacy-preserving schema. Authentication-layer workload claims are verified transiently and are never copied into source ownership, events, responses, or logs.
4. Physical bearer values are 256-bit random tokens. Only SHA-256 hashes are stored. Random source IDs are claimed on first accepted ingestion, preventing another bearer or OIDC principal from submitting as that source. Rotation transfers those claims atomically.
5. Amp workload JWTs are verified with issuer discovery/JWKS, RS256, fixed issuer/audience, expiry, exchanged-token use, and one exact configured user ID. OIDC source ownership stores only a non-identifying `oidc` class marker.
6. New evidence outside ±10 minutes of receive time is rejected and surfaced. Exact old replays remain duplicates. Accepted timestamps are not corrected or rewritten.
7. The server constructs 15-minute completed/grace intervals, 15-minute unmatched-start caps, clips at server `as_of`, globally unions all sources, and then calculates daily and Monday-week overlaps using IANA timezone civil boundaries. Product values are fixed to Asia/Jakarta and 8-hour weekdays.
8. Backups use SQLite `VACUUM INTO` online snapshots followed by full integrity and checksum verification. Metadata and clean restore tooling are part of the release candidate; no off-site provider is claimed by code.
9. Container and Kamal assets are distinct from any other application and contain placeholders/references only. Deployment remains a separate, explicitly approved operation.

## Consequences

- Clients may delete only `accepted` and `duplicate` records from durable outboxes.
- Source/session identifiers remain random privacy handles rather than fleet identity.
- OIDC discovery temporarily depends on Amp’s identity endpoint; cached keys reduce request volume, and authentication fails closed when metadata or verification fails.
- Monotonic duration is retained but does not alter authoritative UTC endpoints in v1.
- SQLite is suitable for the current personal write volume but requires the documented persistent volume, backup checks, clean restore drills, and single-service-writer deployment.
