# Stage 5X: closed owner project and mapping controls

This is a documentation-only HTTP design for [Stage 5V](stage-5v-project-attribution-contract.md)
and [Stage 5W](stage-5w-amp-project-capture-contract.md), under [ADR 0007](adr/0007-generic-harness-evidence-boundary.md).
**Do not implement or mount these endpoints until the Stage 5S commit-authority, trusted-time,
and recovery dependencies below exist and pass review.** No project or mapping is approved here.
Stage 5W has no eligible Amp native source; Stage 5P stays blocked and Unassigned. An explicit
binding also needs a reviewed real launch/session lifecycle, not an owner-entered text override.

## Existing behavior is evidence, not an owner-write primitive

- [DashboardAuth](../service/dashboard/auth.ts) checks GitHub's numeric immutable user ID against
  `allowedGithubUserId`, uses OAuth state/PKCE, and seals a hostname/purpose-bound encrypted session.
  Its `__Host-cukup_session` cookie is Secure, HttpOnly, Path=/, SameSite=Lax, with seven-day lifetime
  and key-ring verification. Duplicate session cookies reject. Login names and email are not owners.
- [DashboardBackend](../service/dashboard/backend.ts) authenticates reports before body reads, but
  its origin helper permits missing browser headers and its parser uses `request.text()/JSON.parse`.
  Neither is the stricter owner-control CSRF/streaming/duplicate-key contract below. Session validity
  alone supplies no commit-time authorization version, revocation fence or trusted clock.
- [Service routing](../service/app.ts) separates configured dashboard/API hosts and authenticates
  `/v1/` with bearer or OIDC. Fixed `{error: ...}` responses, no-store and nosniff are useful
  conventions; that principal union, host/proxy handling and generic exception path are not owner
  approval. [Token-admin](../service/token-admin.ts) opens a write-capable store directly, issues,
  rotates and revokes ingestion credentials, and prints credentials/metadata. Filesystem access,
  token possession, token issuance, executor binding and CLI invocation cannot authorize these writes.
- Preserve [legacy project parsing](../plugin/project.ts), [service event/principal types](../service/types.ts),
  [generic attribution](../service/harness-evidence-protocol.ts) and [dashboard report schema 2](../service/dashboard/report.ts)
  unchanged. No new `Principal` variant, report field, generic proof field or extracted unused auth helper.

## One owner origin, two data boundaries

All paths below are exact POST-only paths on the independently configured canonical HTTPS dashboard
origin, under a **dedicated restricted owner-control handler**, not `/dashboard/report` or generic
`/v1/` ingestion. POST reads keep identifiers out of URLs and require the same CSRF checks as writes.
There are no query parameters, trailing-slash aliases, redirects, GET/HEAD reads, CORS or OPTIONS
preflight grants. Unknown paths return 404. The generic API hostname, arbitrary Host, wrong origin
or insecure transport cannot reach owner state. Pin proxy trust and the external origin independently;
never select an account, backend, witness, site or redirect from request headers/body/URL values.

The handler authenticates the existing GitHub owner session. Its immutable GitHub subject must
resolve through a separately provisioned, version-fenced binding to exactly one Cukup account and
owner actor. No request accepts account, actor, authorization revision or credential fields. Reject
any Authorization header, even beside a valid cookie; physical bearer, workload OIDC and token-admin
are never fallback authentication. Do not forward session cookies or GitHub tokens to a collector.

Project registry data belongs to the service's Stage 5S all-mutator recovery frontier. Mapping
records/selectors belong only to the restricted collection-boundary authority of Stage 5V/5W.
The same-origin restricted handler may relay authenticated, audience-bound owner decisions over a
separately pinned isolated authority channel; the generic service must not persist, inspect for
reporting, or log those bodies. This is not authorization for cross-host collection. Channel
authentication, request binding and revocation fencing must be reviewed before mounting it.

