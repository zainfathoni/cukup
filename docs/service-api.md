# Shared service API

The release-candidate service is the cross-source authority for Cukup work time. It is not deployed by this repository change. Production configuration is fixed to:

- timezone: `Asia/Jakarta`;
- week start: Monday;
- targets: 8 hours Monday–Friday and 0 hours Saturday–Sunday;
- completed-turn grace: 15 minutes;
- unmatched-start crash cap: 15 minutes;
- maximum client clock skew: 10 minutes.

Summary amounts are whole minutes. All timestamps are UTC RFC 3339 strings with exactly three fractional digits, such as `2026-08-31T05:00:00.000Z`. Responses use `application/json` and `Cache-Control: no-store`.

## Transport and authentication

`/v1/*` requires HTTPS. The application accepts either a direct TLS request or an `X-Forwarded-Proto: https` request when explicitly configured behind the trusted Kamal Proxy hop. Plain HTTP is accepted only on a loopback-only development binding. Never put a credential in a URL.

Every `/v1/*` request uses `Authorization: Bearer <credential>` with one of two credential types:

1. **Physical machines:** a high-entropy `cukup_v1_…` token. Each physical machine gets an independent token. SQLite stores only its SHA-256 hash; the token is random enough that password-style slow hashing adds no useful protection. The first accepted event claims its random source instance for that credential. Other credentials cannot claim or submit to that source. Rotation atomically transfers source claims and revokes the old token.
2. **Fresh Amp orbs:** an Amp workload JWT. The service discovers the JWKS from issuer `https://ampcode.com/api/workload-identity`, permits only RS256, requires audience `https://cukup.dev`, verifies `exp`, requires `token_use=exchanged`, and compares `user_id` with the single configured allowed value. JWTs and claims are never persisted or logged. Claims such as `thread_id` are an unavoidable auth-layer input and are an explicit exception to the event privacy contract; they never enter source ownership, event rows, responses, or logs.

Authentication failures always return the same `401 {"error":"unauthorized"}` response. Route existence under `/v1/` is not disclosed before authentication.

## `GET /healthz`

Unauthenticated liveness check:

```json
{"ok":true}
```

It intentionally exposes no build, database, credential, user, or deployment information.

## `GET /v1/time`

Returns a sample for client request/response clock-offset estimation:

```json
{"server_time":"2026-08-31T05:00:00.000Z"}
```

Clients should bracket this request with monotonic local times and use the midpoint to estimate offset.

## `GET /v1/capabilities`

Returns the migration-aware ingestion floor and the independently switchable schema for future turn starts:

```json
{
  "schema_version": 1,
  "accepted_event_schema_versions": [1, 2],
  "preferred_new_event_schema_version": 1
}
```

The response schema remains 1. Event schemas 1 and 2 are accepted permanently so delayed outbox rows can converge. `preferred_new_event_schema_version` defaults to 1 and is controlled by `CUKUP_NEW_TURN_EVENT_SCHEMA_VERSION`; a future plugin may snapshot 2 only when this value is 2. Changing it back to 1 affects only future starts and never disables replay of queued or in-progress v2 rows.

## `PUT /v1/executor-profile`

Physical bearer callers bind their Bearer Lineage once, before uploading v2 events. The request is an exact closed envelope containing the unmodified local `hostname()` value:

```json
{"hostname":"zain-macbook"}
```

The hostname must exactly match one canonical lowercase hostname in `CUKUP_FLEET_HOSTNAMES`. The service does not trim, lowercase, or otherwise guess the submitted value. A new binding and an exact retry both return:

```json
{"executor_label":"zain-macbook"}
```

A different binding for the same active lineage or a label held by another active lineage returns `409 {"error":"executor_profile_conflict"}`. A malformed or unrecognized profile returns `422 {"error":"invalid_executor_profile"}` without reflecting a label. Workload OIDC returns `403 {"error":"physical_bearer_required"}` and never accepts a hostname; OIDC-owned evidence derives the Executor Label `amp-orb`. A physical v2 event submitted before binding is rejected, while existing physical v1 ingestion remains unchanged.

## `POST /v1/events:batch`

The request root contains only `events` and is limited to 1 MiB. Records for each source must be in nondecreasing source-sequence order. Schema v1 remains byte-for-byte unchanged:

```json
{
  "events": [
    {
      "schema_version": 1,
      "event_id": "01990b2e-1c00-7000-8000-000000000001",
      "source_instance_id": "7ebc7d16-3945-4e30-b46e-2c288d747f6f",
      "source_sequence": 1,
      "session_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "kind": "agent.start",
      "occurred_at": "2026-08-31T05:00:00.000Z",
      "monotonic_duration_ms": 42
    }
  ]
}
```

