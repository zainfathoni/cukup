# Personal dashboard and explicit attribution plan

## Outcome

Deliver a responsive personal dashboard at `https://cukup.dev` that remains available independently of Amp executor connectivity. It reports authoritative Jakarta daily/weekly Working Time, filterable Project Activity and Executor Activity, trends, freshness, and executor operational context without exposing prompts, Amp identifiers, workspace paths, Git remotes, source IDs, token IDs, or bearer values.

The dashboard is a new presentation and attribution phase. It does not change the definition of Working Time, targets, grace, crash caps, global interval union, timezone, week boundary, append-only evidence, or backup policy.

## Settled product contract

- The dashboard is personal and single-owner.
- `cukup.dev` serves the dashboard; `api.cukup.dev` remains ingestion-only.
- GitHub OAuth authorizes exactly one immutable GitHub numeric user ID.
- Existing sessions survive a temporary GitHub outage; new login fails closed.
- Dashboard sessions are encrypted Secure/HttpOnly/SameSite=Lax cookies with a seven-day lifetime, explicit logout, OAuth state, and PKCE.
- The unauthenticated site is a minimal sign-in page and reveals no Cukup data or operational state.
- Project Slugs are explicit, optional, lowercase kebab-case identifiers. Historical project-less work remains Unassigned.
- Physical Executor Labels are exact canonical Fleet hostnames; remote Amp executors use `amp-orb`.
- Overall Working Time is globally unioned and target-bearing. Filtered Project Activity and Executor Activity are targetless and intentionally non-additive.
- The dashboard is read-only in this phase. It does not rename history, edit targets, manage credentials, or delete evidence.
- No analytics or sensitive application logging is permitted.

## Wire and persistence changes

### Event schema v2

Continue accepting schema v1 unchanged. Add schema v2 with the same immutable event identity and timing fields plus optional `project_slug`.

Project Slug rules:

- canonical pattern: `[a-z0-9]+(?:-[a-z0-9]+)*`;
- maximum 64 characters;
- command input trims, lowercases, converts spaces/underscores to dashes, and collapses repeated dashes;
- unsupported punctuation is rejected rather than silently discarded;
- absent slug means Unassigned.

The plugin snapshots the workspace's slug at `agent.start`; its matching `agent.end` keeps the same value even if configuration changes during the turn. Existing outbox rows and deterministic legacy migration remain v1 and Unassigned.

Schema version and Project Slug are immutable row-level outbox data, never current-binary constants. Upgrade migration backfills every existing outbox and deterministic legacy row as v1 with no slug. A turn's schema and slug are stored with its durable start snapshot and reused by its end across restarts and plugin upgrades. A turn begun under v1 ends under v1. An orphan end without a durable start snapshot remains v1 and Unassigned rather than inventing attribution.

Event v1 and v2 remain separate closed schemas. Exact replay requires the original schema and immutable payload; reusing an identity with another schema or slug is a conflict. Event schema constants are separate from response contracts: `/v1/summary` remains response schema 1.

### Executor binding

Add an authenticated idempotent executor-profile operation for physical bearer principals. The plugin submits local `hostname()` before its first v2 upload. The service validates the exact value against its configured Fleet allowlist and binds it once to the Bearer Lineage. Exact repeats succeed; a different or unrecognized hostname fails visibly and leaves events pending. Only one active Bearer Lineage may hold a canonical Machine Label. Token rotation copies the label before atomically moving source ownership, and a rotation cannot rename it.

OIDC principals never send a hostname; the service assigns `amp-orb`.

Existing event rows are not rewritten. Source owner kind remains stable; bearer owner IDs may move only through atomic rotation. Dashboard queries derive historical Executor Labels by joining events through stable source ownership to the current Bearer Lineage label, or to `amp-orb` for OIDC ownership. Physical evidence from a lineage that never bound remains visible and filterable as `unassigned-executor`.

### SQLite migration

- permit event schema versions 1 and 2;
- add nullable `project_slug` to immutable event storage;
- add nullable, validated `executor_label` to physical credential storage;
- rebuild constrained SQLite tables transactionally where required and advance `user_version` monotonically without letting older startup code reset it;
- persist schema version and nullable Project Slug on every outbox row and durable turn-start snapshot;
- preserve received timestamps, replay/conflict behavior, source ownership, token hashes, rotation, and revocation;
- add indexes for bounded date, Project Slug, and executor attribution queries;
- keep all migrations restart-safe and covered by backup/restore tests.