`selector_ref` below is a pre-existing immutable random reference, obtained only in an independently
reviewed restricted owner selection flow. It resolves to exactly one verified account/site/Harness/
adapter context and either a native context or actual launch/session. It is **not a capability**:
owner authorization and source eligibility are rechecked. There is no selector import, creation,
discovery or name-search endpoint here; no native ID, fingerprint, path, remote, JWT, raw proof or
free-text selector is ever accepted. Unsupported source or ended explicit scope cannot be approved.
The flow must show the exact trusted context and selected project to the owner; possession of a
reference or pressing an unrelated dashboard button is not approval. Its absence blocks mapping
implementation, not permission to guess a selector from existing Amp status.

Owner-control JSON is restricted security data, not a public dashboard/report schema. It may carry
the listed random project/mapping/selector/operation references only within this handler and its
authorized private client. Never put them in generic reports, public JSON, DOM attributes/tooltips,
URLs, analytics, access logs or review artifacts. A future private client keeps references in
memory, renders only approved labels/fixed categories, and clears rendered state and cached read
results on denial; no browser persistent cache. Unresolved mutation intents are not read caches:
the exact operation ID and canonical request must be recoverable across denial, page loss and
reauthentication before a request can be sent. A separately reviewed privacy-preserving retention
and authenticated recovery mechanism outside browser-persistent caching is an implementation gate;
this slice supplies no storage or recovery endpoint for it. It must retain only closed owner intents
under restricted access, not native keys/proofs, and cannot expose them during denial. Native
selectors and all proof/history objects remain at the restricted authority.

## Authentication, CSRF and decoding order

The following order is normative on the owner prefix; transport-level byte/header limits may
terminate a connection earlier but may not reveal state. No body read or project/mapping/operation
lookup precedes auth. Cookie headers are bounded to 16384 bytes and the encrypted session value to
4096 bytes, with the existing duplicate-session-cookie rejection and authenticated cookie checks.

1. Enforce pinned host/HTTPS and route isolation (404 on mismatch, no redirect).
2. Validate the one bounded session cookie, current allowed immutable GitHub subject, expiry and
   current owner binding. Missing/invalid/expired/revoked/non-owner session or any Authorization
   header yields 401 `unauthorized`, including retries and malformed/oversized bodies. An unavailable
   authorization provider yields 503 `unavailable`, never a cached allow. No OAuth redirect here.
3. Require exactly `Origin: https://<configured-host>` and `Sec-Fetch-Site: same-origin`. Missing,
   duplicate, combined, `null`, same-site, cross-site or other values yield 403 `forbidden` before
   body consumption. The origin has no path or trailing slash; proxy/caller Host is not its source.
   Reject cross-origin even with a valid cookie. SameSite alone and the existing logout/report
   helper are insufficient. No extra CSRF token is needed with these mandatory browser headers
   and non-simple JSON requests; XSS remains outside the CSRF guarantee.
4. Exact path/method/query checks: unknown path 404; known path wrong method 405 with `Allow: POST`;
   any query 400. Then media/framing checks, streaming byte bound, syntax and closed shape checks.
5. Obtain a fresh verified authority view, reauthorize, then perform successful-operation lookup
   before expected-revision, current transition, capacity or mutation-time checks. Revalidate auth
   again at commit and response release. Reads use the release fences below without writing.

Requests require `application/json`, optionally only `charset=utf-8` (case-insensitive media/charset,
optional whitespace and quoted charset). Any Content-Encoding, additional media parameter or other
type yields 415. At most 4096 body bytes, measured while streaming even with no Content-Length;
cancel at byte 4097 (413), never buffer an unlimited body. If present, Content-Length is one
canonical unsigned decimal value; invalid/duplicate/conflicting framing rejects 400 at ingress,
advertised length above 4096 rejects 413, actual mismatch rejects 400. Bound body receipt to 10
seconds, timeout 408. The runtime/proxy must preserve or reject ambiguous headers before coalescing.

Decode strict UTF-8 JSON: no BOM, malformed UTF-8, trailing data, duplicate keys at any depth
(including escaped-equivalent names), lone surrogate, unknown field or missing field. Detect
duplicates before a lossy object parser. Root is an object; nesting at most two containers; requests
have only the scalar fields listed below. No arrays, coercion, normalization, trimming or extension
bags. Numeric tokens must be canonical nonnegative decimal integers (no -0, fraction or exponent).
`version` must be 1: a well-formed positive integer other than 1 gets 400 `unsupported_version`;
malformed/absent version or other invalid syntax gets 400 `invalid_request`. Validate syntax and
duplicate keys before version dispatch; a future version is never decoded as version 1.

