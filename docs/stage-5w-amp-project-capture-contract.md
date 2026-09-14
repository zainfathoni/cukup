# Stage 5W: Amp native project eligibility and recoverable capture

This documentation-only adapter contract narrows [Stage 5V](stage-5v-project-attribution-contract.md).
It implements and activates nothing. **No currently reviewed Amp project source qualifies for
native approved mapping.** A bounded path-free spelling is necessary, not proof of stable identity,
non-reuse, event context or owner approval. Keep new valid evidence Unassigned `absent` unless a
separately implemented and reviewed Stage 5V explicit launch/session binding qualifies. Current
production shadow collectors remain Unassigned; this document does not enable that alternative.
[Stage 5P](stage-5p-oidc-execution-site-contract.md) independently remains blocked, with generic OIDC
ingestion disabled, assigned starts/engagement rejected and synchronization unsupported.

## Evidence and limits of the current sources

Authoritative Amp documentation read on 2026-09-14:

- [Projects](https://ampcode.com/docs/projects) assigns at most one project when a thread starts,
  allows no-project threads, rename, owner transfer and deletion, and describes CLI matching through
  repository URLs/aliases. Its stable GitHub repository ID is not an Amp project identity contract.
  Changing the repository does not move existing threads or their repositories.
- [Handling Secrets](https://ampcode.com/docs/orbs/handling-secrets) documents optional `project_id`,
  recommends immutable IDs over email, and calls project-scoped subjects a stable identity shared
  across a project's orbs. Those subjects include the owner and change on owner transfer.
  These are real documented guarantees, but not an exact project-ID codec/size or a deletion,
  recreation, restore and non-recycling contract. A token's current context is not evidence-time
  Cukup approval. No token was minted, decoded or retained for this review.
- [Plugin API](https://ampcode.com/docs/plugin-api) exposes thread-scoped events and state streams;
  plugins can serve multiple threads concurrently. `activeThread` is UI focus, not event ownership.
  `workspaceRoot` is stable for a plugin process but is a filesystem URI. The reviewed event/state
  interfaces supply neither a lifecycle-qualified project key nor an atomic project-context and
  occurrence-time proof. Dispose is bounded and does not run after crash/SIGKILL.
- [Orbs](https://ampcode.com/docs/orbs) describes retained files/services across pause/resume, not
  non-copyable site identity or rollback-resistant mapping/capture storage.

Absence of the remaining guarantees in these sources is not proof Amp cannot provide them. Tests
or repeated successful CLI lookups cannot establish non-reuse. New authoritative support requires
another reviewed source-policy decision, not a runtime feature-detection switch.

The prerequisite code establishes only current behavior:

| Source | Observation; not an approval mechanism |
| --- | --- |
| [Legacy adapter](../plugin/legacy-amp-adapter.ts), [project parser](../plugin/project.ts), [tests](../plugin/project.test.ts) | Environment-ID/get or workspace-root/status resolution, exact returned-ID checks, name-to-slug normalization and a successful process-lifetime promise cache. Synthetic `project-1` is a fixture, not a documented Amp ID grammar. Path/remote-derived status matching is ineligible for generic attribution even when uniquely matched. |
| [Shadow collector](../plugin/experimental-amp-shadow-collector.ts), [tests](../plugin/experimental-amp-shadow-collector.test.ts) | Synchronous optional attribution callback is cloned at segment start, then asynchronously enqueued. Copying protects against later object mutation, not revocation races, capture durability or lost acknowledgements. Its fallback on callback exception cannot be reused for an indeterminate authority operation. |
| [Plugin entrypoint](../plugin/index.ts), [collector guide](experimental-amp-shadow-collector.md), [physical tests](../plugin/experimental-physical-amp-shadow.test.ts) | Production integrations supply no approved mapping. The legacy UI's “immutable Amp Project ID” wording is not external lifecycle evidence. Legacy behavior and experimental execution-only capability remain unchanged. |

## Frozen local key policy, with an empty eligible-source set

Policy version 1 uses Harness Type `amp`, adapter namespace `cukup.amp-project`, and only the
platform origin `https://ampcode.com`. Custom Amp domains are unsupported here; never derive the
namespace from an environment variable, redirect or caller URL. These are Cukup restrictions,
**not a claim about Amp's actual ID grammar or supported maximum**.

The native project component must be an opaque platform-issued string of **1..128 ASCII bytes**,
matching `[A-Za-z0-9][A-Za-z0-9_-]{0,127}` in its entirety. Compare exact bytes. No trimming,
case folding, Unicode normalization, URL decoding, UUID conversion, padding, truncation or hash
substitution. Empty, non-string, whitespace, non-ASCII, slash, backslash, colon and control bytes
reject as a native candidate. Passing this syntax alone never admits user labels, names/slugs,
paths, remotes, repository IDs, thread IDs, JWTs/subjects or encoded derivatives of those values.
Do not store a rejected candidate or echo its bytes. An unknown source or unsupported format
means no native candidate, not a guessed conversion. Changing these bounds requires a new policy.

A future source policy must attest the exact platform project and its owner scope for the actual
observed thread/session at occurrence and capture, without resolving a checkout, repository or UI
focus. It must document identity stability across rename, process restart, token renewal and same
project pause/resume; uniqueness within the pinned owner scope; and no recycling after deletion,
recreation, clone, restore or ownership transfer. Project identity need not change when an orb is
recreated, but the independently authenticated site must satisfy its own lifecycle contract.
If recycling is possible, a platform-supported project-incarnation discriminator and a new reviewed
key codec are required; version 1 has no discriminator slot. A locally generated counter cannot
repair missing native lifecycle guarantees.

Scope is exact Cukup account, authenticated execution site, Harness/adapter/key-policy version,
platform and a restricted random owner-scope reference, plus native bytes. The owner-scope reference
must be durably bound by the future source verifier to exactly one platform owner/type, never
rebound or supplied by the collector as an assertion. Transfer creates a distinct context and
requires new prospective owner approval; it cannot carry an old mapping. Repeated native bytes
at another site, account or owner do not inherit approval. Identical names never merge contexts.
Names are not key components; rename alone does not revise a qualifying mapping.

The persistent representation is a versioned **HMAC-SHA-256** fingerprint, 64 lowercase hex
characters, with a separate restricted random key-version reference. Its input is the UTF-8
RFC 8785 canonical JSON array, in this exact order:

`["cukup.amp-project.native-key",1,"https://ampcode.com","amp","cukup.amp-project",1,account,site,ownerScope,nativeID]`

Account/site are the existing immutable verified references; ownerScope is a lowercase UUIDv4.
This array is the key encoding, not a generic envelope or a new local transport schema. It is
unambiguous without delimiter guessing. Never use an unkeyed hash. Key rotation retains prior keys
and exact context associations; a new fingerprint version cannot allocate a replacement project,
merge mappings or bypass revocation. Unknown versions, lost keys, inconsistent associations or
suspected collisions block native selection. Crypto provisioning and the owner-scope verifier are
implementation gates. Raw accepted native bytes are transient inside that restricted verifier and
fingerprint operation only, not persisted in proofs, spools, service state or backups by this policy.
Existing local random context references and fingerprints remain sensitive restricted authority data.

## Fresh capture and recovery are one operation, not another lookup helper

Apply Stage 5V selection unchanged: verified explicit binding first, failed presented explicit
intent blocks fallback, multiple distinct eligible mappings are ambiguous even with the same target.
Unsupported native identity alone is absent, not ambiguous. Only a complete verified view can prove
ambiguity. Native eligibility, owner approval, occurrence proof and registry ownership are separate
requirements; satisfying one never implies the others.

Before an authority request can escape, reserve durably in the intact same-site collector lane the
evidence UUID, source order, segment UUID for a start, sanitized observation and immutable request
identity/context references. No raw native IDs or event bodies enter that intent. Allocation and
reservation are atomic; no subsequent evidence may overtake an unresolved reservation. A process
mutex or the existing promise queue is not a cross-process fence. The future local codec must pin
all bounds, canonical request equality and conflict outcomes before implementation.

For a new capture, the verified native/explicit context, fresh authority head, current authorization,
project lifecycle and supported occurrence interval must participate in the same serialized commit
as the immutable capture result and recoverable canonical evidence. Revalidate at commit, not before
an asynchronous wait. Context changes or unprovable occurrence binding preclude native assignment;
do not use a later project lookup to explain an earlier callback. Valid occurrence bounds must meet
Stage 5V's approval/revision rules; `Date.now()` and `precision_ms: 1` are not a clock/uncertainty proof.
No positive offline cache, lease or cached successful CLI promise can replace this operation.

The mapping authority retains the complete result, proof and exact sanitized evidence before
acknowledging capture, under independently fresh, fenced rollback-resistant history equivalent to
[Stage 5S](stage-5s-authority-control-storage.md). This is separate mapping authority state, not an
extension of Stage 5S service control records. The spool atomically installs that result against the
original reservation before collection is acknowledged or delivery attempted. An authority commit
followed by a crash before spool installation is recoverable, not an uncaptured observation.

Recovery authenticates the original account/site/collector and queries the original evidence
identity. A committed result is returned exactly after current authorization; changed canonical
request under that identity conflicts. Revocation, archive or rename after commit never recomputes
the result. Denied recovery suspends the lane; it does not erase the result or imply non-commit.
If authority was never contacted, local `absent` may finalize atomically. After any possibly sent
request, a “not found” response alone is insufficient: fresh serialized resolution must also fence
all pending/delayed attempts for that identity against later commit before local `absent` finalizes.
That terminal no-commit decision must be retained durably for retries/restores. Otherwise remain
indeterminate and suspend the lane. Never finalize both an authority result and `local_absent`.
Exact protocol/storage for this fencing is an implementation blocker, not a new wire outcome here.

Unrecoverable intent/result/order or copied-site state quarantines the affected lane; no new ID,
order, current mapping or Unassigned replacement repairs it. New independent collection is allowed
only under the owning protocol's fresh-lane rules. Recovery of a committed capture is distinct from
recovering an Amp hook: no cross-restart hook deduplication, recovered execution, human-origin claim
or missing endpoint is added. A new end has no attribution and must retain the original same-lane
start ownership; mapping recovery alone cannot justify producing that end. Failures are bounded
and must not stop AI work. They do not manufacture coverage loss or synchronization health.

## Asymmetric acceptance vectors

These are future conformance requirements, **not executed runtime tests**. Use synthetic accounts
A/B, sites X/Y, owner scopes O/R and distinct Project UUID fixtures P/Q. Hypothetical positive rows
assume a separately reviewed source policy and all Stage 5V gates; current native rows stay absent.
Inspect exact request/result/proof/spool/receipt contents and all privacy sinks, not outcome counts.

| Input | Independent expected result |
| --- | --- |
| Current documented project ID or valid project-scoped JWT plus owner-approved M→P | Native selection absent: approval cannot bless unsupported lifecycle/context. Zero new generic OIDC acceptance. |
| Native `A_7` versus `a_7`; 128 `A` bytes versus 129; leading space, slash or non-ASCII | First two are different syntactically valid keys; 128 passes syntax, 129 and prohibited characters reject. None proves native eligibility. |
| Same hypothetical eligible native bytes at A/X/O versus A/Y/O, B/X/O and A/X/R | Only exact approved A/X/O may select P; other contexts require their own approvals. Rename retains the original key; owner transfer cannot. |
| Unique repository status match versus supported event-bound native context; active UI belongs to another thread | Status never qualifies; only the actual event's supported context may qualify. UI focus never substitutes. |
| Valid explicit→Q with unsupported native→P; revoked explicit→Q with eligible native→P; two explicit mappings→Q | Q/explicit_binding; absent; ambiguous, respectively. |
| M→P approval upper time 10; occurrence [11,13] versus [9,15], capture at 20 | First may select P, second absent; identical wire precision cannot make both eligible. |
| Capture P at order 4; revision→Q at 5; fresh capture at 6, all exact same point instant | P then Q for co-serialized live observations; retry order 4 remains P. Unordered delayed callbacks cannot use the tie exception. |
| Durable capture P, ack lost, revoke M, retry; same ID with changed Q request | Recover P once; changed request conflicts; no second source order, no second receipt. |
| Request never sent versus delayed in-flight request after a fresh “not found” | First may finalize local absent; second cannot until terminal no-commit fencing defeats the delayed request. After fencing, replay cannot commit P. |
| Offline cached M→P with valid local evidence, then reconnect | Durable absent forever; only a genuinely new fresh capture can select P. Indeterminate attempts cannot use this fallback. |
| Crash after authority commit before spool write; restore head 7 while fresh authority is 9 | Recover exact committed result into original reservation; replay exact missing history through 9 before assigned capture. Missing content/key or divergent digest quarantines. |
| Copy X's never-uploaded spool to Y; restore same X with missing reservation/order | Quarantine before network in both cases; no upload-site rebinding or allocator reset. |
| Recovered callback with no capture proof versus retained committed capture | First absent if otherwise valid evidence; second exact replay. Neither creates an execution end or human engagement. |
| Sentinel native key/proof in generic unknown field, log, backup or public DOM; legacy slug matches P label | Prohibited disclosure rejected without raw logging; only approved restricted authority material may enter encrypted authority backups. No raw native bytes there. Zero legacy linkage/backfill or historical relabeling. |

## Remaining gates and publication

Before implementation: authoritative Amp lifecycle/non-reuse and event-context source policy;
owner-scope verification; bounded restricted codecs/crypto/retention; owner authorization and
revocation fencing; trusted occurrence/commit clocks; capture reservation/journal/no-commit recovery;
registry ownership enforcement and collector integration. Explicit binding also needs its own real
launch/session lifecycle mechanism; it is not a text override. No existing parser or callback meets
these gates. Labels and native-name refresh remain Stage 5V's separate safe-display policy.

[Stage 5Q](stage-5q-legacy-history-authority.md) no-backfill/no-cross-authority-deduplication,
[Stage 5R](stage-5r-authority-activation-contract.md) owner-approved accounting/activation fences,
and Stage 5S all-mutator recovery floors remain intact. No mapping selects C, changes target
authority, strengthens coverage, or unblocks Stage 5P attestation/approval transport or OIDC status.

Only this document and ROADMAP change. Neither matches the main-push
[service publication workflow](../.github/workflows/publish-service.yml); this slice is publication-
neutral, while cumulative prerequisite image/schema/rollback implications remain unchanged.
No TypeScript, schema, API, config, workflow, runtime behavior, shared-state mutation, production
access, push, publication, deployment, activation or support claim is authorized or performed.
