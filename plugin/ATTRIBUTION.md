# Plugin attribution contract

The plugin remains v1-only until an authenticated `GET /v1/capabilities` returns response schema 1 with this shape:

```json
{
  "schema_version": 1,
  "accepted_event_schema_versions": [1, 2],
  "preferred_new_event_schema_version": 2
}
```

`accepted_event_schema_versions` is the service compatibility floor, while `preferred_new_event_schema_version` is the rollout switch. Before snapshotting the first turn in a plugin process, the plugin completes capability negotiation and, for a physical executor, its profile binding. The last successfully negotiated preference remains active during a transient refresh failure; a successful response preferring version 1 switches only future starts back to v1. Queued rows and durable in-progress turn snapshots are never rewritten. A 404 means the service has no attribution capability and keeps a v1-only plugin on its existing ingestion path. A queued v2 row is uploaded whenever the capability still declares v2 acceptance, independently of the preferred version.

Before enabling local v2 starts or replaying a local v2 row, the plugin performs the authenticated idempotent operation:

```http
PUT /v1/executor-profile
Content-Type: application/json

{"hostname":"<exact node:os hostname()>"}
```

The success response is `{"executor_label":"<same exact hostname>"}`. A mismatch or rejection leaves events pending and is surfaced as a protocol/authentication failure. Remote executors never read or send a hostname; their ADR-fixed plugin executor label is `amp-orb`.

Project Slugs come from the exact Amp Project selected for the executor. When `AMP_PROJECT_ID` is available, the plugin passes it to the supported `amp projects get <id> --json` boundary and requires the returned ID to match exactly. Physical runners that do not receive that variable ask Amp to match the current workspace with `amp projects status --json`; Cukup accepts only a single `matched` result whose canonical Project and match identities agree. Both paths normalize only the Project name returned by Amp. Successful resolution is cached for the plugin process; failed or ambiguous resolution is retried and remains visibly Unassigned. Cukup never derives attribution itself from a workspace path, package name, Git remote, or repository setting. The workspace lookup response and Project ID are never included in Cukup events or logs.

Outbox and turn-session SQLite rows remain authoritative for event schema and Project Slug replay; current binary constants and later Project renames never rewrite an existing turn snapshot.