`Ref` is exactly a lowercase UUIDv4 with RFC variant (`[89ab]` in the variant nibble), 36 ASCII
bytes; compare exact bytes. Operation IDs are generated by the owner client using secure randomness;
project/mapping IDs are generated by the committing authority, never derived from the operation
or labels. `Revision` is an integer 0..9007199254740991. Overflow blocks new mutation, never wraps.
`Label` is null or 1..64 ASCII bytes matching `[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,62}[A-Za-z0-9])?`.
Labels are exact presentation values, nonunique and never identity keys. Create/rename requires
`disclose_label: true`, including null: explicit consent to future safe display, not implicit import
of a native name. Do not auto-copy native names or accept paths/remotes/body text as labels. Syntax
cannot detect secrets encoded in allowed text; reviewed UI/source policy and explicit owner choice
are required, not a claim of malicious-input containment. Null renders a fixed display-only fallback;
collisions do not merge projects. No slug field or native-name synchronization API is added.

## Exact version-1 requests and responses

Every request has `version:1` plus **exactly** the fields in the table. All mutations additionally
have `operation_id:Ref`. Success responses have `version:1` plus exactly the stated fields. All successes,
including creation and exact replay, are HTTP 200; no 201/204, Location, replay flag or receipt time.

`ProjectView` is exactly `{project_id:Ref, revision:Revision, state:"active"|"archived",
label:Label, label_revision:Revision}`. Lifecycle and label revisions start at 0. Archive increments
lifecycle revision once; rename increments label revision once and never lifecycle/mapping revisions.
Labels remain separate presentation state. Mutations return the complete original committed view,
not a current-state overlay. `MappingView` is exactly `{mapping_id:Ref, revision:Revision,
state:"approved"|"revoked", project_id:Ref}`; selectors/site/Harness and proofs are not returned.

| Exact path after `/owner/v1/` | Additional request fields (besides common fields) | Success fields |
| --- | --- | --- |
| `projects/create` | `expected_revision:0, label:Label, disclose_label:true` | `operation_id, project:ProjectView` |
| `projects/list` | none (read, no operation ID) | `projects:ProjectView[]` |
| `projects/read` | `project_id:Ref` (read, no operation ID) | `project:ProjectView` |
| `projects/archive` | `project_id:Ref, expected_revision:Revision` | `operation_id, project:ProjectView` |
| `projects/rename` | `project_id:Ref, expected_revision:Revision, expected_label_revision:Revision, label:Label, disclose_label:true` | `operation_id, project:ProjectView` |
| `mappings/approve` | `expected_revision:0, selector_ref:Ref, project_id:Ref, expected_project_revision:Revision` | `operation_id, mapping:MappingView` |
| `mappings/revise` | `mapping_id:Ref, expected_revision:Revision, project_id:Ref, expected_project_revision:Revision` | `operation_id, mapping:MappingView` |
| `mappings/revoke` | `mapping_id:Ref, expected_revision:Revision` | `operation_id, mapping:MappingView` |
| `mappings/read` | `mapping_id:Ref` (read, no operation ID) | `mapping:MappingView` |

Create's expected 0 means a new server-allocated identity, not an account-list revision. Approve
likewise creates a new mapping at revision 0; it does not update an existing selector's mapping.
Overlapping approvals remain allowed and may cause Stage 5V ambiguity even with identical targets.
No mapping-list/selector-read/history/operation-status endpoint is added. Resolve an uncertain
mutation by resending the same original mutation, not by reading current project/mapping state.

List returns every account project, including archived, in ascending exact project UUID order from
one fresh snapshot. Version 1 caps retained projects at 256 per account (including tombstones), so
there is no pagination, filtering or silent truncation. Create at capacity fails; reads and exact
retries still work. Raising this bound needs a reviewed version change, not deleting old projects.
Response serialization is bounded to 131072 UTF-8 bytes, canonical RFC 8785 JSON; response-shape,
bound or persisted-label violations yield unavailable, not partial/truncated output.

