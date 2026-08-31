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

Project Slugs use only the `cukup.project-slug` Amp configuration key with the `workspace` target. The plugin does not inspect workspace roots, paths, Git configuration, or remotes. Outbox and turn-session SQLite rows are authoritative for event schema and Project Slug replay; current binary constants are not.