## Plugin changes

Add `cukup: Set project slug`:

- unavailable when there is no Amp workspace;
- reads/writes only `cukup.project-slug` through Amp workspace-scoped configuration;
- previews normalized output before saving;
- provides an explicit confirmed Clear action that returns future work to Unassigned;
- never reads or persists `workspaceRoot`, paths, Git configuration, or remotes.

On local executors, validate and bind `hostname()` before v2 upload. On remote executors, rely on server-assigned `amp-orb`. Continue to reread physical token files and mint fresh workload OIDC per request cycle. Preserve the transactional outbox, partial delivery, restart/backoff, cache, and visible failure semantics.

Prove workspace configuration follows the same Amp workspace across a physical executor and a fresh orb before rollout.

## Dashboard service boundary

The existing Bun binary serves host-specific route sets:

- `api.cukup.dev`: current health and authenticated ingestion APIs;
- `cukup.dev`: sign-in, OAuth callback, logout, dashboard assets, and same-origin dashboard report API.

Reject unexpected Host values. Do not enable cross-origin browser access to ingestion routes. Dashboard filters use authenticated POST bodies so Project Slugs and Executor Labels do not enter URLs, browser history, proxy logs, or copied links. Date ranges may use URLs.

The report API accepts 7-, 30-, 90-, or custom ranges capped at 366 days and returns:

- overall daily/weekly target-bearing summary;
- globally unioned daily Working Time series;
- separately unioned Project Activity series;
- separately unioned Executor Activity series;
- current-day hourly timeline and concurrency markers;
- available Project Slugs and Executor Labels;
- executor latest activity (`occurred_at`), latest synchronization (`received_at`), and physical credential active/revoked state;
- authoritative `as_of` timestamp.

Absence of recent evidence is shown as last activity, not online/offline health. A filtered project or executor report has no UNDER/COMPLETE/OVER status.

Aggregation derives each session interval first using the existing grace, crash-cap, clipping, and timezone rules. A v2 end whose Project Slug differs from its durable start snapshot is rejected. Each interval receives that start snapshot and its source-derived Executor Label. The service unions intervals independently per Project Slug and Executor Label. Multi-select values within one filter are OR; project and executor filters combine with AND. A combined selection unions matching underlying intervals rather than adding displayed series. The unfiltered globally unioned target-bearing summary is always returned separately.

## Browser experience

Use semantic HTML, focused TypeScript, CSS, and accessible SVG generated by the existing service build. Do not add a frontend framework in this phase.

Information hierarchy:

1. Today and current-week cards.
2. Freshness and authoritative status.
3. Project and Executor filters.
4. Current-day hourly timeline.
5. Seven-to-90-day daily trend.
6. Executors panel.

Never stack Project or Executor series. Explain that concurrent series are non-additive and show textual equivalents for every chart. Use system light/dark themes, WCAG-AA contrast, keyboard-operable controls, visible focus, reduced-motion support, and responsive cards/filters with horizontally scrollable charts on small screens.

Poll every 30 seconds while the page is visible, pause in background tabs, and expose manual refresh. Preserve the last successful panel value with a stale timestamp on partial failure; never replace unavailable data with zero.

## Authentication and privacy

Create a dedicated GitHub OAuth application with callback `https://cukup.dev/auth/github/callback`. Keep client secret and session encryption material in 1Password and inject them through protected Kamal runtime secrets. Configure the immutable allowed GitHub user ID separately. Rotation requires no database migration.

Dispatch on the original Host before route matching or authentication:

| Host | Routes | Authentication |
| --- | --- | --- |
| `api.cukup.dev` | `/healthz`, `/v1/*` | workload OIDC or physical bearer as defined by each API route |
| `cukup.dev` | sign-in, OAuth callback, logout, assets, dashboard report | host-only dashboard session cookie |

Dashboard routes never accept bearer authorization, and ingestion routes never accept dashboard cookies. The session cookie uses a `__Host-` name with Secure, HttpOnly, Path `/`, SameSite=Lax, and no Domain attribute. Missing or invalid OAuth/dashboard configuration disables dashboard routes without blocking ingestion startup. The proxy terminates both names, preserves the original Host, and health-checks the API host.