Archive is terminal; no delete, unarchive, transfer, reuse, merge or split. A new archive of an
archived project conflicts. Rename is allowed only while active; identical-label new rename is a
transition conflict rather than a gratuitous revision. Approve/revise must target an existing active
project owned by this account at its exact expected lifecycle revision. Revise changes only target,
requires a different target, increments mapping revision, and cannot change the immutable selector.
Revoke increments mapping revision and retains its last target; revoked is terminal. Revoke remains
allowed when that target is archived or selector ended/ineligible: it does not require a current
active target, target revision or source-eligibility gate. None of these writes chooses a date.

## Idempotency, linearization and refusal gates

Successful IDs reserve one immutable canonical request and outcome for the account lifetime,
across all nine paths (reads never reserve). Equality is RFC 8785 canonical validated content plus
exact operation kind/path and server-bound immutable account/actor; compare content, not only a
digest. Key order/JSON whitespace/valid string escaping do not change equality. Cookie/session
renewal for the same actor does not change it; current auth revision is checked, not a request term.
Generated IDs and original result are retained atomically. No TTL, alias ID or eviction. A changed
request/kind under a successful ID gets 409 `operation_conflict`, before stale revision checks.
An exact retry returns the historical result after current authorization and recovery validation,
even after archive/revoke/rename, at capacity or with mutation clock trust lost. It is not a fresh
approval. No convergent-success exception from Stage 5S's accounting activators applies here.

New operations compare every named expected revision at commit. Stale revision gets 409
`revision_conflict`; current revision but forbidden transition gets 409 `transition_conflict`.
Unknown and other-account IDs/selectors both get 404 `not_found`; never disclose which or return
the other account's revision. Perform ownership checks before revision comparisons. Definitively
rejected attempts reserve no ID and may be retried with full validation. Once possibly sent, retain
the exact ID/request until resolved; do not replace it after a timeout, disconnect, 401, 500 or 503.
In particular, 401 is not proof of non-commit: authorization may have been lost after commit but
before response release. If the original unresolved intent cannot be recovered after reauthentication,
suspend that workflow. Current-state reads, missing UI state and replacement operation IDs cannot
resolve it; no second approval is allowed as a recovery shortcut.

All writes, including labels, need a fresh fenced commit with current owner authorization, compatible
versions and actual trusted monotone commit TimeProof per Stage 5S. One order must serialize project
lifecycle, mapping decisions and captures; project archive cannot race a stale positive capture.
The **service registry and restricted mapping authority must participate in an equivalent atomic
serialization/fencing protocol without copying selector/proof data into service control records**.
An HTTP registry lookup followed by a local mapping commit is not that protocol. This cross-boundary
commit interface and its partitioned recovery codec are explicit blockers; this document invents
neither DDL nor a two-write transaction adapter. Labels need not invalidate approval, but their
accepted writes still join the service all-mutator frontier.

Before acknowledgment: retain finalized request/result/history and trusted commit proof under the
independent fresh rollback-resistant journal; atomically commit authorization/head/writer/expected
revision guards; durably project the exact committed state and verify its digest. Revocation of
owner access must be serialized with commits and response release, not merely remove a cookie or
change an environment variable. Read/list release linearizes at a fresh head with the verified
projection and current authorization; no stale/replica/cached result or mixed revision may escape.
If a newer head wins before release, reconcile and reread. Mutation/retry results remain historical,
but release still checks fresh head, recovery integrity and current owner authorization. A denial
after commit blocks success disclosure, not the committed decision. No read creates an operation,
approval, time proof or journal revision. Authentication time and witness freshness must still be
verifiable for reads/retries; absence of mutation-time trust alone need not prevent them.

Unknown commit outcome is 503 `indeterminate`; never declare rollback. Same-request retry resolves
the original operation with a fresh journal read. A missing entry alone is not proof of non-commit:
the serialized resolver must fence pending/delayed attempts before returning a definitive rejection
or re-evaluating the original request. No new endpoint or operation ID bypasses this fence. Journal
commit followed by failed projection stays committed and indeterminate to the caller until exact
recovery; no success on staging, local-only write or best-effort checkpoint. Capacity/retryable
failure is `unavailable` only when non-commit is proven; otherwise `indeterminate`.