Schema v2 has the same fields and adds only optional `project_slug`:

```json
{
  "events": [
    {
      "schema_version": 2,
      "event_id": "01990b2e-1c00-7000-8000-000000000002",
      "source_instance_id": "7ebc7d16-3945-4e30-b46e-2c288d747f6f",
      "source_sequence": 2,
      "session_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "kind": "agent.start",
      "occurred_at": "2026-08-31T05:01:00.000Z",
      "project_slug": "cukup-service"
    }
  ]
}
```

- New `event_id` values are UUIDv7. Deterministically migrated legacy events use namespace-derived UUIDv5 values.
- `source_instance_id` is an independently random RFC 4122 UUIDv4. New `session_id` values are random UUIDv4 values; deterministically migrated legacy sessions use namespace-derived UUIDv5 values. They must reveal no machine, fleet, host, user, repository, project, thread, or message identity.
- `source_sequence` is a positive safe integer, monotonic within one source.
- `kind` is `agent.start` or `agent.end`.
- `monotonic_duration_ms` is optional nonnegative monotonic evidence on a completed turn. When present, aggregation derives the completion endpoint from the start plus this duration so a wall-clock adjustment during the turn cannot distort worked time.
- v2 `project_slug`, when present, is 1–64 characters matching `[a-z0-9]+(?:-[a-z0-9]+)*`. Absence means Unassigned. v1 does not permit this field.

Each event version is a separate closed schema. Unknown fields are rejected per record, preventing hostnames, usernames, repository/project IDs other than the explicit v2 slug, thread/message IDs, prompts/content, model names, and fleet-identifying values from crossing the event boundary. A v2 end must have the same schema and Project Slug as its accepted start.

The response contains exactly one result in request order for every input event when the root request is valid:

```json
{
  "results": [
    {
      "event_id": "01990b2e-1c00-7000-8000-000000000001",
      "status": "accepted"
    }
  ]
}
```

Outcomes:

- `accepted`: inserted once; the client may remove it from its outbox.
- `duplicate`: immutable payload exactly matches either identity; the client may remove it.
- `conflict`: either immutable identity mismatched; accepted data is never overwritten and the client must retain/surface the record.
- `rejected`: malformed/prohibited/order records, source authorization mismatch, missing physical v2 profile, turn-attribution mismatch, or clock skew; the client must retain/surface the record.

The wire result deliberately contains only `event_id` and `status`, matching the plugin protocol. The database still preserves the first `received_at`, and service tests distinguish both immutable conflict identities and every rejection boundary internally.

Exact replay compares every immutable row field, including event schema and nullable Project Slug, so replaying unchanged old accepted batches remains a successful no-op while reusing either identity with another schema or slug conflicts. Delayed historical v1 and v2 evidence is accepted for offline convergence. Before upload, the plugin uses authenticated `/v1/time` sampling to surface local clocks more than 10 minutes ahead or behind; the service independently rejects evidence dated more than 10 minutes in the future. Timestamps are never silently rewritten, and aggregation clips intervals at current server time.

## `GET /v1/summary`

The summary response remains schema 1 regardless of the event schemas contributing evidence:

```json
{
  "schema_version": 1,
  "as_of": "2026-08-31T05:00:00.000Z",
  "daily": {
    "status": "UNDER",
    "worked_minutes": 60,
    "target_minutes": 480,
    "difference_minutes": 420
  },
  "weekly": {
    "status": "UNDER",
    "worked_minutes": 60,
    "target_minutes": 2400,
    "difference_minutes": 2340
  }
}
```

`difference_minutes` is the absolute difference from target: remaining when `UNDER`, zero when `COMPLETE`, and overage when `OVER`. A zero-target day with zero work is `COMPLETE`; work on a zero-target day is `OVER`. The fixed Asia/Jakarta timezone and Monday week boundary are server configuration rather than extra response fields.

For each random `(source_instance_id, session_id)`, a completed turn contributes `[start, end + 15 minutes)`. An unmatched start contributes at most 15 minutes. All endpoints are clipped at `as_of`; overlapping intervals from every source are unioned globally before overlap is calculated. The union is clipped at timezone-derived local day and Monday-week boundaries, including DST transitions in any IANA timezone supported by the generic aggregation module.

## Other errors

Malformed roots use `400 invalid_request`, oversized payloads use `413 payload_too_large`, unsupported media types use `415 unsupported_media_type`, and wrong methods use `405 method_not_allowed`. Unexpected failures use only `500 {"error":"internal_error"}`. No error response contains request bodies, credentials, identity claims, database details, or stack traces.
