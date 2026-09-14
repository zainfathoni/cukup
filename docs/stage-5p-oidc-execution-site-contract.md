# Stage 5P: workload OIDC execution-site contract

This is a **documentation-only design contract, blocked on external identity support**, not an
OIDC ingestion implementation or support claim. [ADR 0007](adr/0007-generic-harness-evidence-boundary.md)
requires evidence collection at its actual authenticated execution site. [Stage 5A](stage-5a-shadow-persistence.md),
[Stage 5B](stage-5b-shadow-ingestion-api.md), and [Stage 5H](stage-5h-shadow-coverage-persistence.md)
remain the evidence, physical authentication, and coverage authorities. [Stage 5J](stage-5j-shadow-synchronization-contract.md)
remains physical-only. Deployed legacy OIDC behavior is unchanged.

## Confirmed Amp capabilities do not settle incarnation identity

Authoritative sources checked on 2026-09-14:

- [Amp Handling Secrets](https://ampcode.com/docs/orbs/handling-secrets), OIDC sections: RS256,
  issuer `https://ampcode.com/api/workload-identity`, HTTPS discovery/JWKS, standard `iss`, `aud`,
  `sub`, `iat`, `exp`, `jti`; exchanged tokens have `token_use=exchanged`. Default lifetime is ten
  minutes; requested lifetime is 60–3600 seconds. Audience is caller-selectable, not authorization.
- The same source documents `user_id` as the thread creator, optional `workspace_id` and `project_id`,
  `thread_id` as “The thread and orb identity,” and email claims. Default thread-scoped subjects
  include workspace/project layers when available, followed by user/thread layers. Broader subject
  scopes can be minted and are not one-site identities. Custom claims survive subject-scope changes.
- [Amp Orbs](https://ampcode.com/docs/orbs) promises files and services survive pause/resume and
  describes a fresh isolated environment for each orb thread. Handling Secrets separately describes
  snapshot setup credentials, their removal, and fresh runtime credentials before resume.
- Handling Secrets explicitly warns that workspace-scoped token minting can continue after membership
  removal until the request credential expires, up to 24 hours. Project-scoped minting checks current
  project access. Neither statement establishes immediate revocation of already minted JWTs.

**Missing guarantee:** these sources do not specify an attested orb-incarnation identifier with
stability across token renewal, process restart, pause/resume, and same-orb restart, and guaranteed
non-reuse on recreation, cloning, snapshot restoration into a different orb, or replacement within
the same thread. Calling `thread_id` an orb identity is not that lifecycle contract. This is an
absence of a documented guarantee, not proof that Amp cannot supply one. No live token was minted,
decoded, stored, or used as experimental evidence for such a guarantee.

Neither `sub`, `thread_id`, user/project/workspace IDs, `jti`, token bytes, timestamps, hostname,
environment variables, nor a collector-generated UUID can establish the required site alone.
Hashing a thread ID does not fix its unspecified recreation semantics; hashing a JWT creates a new
site on renewal. A file copied with a snapshot cannot attest where it is running. **Current documented
tokens are insufficient for this contract. Keep generic OIDC ingestion disabled.**

## Minimum external contract before implementation

Amp must document and attest an execution incarnation, bound to the verified issuer and creator user,
through a signed token claim or an equally authenticated, token-bound platform assertion. This names a
required capability, **not a proposed or existing JWT claim name**. A future review must pin the exact
schema, verification protocol, lifecycle tests, and access/revocation guarantees before writing the
ingestion slice. No environment-variable or caller-payload substitute is permitted.

The platform-owned handle must be opaque, non-caller-selectable, unique and never recycled within
the issuer, and preferably pairwise to the Cukup audience to reduce correlation. It must:

1. Stay identical on token renewal, process/plugin/service restart, pause/resume, and restart of the
   same retained execution environment; changes in `iat`, `exp`, `jti`, or signing key do not matter.
2. Change on deliberate recreation/replacement, a clone, or restoration as a different environment,
   even with identical files, thread, project, and user. A restored same environment may retain it
   only if Amp guarantees there cannot be another active environment with that identity.
3. Be minted only for the actual execution environment using platform-controlled credentials, with
   an immutable creator-user binding. A different user must not inherit the old handle. Thread/project
   access alone must not allow requesting another site's handle.
4. Define what happens when the environment or access is revoked, including the maximum stale-token
   authorization window. A copied bearer JWT remains a bearer credential; this is not proof of
   physical presence on every HTTP request or containment of a malicious collector.

Cukup authentication resolves that verified handle to an independent **server-generated random
UUIDv4 execution-site ID**. It does not cast a platform handle into the evidence schema. A durable,
atomic, unique authentication mapping uses a versioned domain-separated keyed fingerprint of
issuer and handle; a separately domain-separated creator fingerprint enforces immutable owner binding.
Use unambiguous length-delimited encoding, not concatenation. The mapping contains only fingerprints,
key version, opaque site UUID, and closed authorization state; no raw claims, subject, or platform
handle. It belongs to restricted authentication state, never generic evidence or report storage.
Fingerprints are pseudonymous sensitive data, not anonymous data and not public labels.

Authentication mapping creation and the first successful fact/collector binding must commit together;
rejected bodies and duplicate requests cannot allocate unused identities. Concurrent first submissions
for one incarnation resolve one site, not two. Generic persistence receives only the site UUID.
The future owning slice must specify atomic local authorization revalidation at commit and prevent
an earlier revocation from being bypassed by an in-flight request. No storage schema is defined here.

Keep lookup keys and mappings durable across service restart and backup restoration. Key rotation
must resolve existing fingerprints to the original UUID before creating aliases; retain the ability
to resolve old mappings until safely migrated. Key/mapping loss or ambiguous matches disables OIDC
shadow acceptance; never silently create replacement sites. Backup recovery must preserve accepted
facts and their authentication bindings consistently. Exact key storage, rotation tooling, migration,
retention, and disaster recovery are implementation gates, not permission to add them in Stage 5P.

## Authentication consumes claims; evidence does not

Future generic authentication requires a signature verified with the configured Amp issuer's keys,
RS256 only, exact issuer, and exact single audience `https://cukup.dev`. Reject other or multiple
audiences, wrong token use, absent/invalid required claims, invalid signature, expiry, or an identity
outside Cukup's configured allowed user. Do not use email for authorization. Discovery must match the
configured issuer; token-provided key URLs cannot select a trust root.

Require the default thread-scoped `sub` and check exact consistency with the verified `user_id`,
`thread_id`, and present workspace/project layers under Amp's documented subject grammar. Missing
optional workspace/project claims are valid for documented personal/no-project contexts; missing
user/thread is not. Reject broader scopes even if their custom claims contain thread identity; setup
tokens must not enroll a generic site. Do not guess undocumented subject variants. Workspace/project
changes alter subject validation inputs, not site identity; once authorized and consistently attested,
the same incarnation/user still resolves the same site. Changed creator for a known handle fails closed.

Allowlisted authentication inputs are only the above identity/verification claims, the future reviewed
incarnation assertion, and standard temporal/header fields needed to verify them. Bound token size and
types before use. Require finite integer `iat`/`exp`, `iat <= now < exp`, and positive lifetime no more
than 3600 seconds; validate `nbf` if present, with no positive clock leeway. A trusted service clock is
required. Unknown JWT claims (including email) are ignored and discarded, never forwarded, indexed,
or reflected; malformed required claims reject. Unknown fields in generic envelopes still reject the
entire record under the closed parser. These are distinct rules for issuer-extensible tokens versus
closed evidence. Exact header/parser limits and the future assertion schema need implementation review.

Raw JWTs, request credentials, subject, user/workspace/thread/Amp-project IDs, email, paths, hostnames,
repository metadata, and arbitrary metadata never enter generic evidence, spools, storage, logs, or
dashboards. Raw verified claims exist transiently only inside authentication; the existing configured
allowed user remains restricted auth configuration. Do not persist decoded tokens for retries or
debugging. Logs/metrics allow only fixed route/event names, HTTP status, and closed outcome categories;
no identifiers (including fingerprints/site/collector IDs), times, body dumps, exception details, or
caller URLs. Approved Cukup Project identity is conceptually distinct from an Amp project ID, but this
generation uses only Unassigned as specified below.

These stricter checks are a separate **future generic** authorization policy. The existing
[`OidcVerifier`](../service/auth.ts) returns a boolean, verifies issuer/audience/RS256/expiry,
`token_use`, and allowed `user_id`; it does not resolve a site or validate thread-scoped subject binding.
Do not globally tighten it, rewrite legacy source ownership, change legacy allowed audiences, or
change target/API permissions as a side effect of this contract. Legacy v1/v2 stays independent.

## Collector ownership, durable replay, and immutable attribution

The execution site is authentication-owned; a collector instance is **one owner-exclusive durable
spool lane**, not a token, thread, project, or process. The future orb outbox generates a random UUIDv4
once, durably retains it with its order allocator and exact queued records before collection is
acknowledged, and never reuses legacy source IDs or physical outbox IDs. Local ownership locking,
bounded persist-before-acknowledgement, and sanitized queues follow [Stage 5C](stage-5c-physical-shadow-outbox.md).
This does not make its physical profile/hostname transport suitable for OIDC.

Retain the spool outside repository snapshots/templates in owner-only same-site durable storage.
No copied token is a spool credential. Establish a privacy-safe local incarnation binding before the
first collection is acknowledged, independently of any successful cloud append. Before draining after
restart, verify the current attested incarnation against that retained binding, even if the service
has never seen the collector. The local binding must not require a previously allocated server site
UUID: server mapping creation still waits for first successful fact acceptance. Its exact bootstrap
and local attestation verification (for example, a locally keyed fingerprint of the verified handle,
never raw claims) require separate review without extending evidence payloads here. Missing or
unverifiable binding quarantines retained records; never bind them retroactively to the upload site.
No durable same-site storage or no verifiable binding means no continuity claim.
Persist the allocation and envelope atomically; a restart must not regenerate IDs or rewind counters.

The first accepted evidence or coverage fact binds the collector permanently to its authenticated
site. All Stage 5A/5H rules continue: IDs unique across shadow fact families, exact case-sensitive
UUIDv4 matching, one shared positive safe-integer source sequence per collector, gaps allowed, and
new facts strictly above the accepted high-water mark. Exact old duplicates precede high-water checks.
Source order is delivery order, not occurrence order. Renewed authentication does not alter canonical
evidence, capability snapshots, site, collector, sequences, original receipts, or occurrence times.

FIFO blockers remain durable; do not skip them to let higher sequences invalidate old queued facts.
Evidence/coverage share ordering if a later coverage uploader is approved; Stage 5H is still internal,
not a coverage HTTP API. At sequence exhaustion, stop new allocation without wrapping; retain old
records for exact replay. A deliberately fresh collector is an independent lane, even at the same site.
It cannot close a prior collector's segment or inherit its coverage declaration or ordering counter.

**Project attribution is Unassigned in this generation.** Current OIDC proves current Amp context,
not an owner-approved Cukup Project mapping at evidence occurrence/start. There is no reviewed durable
mapping snapshot/approval verification transport for offline records. Do not infer mapping from the
upload token's `project_id`, matching names/slugs, current service mappings, paths, repository, or a
caller's `basis: approved_mapping` assertion. The existing parser validates shape, not such approval.
The future OIDC route must reject non-Unassigned engagement/start candidates, not silently rewrite
them. The producer records the existing closed Unassigned form (`absent` or `ambiguous`) at capture;
execution ends still contain no attribution. Physical and previously accepted facts are unchanged.

A later independently reviewed mapping slice may admit only approved immutable evidence-time Cukup
Project snapshots: engagement at observation, execution at start, end retaining start ownership.
It must prove selection/approval at capture, preserve delayed retries after mapping changes, and keep
native IDs local. If that cannot be supported, remain Unassigned. No historical relabeling or backfill.

## Authentication lifetime is not evidence lifetime

Authenticate every attempt, including an apparent duplicate, before parsing/looking up facts. Recheck
expiry and local authorization at acceptance commit. Token expiry or local denial committed first
prevents all acceptance and duplicate acknowledgement; no mutation occurs. A new valid JWT from the
same attested incarnation may retry an old accepted record as `duplicate`, retaining the original
receipt and content. Expired evidence is not a category: an old occurrence can first arrive with fresh
authentication. Token validity at occurrence is neither required nor inferred.

JWKS key rotation must not create a site. Bounded HTTPS discovery/refresh and unknown-key refresh may
recover verification; unavailable/invalid keys fail closed when verification cannot be established.
A previously validated cache may be used only within an explicit bounded cache lifetime (at most the
existing five minutes); no indefinite stale fallback. Removed keys can remain usable during that
window. JWT expiry still applies. Key removal, membership removal, token expiry, and local Cukup
denial are different events: signature verification cannot prove instant platform revocation.

Future rollout must explicitly accept Amp's documented delayed revocation bounds or obtain stronger
platform support. Cukup must offer a scoped local deny/disable boundary checked atomically with writes
and duplicate lookup, independent of JWKS caches; provisioning that control is a future gate, not a
shared-setting change here. Disabling a site never deletes accepted facts or transfers its collectors.
Already acknowledged records retain meaning after revocation. The service can order local denial
against its transaction, not an unseen external membership event. No instantaneous external-revocation
claim is permitted.

Duplicate means Stage 5A/5H canonical equality, not same JWT or just same evidence ID. After valid
authentication, changed valid immutable content/site/collector/sequence conflicts; malformed input
remains invalid and unsupported version remains unsupported, including retries. A recreated site
cannot retry an already registered old collector even with exact bytes: authentication supplies a
different site and persistence returns `identity_conflict`. For a collector whose first fact was never
accepted, the server has no old binding and cannot distinguish copied queued records from first
collection at the upload site. Preventing that submission belongs to the mandatory local incarnation
guard, not Stage 5A. This is a reviewed collector guarantee, not containment of a malicious collector.
Do not permit takeover by possession of files or knowledge of IDs in the supported collection path.

## Failure, recovery, display, and synchronization

| Condition | Required behavior |
| --- | --- |
| Missing required incarnation claim/assertion, changed creator, or inconsistent subject | Fail closed before generic acceptance; retain sanitized queue; fixed diagnostic only. Never fall back to thread, hostname, physical bearer, or legacy attribution. |
| Same site restart with intact spool | Preserve collector and allocated order; retry exact oldest record with newly acquired authentication. No token retained in spool. |
| Same site loses/corrupts identity or order state | Suspend affected lane. Recover only intact consistent local state; do not guess counters from server high-water or mint new IDs for retained records. Deliberate fresh collection uses a new spool/collector and leaves old records quarantined. |
| Old spool backup restored | Exact accepted duplicates may drain; genuinely new facts below high-water block. Restore newer consistent state or retain the blocker; no sequence renumbering. |
| Different/recreated site with copied old spool | Quarantine old lane without uploading or relabeling, including never-accepted records. Server independently rejects only collectors already bound to the previous site. New collection may use a fresh collector only after current local incarnation binding succeeds. |
| Old site no longer exists, unsent records retained elsewhere | No cross-site forwarding in this generation. Preserve sanitized records for a future separately authorized recovery design; do not promise cloud delivery or fabricate closures. |
| Clock uncertainty or unsupported recovered endpoint | Do not invent timestamps or completion. Locally suspend timing-dependent collection/delivery; detected service clock uncertainty fails closed for OIDC acceptance. AI work continues. |
| Delayed/offline delivery | Fresh auth for the same site, exact retained bytes/order, original occurrence; no age cutoff. Existing ten-minute future-occurrence tolerance still applies, independently of JWT lifetime. |
| Authentication/network failure or ack loss | Bounded retries with fresh transient credential, no redirects or token/body logging; exact queue record persists. Terminal identity/order errors block the FIFO for repair. |
| Storage failure | No acknowledgement before durable commit, no partial mapping/binding creation. Bounded failure must not stop AI work. No automatic loss fact from silence or failure. |

Only independently observed irreversible loss with defensible bounds can become Stage 5H loss evidence
under a later authorized uploader; missing files, a sequence gap, revoked access, or recreation alone
does not invent a loss interval. Pending old segments remain pending and contribute no provisional
runtime. Sanitized orphan spools remain sensitive local state; automatic discard/deletion is deferred.

**OIDC synchronization observations remain unsupported in this generation**, even after future
evidence ingestion is implemented. Stage 5J/K/L have physical credentials, durable independent status
revision, and explicit clock/freshness requirements. Identity design alone supplies neither a verified
orb status spool nor clock trust/scheduling. Keep `POST /v1/shadow-synchronization` physical-only
(`physical_bearer_required` for otherwise authenticated OIDC); do not create OIDC status rows or
bootstrap bindings with status. OIDC synchronization is `unknown`, never inferred from recent evidence,
JWT renewal, a healthy orb, an empty local spool, or dashboard availability. Stage 5M/5N freshness and
stale/unavailable behavior remain unchanged, with no trusted-clock activation.

Legacy `amp-orb` is a human-readable Executor Label shared by orbs, **not** a durable generic site.
Do not turn it into a UUID lookup key, merge all orb lanes under it, or split/relabel historical legacy
rows. Generic site/collector UUIDs remain internal. [Stage 5O](stage-5o-shadow-disclosures-dashboard.md)
already gives unlabeled/ambiguous lanes display-only ordinals; future orb lanes use that privacy-safe
fallback, with no claimed stable cross-report ordinal or Amp metadata label. New custom labels,
hostname disclosure, raw IDs in tooltips/DOM/report JSON, and an orb-specific dashboard change are
deferred. Display text never establishes identity continuity or changes metric unions.

## Acceptance vectors for the future owning implementations

These are **executable conformance specifications, not executed runtime tests or invented Amp claims**.
The future test adapter must exercise real authentication, disposable persistence, and an owner-exclusive
spool with synthetic signed tokens/platform assertions and a fake trusted clock. `incarnation` below
is test-fixture vocabulary for the required external capability, not a wire field. The adapter's
`run(name)` implements the fully specified scenario row and returns its closed result summary; it
must also assert exact response bodies, database/queue state, absence of raw log values, and unchanged
legacy rows/totals. A stub returning the expected summaries is not conformance.

| Scenario name | Inputs and independent state assertions |
| --- | --- |
| current-platform | Valid current documented JWT, no lifecycle-qualified assertion: generic route stays disabled; no generic writes. Legacy verification still succeeds for its existing fixture. |
| renewal-restart | Accept collector A evidence seq 7 at site X; restart both service and intact spool; renew JWT with different jti/iat/exp and key; retry 7 then submit 9: duplicate then accepted, one site, original receipt for 7. |
| recreation | Same user/thread/project and copied collector A; incarnation Y instead of X; valid auth: old 7 conflicts, new collector B seq 1 accepts at a distinct site; A's open segment stays pending. |
| unregistered-copy | X acknowledges local collection for A with a durable local incarnation binding, but zero cloud accepts; restore that spool in Y: local quarantine and zero evidence requests. Missing binding also quarantines, never retroactively binds to Y. An intact restart at X may send its first fact normally. |
| owner-change | Reuse incarnation X with another creator while both are hypothetically allowed: denied, no second mapping or A mutation. |
| scope-binding | Workspace-scoped sub with valid thread custom claim, then thread-scoped sub contradicting user claim: both denied before writes. |
| optional-context | Correct personal/no-project subject with optional claims absent: eligible with future assertion, Unassigned; same user with missing thread denied. |
| auth-boundary | JWT exp=2000 seconds; trusted now=1999999 then 2000000 ms: eligible then denied, even for an accepted duplicate; original receipt unchanged. |
| local-denial | Verify token, commit local site denial, then attempt acceptance transaction: denied; a prior acceptance remains retained. |
| jwks-window | Cached old key at 299999 ms since fetch may verify unexpired JWT; at 300000 ms refresh fails: denied; fresh new signing key for X resolves same site. |
| offline-order | Occurrence 30 days old, current valid auth: new seq 12 accepted; new seq 11 rejected invalid_order; exact old seq 7 duplicate, no rewritten receipt. |
| canonical-retry | Reorder object keys/capabilities at accepted seq 7: duplicate; change valid occurrence by 1 ms at same ID: identity_conflict; add path field: invalid_record. |
| future-clock | New occurrence at receipt+600000 ms accepted; +600001 rejected; untrusted auth clock denies either, no repaired time or sequence advancement. |
| mapping-change | Capture Unassigned start; later token changes project; end keeps start attribution; new start with arbitrary Cukup project UUID/basis rejected, not rewritten. |
| spool-rollback | Server high-water 12, restored spool has accepted 7 then never-accepted 11: 7 drains as duplicate; 11 remains blocked, later 13 cannot skip it. |
| counters-lost | Collector retained but allocator missing: suspend; fresh collector cannot close retained old segment. Exhausted 9007199254740991 cannot wrap to 1. |
| synchronization | Otherwise valid OIDC status upload: physical_bearer_required, no status rows; recent accepted evidence and ready panel still yield unknown. |
| atomic-privacy | Two concurrent first appends for X produce one site; injected transaction failure leaves neither new mapping nor fact; sentinel private JWT/body fields absent from logs, storage, and report. |

The following block is a runnable future adapter entrypoint. Until an implementation exists, supplying
the adapter is an explicit unmet gate; Stage 5P audits only its syntax and specification consistency.

```js
import assert from 'node:assert/strict'

export async function assertStage5P(adapter) {
  const vectors = {
    'current-platform': ['disabled', 'legacy_unchanged'],
    'renewal-restart': ['duplicate', 'accepted', 'same_site'],
    recreation: ['identity_conflict', 'accepted', 'distinct_site', 'pending'],
    'unregistered-copy': ['quarantined', 'no_submission', 'missing_binding_quarantined', 'same_site_first_accepted'],
    'owner-change': ['denied', 'unchanged'],
    'scope-binding': ['denied', 'denied'],
    'optional-context': ['eligible_unassigned', 'denied'],
    'auth-boundary': ['eligible', 'denied', 'receipt_unchanged'],
    'local-denial': ['denied', 'retained'],
    'jwks-window': ['eligible', 'denied', 'same_site'],
    'offline-order': ['accepted', 'invalid_order', 'duplicate'],
    'canonical-retry': ['duplicate', 'identity_conflict', 'invalid_record'],
    'future-clock': ['accepted', 'invalid_record', 'denied'],
    'mapping-change': ['unassigned', 'invalid_record'],
    'spool-rollback': ['duplicate', 'blocked', 'fifo_retained'],
    'counters-lost': ['suspended', 'pending', 'no_wrap'],
    synchronization: ['physical_bearer_required', 'unknown'],
    'atomic-privacy': ['one_site', 'rolled_back', 'no_private_values'],
  }
  for (const [name, expected] of Object.entries(vectors)) {
    assert.deepEqual(await adapter.run(name), expected, name)
  }
}
```

`denied`, `disabled`, and `eligible` are test classifications, not new HTTP status/error names.
An implementation design must freeze its exact bounded authentication/framing errors before coding;
Stage 5B/5A accepted/duplicate/conflict/order/parser outcomes remain unchanged. It must additionally
test wrong issuer/audience/user/token use/signature, multiple audiences, expired and future-issued
tokens, nbf, unknown JWT claims versus unknown envelope fields, transaction races, key/mapping loss,
safe key rotation, service backup recovery, copied-spool refusal before network, and legacy compatibility.

## Ownership, rollout, rollback, and explicit deferrals

- **Amp platform** owns attestation truth, incarnation lifecycle, subject grammar, credential issuance,
  revocation documentation, and same-site durable-storage guarantees. These are external blockers.
- **Cukup auth** owns the reviewed generic claim policy, private pseudonymous mapping, allowed user,
  local denial, clock trust, key lifecycle, and binding bootstrap. No collector may supply a site ID.
- **Outbox/collector** owns single-writer identity/order durability, supported occurrence observations,
  evidence-time Unassigned capture, bounded delivery, and truthful recovery limits.
- **Persistence** owns atomic append-only facts and immutable site/collector association, canonical
  duplicates, shared evidence/coverage order, and preservation through service restart.
- **Reporting** owns privacy-safe display and independent unknown synchronization; never infer project,
  loss, human engagement, completion, or authoritative totals from authentication.

The next implementation proposal must first resolve the external assertion and durability contract,
then separately review authentication mapping/denial persistence and a credential-free lifecycle test
matrix. No current JWT field combination silently satisfies that gate. Future coverage upload,
approved project mapping, synchronization, collector activation/packaging, clock-trust activation,
retention/deletion, cross-host recovery, backfill, cutover, support, and deployment remain separate slices.

Stage 5P changes documentation only; its paths do not match the current service publication workflow.
It does not cancel prerequisite Stage 5A–5O publication/schema/rollback implications. A future rollout
must preserve legacy routes and physical sites, remain shadow-only, and require explicit approval;
an implementation rollback must retain accepted facts, auth mappings/keys, and sanitized queued
records with compatible ingestion, or pause the affected lane with unknown/incomplete disclosures.
Never downgrade/drop data, reuse a site, remap a collector, or switch target authority to work around
an identity failure. No TypeScript, runtime, schema, DDL, migration, API/payload, dashboard, client,
collector, workflow, package, service declaration, shared setting, push, publication, production access,
or deployment change is authorized by this document.