Refuse implementation until **all** of the following are implemented and rehearsed elsewhere:

1. Stage 5S's authenticated linearizable external journal, non-reusable account/lineage registration,
   fenced writers, finalized recoverable commit and service all-mutator participation (including
   credential/admin/ownership/configuration writes), not SQLite/WAL or a second backup file.
2. Versioned owner binding, session denial/key-policy fencing, isolated owner-to-authority channel,
   selector selection/verification, recoverable private client mutation intents across denial and
   reauthentication, and cross-boundary registry/mapping/capture serialization.
3. Pinned trusted clock/uncertainty/freshness policy with proof at actual commit, not `Date.now()`,
   HTTP Date, OAuth expiry, client timestamps or `precision_ms`. Loss blocks all new owner writes,
   including revoke/archive: do not promise offline revocation or weaken assigned-capture freshness.
4. Complete retained history/operations/capture results, encrypted restricted recovery content and
   keys, high-water marks and tombstones, genesis-to-head recovery, compatible reader/writer floors,
   and Stage 5W lost-ack/no-commit fencing. No history eviction or destructive rotation in version 1.

Before a write-capable store, migration or endpoint activation, read versions/floors and independent
registration read-only, validate fresh head and full state digest, then recover any proven ancestor
through the exact suffix. Future format/schema/floor, unknown key, missing witness/content, divergent
digest, wrong lineage or local-ahead state is unavailable/quarantined. No automatic initialize,
empty-list fallback, downgrade, regenerated IDs, reset revisions, resurrection or partial read.
Missing deployment dependencies return unavailable if an owner handler is ever mounted; today no
handler exists. Stage 5S accounting records/operation kinds are not extended by this HTTP contract.

## Closed failure and header policy

All failures have exactly `{error:CODE}` (no version or message), consistent with service conventions:

| Status | CODE |
| --- | --- |
| 400 | `invalid_request`, `unsupported_version` |
| 401 | `unauthorized` |
| 403 | `forbidden` |
| 404 | `not_found` |
| 405 | `method_not_allowed` |
| 408 | `request_timeout` |
| 409 | `operation_conflict`, `revision_conflict`, `transition_conflict` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 503 | `unavailable`, `indeterminate` |

Trust/freshness/source-eligibility/capacity/recovery failures expose only `unavailable`, not internal
reason, existing revision, selector, timing, stack or retry deadline. A possibly committed exception
must be indeterminate; an unexpected exception with proven non-commit is unavailable. Clients treat
unrecognized statuses/bodies, intermediary failures and malformed responses as unknown outcomes,
never permission for a replacement mutation. Unsupported stored versions yield 503, not the request
version error. No partial list, zero-data substitute, stale-success marker or retry auto-resubmission.

Every handler response, including host/auth/CSRF/failure responses, has JSON UTF-8 Content-Type,
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Resource-Policy: same-origin`, `Content-Security-Policy: default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
and `Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=()`.
Do not emit ETag, Last-Modified, 304, CORS grants, WWW-Authenticate: Bearer, session-refresh cookies,
Location or payload-derived headers. Keep existing login/logout behavior separate. Ingress must
enforce the same privacy for its own rejections; log only fixed owner-control/outcome categories,
never raw URLs, IDs, bodies, cookies, claims, proofs, labels, source errors or per-request timing.

## Asymmetric future acceptance vectors

These are conformance requirements, **not executed runtime tests**. Use synthetic distinct accounts
A/B, sites X/Y, projects P/Q and mappings M/N with real distinct UUIDv4 fixtures; two processes and
independent fault-injected journals/clocks. Inspect exact canonical state/results, not only counts.