Dashboard isolation means independently switchable routes and request/configuration failure containment inside one service process. It does not claim process-crash, OOM, or shared-SQLite isolation; existing health checks and restart policy cover those faults.

Logs contain only method, route template, status, duration, and generic internal error code. They exclude OAuth IDs, cookies, authorization data, Project Slugs, Executor Labels, filter bodies, report results, source/event/session IDs, and database details. Dashboard failures do not alter ingestion, summary, backup, or plugin behavior.

## Reviewable implementation sequence

1. **Domain and protocol:** accept ADR, glossary, schema-v2 types/validation, mixed replay tests, and privacy allowlists.
2. **Persistence and attribution:** restart-safe SQLite migration, executor binding, historical owner-derived attribution, query indexes, rotation/revocation behavior, and backup/restore coverage.
3. **Plugin:** workspace Project Slug command, turn-start snapshot, v2 outbox records, hostname binding, OIDC `amp-orb`, and cross-executor configuration canary.
4. **Dashboard backend:** host boundaries, report query model, OAuth/session/logout, generic errors, and redacted logging.
5. **Dashboard UI:** responsive cards, filters, charts, stale states, polling, and accessibility.
6. **Operations:** OAuth secret custody, hostname allowlist, dual-host Kamal/TLS configuration, runbook, backup rehearsal, and rollback switches.

Keep behavior-preserving migrations separate from behavior enablement where review would otherwise mix invariants.

## Rollout and rollback

1. Verify a pre-migration backup and clean restore.
2. Deploy the backward-compatible service/database migration with dashboard and v2 emission disabled.
3. Configure the Fleet hostname allowlist and protected OAuth/session inputs.
4. Publish the v2 plugin with v2 emission still switchable.
5. Canary one fresh orb and one physical machine, including workspace Project Slug persistence.
6. Roll out remaining physical machines and verify hostname binding.
7. Create/cut over `cukup.dev` DNS and TLS, then enable the dashboard.
8. Run browser, OAuth, privacy, accessibility, polling, and mixed-version canaries.
9. Take, pull, verify, and clean-restore a post-migration backup.

Dashboard and future-turn v2 emission have independent feature switches. Once any v2 event is emitted, the migration-aware mixed-v1/v2 service is the permanent compatibility floor because offline executors may retain v2 rows indefinitely.

Rollback order:

1. Disable dashboard routes.
2. If attribution fails, switch only future turn starts to v1. Never rewrite queued or in-progress v2 events.
3. Keep mixed-v1/v2 ingestion deployed until every delayed event can converge; never roll back to the current v1-only service or a plugin that derives queued schema from its binary.
4. Roll service code back only to a tested migration-aware build. Verify ingestion, summary, token rotation, restart, delayed v2 upload, and re-upgrade against the post-migration database.

Do not restore SQLite unless data corruption is proven.

## Acceptance gate

- Existing v1 replay and mixed v1/v2 convergence pass.
- Interrupted deletion followed by v1 replay from an upgraded outbox remains duplicate, never conflict.
- Schema/slug turn snapshots survive restart, configuration change, and plugin upgrade; orphan ends remain v1/Unassigned.
- Project Slug and Executor Label payload/storage/log privacy audits pass.
- Concurrent project/executor aggregation and targetless filter semantics pass.
- Hostname allowlist, duplicate-label rejection, binding mismatch, OIDC `amp-orb`, atomic labeled rotation, `unassigned-executor`, and historical attribution pass.
- GitHub OAuth owner allowlist, state/PKCE, session, logout, expiry, CSRF, and outage behavior pass.
- Host-first route/auth matrix, host-only cookie, disabled-dashboard startup, and dashboard/ingestion credential separation pass.
- Responsive keyboard navigation, chart text equivalents, reduced motion, light/dark theme, and WCAG-AA checks pass.
- Browser tests cover filters, stale data, partial failure, logout, polling visibility, and no sensitive URL state.
- A physical executor and fresh orb share a workspace Project Slug without path disclosure.
- Dashboard remains available without an Amp executor and its failure does not affect ingestion.
- Existing Cukup status command, offline outbox, and ingestion performance do not regress.
- The designated migration-aware rollback build operates the post-migration database across ingestion, summary, rotation, restart, delayed offline v2 convergence, and re-upgrade.
- Pre- and post-migration backup, off-site pull, verification, and clean restore pass.
