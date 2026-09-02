# Plugin attribution contract

The plugin remains v1-only until an authenticated `GET /v1/capabilities` returns response schema 1 with this shape:

```json
{
  "schema_version": 1,
  "accepted_event_schema_versions": [1, 2],
  "preferred_new_event_schema_version": 2
}
```

`accepted_event_schema_versions` is the service compatibility floor, while `preferred_new_event_schema_version` is the rollout switch. The plugin enables only future v2 turn starts when v2 is accepted and the preferred new-event version is 2. Returning preferred version 1 switches only future starts back to v1; queued rows and durable in-progress turn snapshots are never rewritten. A 404 means the service has no attribution capability and keeps a v1-only plugin on its existing ingestion path. A queued v2 row is uploaded whenever the capability still declares v2 acceptance, independently of the preferred version.

Before enabling local v2 starts or replaying a local v2 row, the plugin performs the authenticated idempotent operation:

```http
PUT /v1/executor-profile
Content-Type: application/json

{"hostname":"<exact node:os hostname()>"}
```

The success response is `{"executor_label":"<same exact hostname>"}`. A mismatch or rejection leaves events pending and is surfaced as a protocol/authentication failure. Remote executors never read or send a hostname; their ADR-fixed plugin executor label is `amp-orb`.

Project Slugs come from the exact Amp Project selected for the executor. The plugin passes the immutable `AMP_PROJECT_ID` to the supported `amp projects get <id> --json` boundary, requires the returned ID to match exactly, and normalizes only that Project's name. Successful resolution is cached for the plugin process; failed resolution is retried and remains visibly Unassigned rather than falling back to a workspace path, package name, Git remote, or repository setting. The project ID is never included in Cukup events or logs.

Outbox and turn-session SQLite rows remain authoritative for event schema and Project Slug replay; current binary constants and later Project renames never rewrite an existing turn snapshot.