| Input / race | Independent expected result |
| --- | --- |
| Allowed immutable GitHub ID after username rename versus different ID with old username | First authenticates; second 401. Bearer/OIDC/token-admin cannot approve, even with matching project membership. |
| Missing session with 4097-byte malformed body versus valid session with that body | First 401 without reading it; second 413 after mandatory same-origin checks. Duplicate cookie rejects. |
| Valid cookie: exact Origin + same-origin versus missing Origin, `null`, same-site or different port | Only first passes. Others 403 without reading body; report/logout's permissive helper is not reused. |
| 4096 bytes padded valid request versus 4097; duplicate `label`/`\u006cabel`; version 2 versus future persisted state | Bounded first may succeed; second 413; duplicate 400; future request 400 unsupported_version; future state 503 before migration. |
| Lowercase UUIDv4 versus uppercase; revision 0 versus -0/1e0; 64-byte label versus 65 | First spelling/number/bound valid; alternatives reject, never normalize. No path/remote/native-name auto-import. |
| Create P, lost acknowledgment, same operation reordered JSON; same ID changed label | Exactly original P/revision 0 once; changed request operation_conflict. No second UUID on retry. |
| A reads/approves B's Q versus nonexistent Q | Identical 404; no leaked revision. Label collision between A's P/Q leaves two distinct project lanes. |
| Two renames expected lifecycle 0/label 0 with different labels | One label revision 1, loser revision_conflict; lifecycle stays 0. Rename first then archive expected lifecycle 0 may both succeed. |
| Archive first then rename with old lifecycle; exact old rename retry after archive | New rename conflicts; retry returns original rename result, not current archived overlay. Read returns archived. |
| M→P and N→P for identical selector versus M→P alone | Two distinct mapping approvals remain ambiguous under Stage 5V; one may select P. Approval never implicitly supersedes M. |
| Revise M→Q races archive Q; capture races archive P | Serialized winner determines admissibility: archive-first blocks new approval/capture; earlier committed capture P survives delivery after archive. No stale registry lookup assignment. |
| Revoke M after P archived/explicit scope ended versus revise M to archived P | Revoke can commit with current mapping revision/time; revision to archived P conflicts. Revoke retry returns original target, never deletes history. |
| Revoke first, new revise; revise first, stale revoke | Terminal revoke forbids revision; stale revoke revision_conflict and requires deliberate new operation after reread. |
| Native selector that passes Stage 5W spelling versus separately verified explicit launch | Native still unavailable with today's empty eligible-source set; explicit is possible only after its independent lifecycle gates. |
| Owner denial wins before CAS versus after CAS before release, followed by clearing read state and reauthentication/page reload | First no commit; second retained commit with 401. Recover original private intent, then authorized exact retry returns that approval once, no second mapping. Missing intent suspends the workflow; no secret success body or pending intent disclosed during denial. |
| Trusted clock lost during upload before commit versus after committed operation | New operation unavailable/non-commit or indeterminate if not proven; authorized intact historical retry can return original result without new time. |
| Crash before journal CAS versus after CAS before SQLite projection | First no committed state; second recover exact committed request/result before acknowledgment. Fresh missing lookup cannot outrun a delayed commit. |
| Backup head 7 before revoke/archive at 8/9, fresh witness 9; same sequence different digest | Replay exact suffix through 9 or unavailable; divergent same-head state quarantines. No resurrection/empty list. |
| List snapshot P active while archive commits before release | Reconcile and return archived P or unavailable, never stale success; operation retry still returns its historical result. |
| 256 retained projects versus 255; operation counter at ceiling | New creation only below capacity; reads/retries preserve every tombstone and original result. No eviction or wrap. |
| Sentinel selector/proof/path in unknown field or response/log/public DOM | Reject without raw diagnostics; no selector/proof appears in generic APIs/reports; legacy and generic evidence bytes unchanged. |

## Scope and publication

Only this document and ROADMAP change. Neither matches the main-push
[service publication workflow](../.github/workflows/publish-service.yml); this slice is publication-
neutral, while cumulative prerequisite service-image/schema/rollback implications remain unchanged.
No TypeScript, DDL/schema, routes, runtime, config, workflow, registry/mapping mutation, shared-state
access, production access, push, publication, deployment or activation is authorized or performed.
Stage 5Q no-backfill, Stage 5R accounting/target fences and Stage 5P's OIDC blocker remain unchanged.
Safe report-display integration, owner UI/selector selection, backend/crypto/storage implementation,
collector capture, clock/recovery infrastructure and actual rollout are separate gated slices.
