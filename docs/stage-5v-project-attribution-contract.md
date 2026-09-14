# Stage 5V: owner-approved evidence-time project attribution

This documentation-only contract settles prospective project selection under
[ADR 0007](adr/0007-generic-harness-evidence-boundary.md). It implements nothing.
[Stage 5P](stage-5p-oidc-execution-site-contract.md) still requires Unassigned for its
future OIDC generation and remains externally blocked; this document supplies neither its
attestation nor its missing approval-verification transport. Physical production collectors
also remain unchanged. Shape acceptance by the [generic parser](../service/harness-evidence-protocol.ts)
is not approval verification. No registry, mapping store or approval interface exists yet.

**Decision: random immutable account-owned Cukup Project UUIDv4s, exact owner-approved
site-scoped mappings, and a fresh serialized collector-side lookup at capture.** No positive
offline cache is allowed in this first contract. Retain proof at the collector/mapping authority;
send only the existing closed attribution snapshot with generic evidence. This is a reviewed
collector guarantee, not cryptographic containment of malicious collectors.

## Identity and lifecycle

A project is created by the authenticated account owner with a new lowercase random UUIDv4.
It is not derived from a name, slug, native identifier, path, remote, credential or other UUID.
The account owns the UUID permanently; identity comparison is exact, without normalization.
Creation is active; archive is terminal in this version. There is no delete, merge, split,
reparent, UUID reuse, account transfer or unarchive operation. A mistaken archive requires a
new project and prospective approvals, not resurrection or movement of earlier evidence.
Archive blocks new captures to that project, not delivery or reporting of captured records.

Project name/slug is presentation, never a lookup key or uniqueness proof. Rename changes no
identity, mapping revision, ownership, evidence or time. The owner may rename lightweightly;
an identified native project's refreshed display name may update collector-side future display
without another mapping approval, reserved former slug, effective-time choice or weekly ledger.
It cannot change the Cukup UUID or automatically overwrite a shared cross-Harness project label.
Legacy Amp Project Slugs retain their existing behavior and stored values. Neither they nor
native Amp IDs/names nor dashboard text prove historical generic ownership.

## Closed local authority model

The mapping authority is an owner-controlled restricted component at the collection boundary,
not the generic ingestion service. It may support multiple sites only with authenticated,
isolated site channels; cross-host collection is not authorized. These are logical records,
not an API or storage schema. Unknown fields, arbitrary metadata and implicit defaults reject.
All references are fresh lowercase UUIDv4s except references to existing immutable account,
site and collector identities. All records have version 1 and account binding. Revisions and
orders are safe nonnegative integers; exhaustion refuses new writes, never wraps or prunes.
Times are integer UTC milliseconds with the bounds of Stage 5S; time proofs use that contract's
bounded [L,U], epoch, sample and policy references, not raw clock telemetry.

| Record | Closed logical content |
| --- | --- |
| Project | UUID, account, creation operation; append-only lifecycle revisions with previous revision, active/archive state, owner authorization reference, operation, commit order and time proof. Creation revision 0 has no predecessor. Labels are separate presentation state, not part of approval terms. |
| Native context | Local random context reference, account, site, Harness Type, adapter namespace/version, native key representation and key-policy version. Immutable; never service-visible. Namespace policy must prove stable path-free identity and exact canonical encoding. |
| Mapping | Random mapping UUID, account, immutable selector (native context reference OR explicit launch/session reference), exact site and Harness Type. No wildcard, account-wide, cross-site, name, glob, regex, directory or repository selector. |
| Decision | Mapping UUID, revision, predecessor (null at 0), state (`approved` or `revoked`), target project UUID, owner authorization reference, operation UUID, canonical request digest, commit order and time proof. Revision 0 is approved; subsequent approvals replace target prospectively, revocation is terminal for that mapping UUID. Revocation retains the prior target. |
| Capture proof | Account/site/collector, evidence UUID, source order, segment UUID only for a start, exact canonical evidence digest and tagged result. `authority` result has lookup order, capture time proof, occurrence proof (or explicit null for Unassigned), selected mapping/revision/project lifecycle revision OR Unassigned reason, and authority head reference. `local_absent` result has only reason `absent`: no invented authority head/order/time proof. Retained with exact sanitized spool record; no native key in the proof. |

An occurrence proof retains the supported occurrence interval [L,U], opaque source-policy/proof
references and binding to the canonical evidence timing. It stays restricted locally. The reviewed
source policy must establish that interval; `precision_ms` is resolution, never uncertainty or clock
trust. Co-serialized live observations may explicitly reference the capture time proof as their
occurrence proof. Otherwise capture time alone proves nothing about native occurrence uncertainty.
No defensible occurrence interval means `absent`; positive results require a non-null proof.

Explicit launch/session references are random local references durably bound to the actual launch
or session, never text supplied as a generic identity. End of that launch/session closes its
selector for future captures; references cannot be copied to another launch or reused. An explicit
binding requires the same owner approval as a native mapping and an existing active project.
It uses `basis: explicit_binding`; a native mapping uses `basis: approved_mapping`.
Proposals have no selection effect and are not approvals. No separate mutable draft model is needed.

Only owner control may create/archive projects or approve/revise/revoke mappings; ordinary
ingestion credentials, native project membership and collectors cannot approve. Each mutation
revalidates owner authorization and expected project/mapping revisions at a serialized durable
commit, including cross-process writers. Successful operation UUIDs reserve exact canonical
requests and outcomes for account lifetime. Reauthorized exact retry returns the original outcome;
changed request under that UUID conflicts; stale expected revision conflicts. An indeterminate
commit must be resolved by its original operation UUID before another attempt or replacement.
Definitive rejection commits nothing. No owner identity, token, claims or free-form explanation
is copied into these records: authorization is a restricted opaque reference.

Every approval/revision/revocation/archive takes effect at its actual commit, never at an owner-
chosen past/future date or upload time. A single authority order serializes changes and captures.
Time proofs must remain monotone and valid at commit; where equal clock instants occur, order
breaks ties. Each revision governs the half-open order interval from its commit inclusive to the
next revision exclusive. Record both order and actual time proof; do not manufacture millisecond
separation. There is no editing an old approval, backdating, scheduled activation or time rounding.

## Exact selection and capture

For each new live engagement observation or execution start, the collector supplies its verified
account/site/collector context and supported native context plus any explicit launch/session
binding to the local authority. No lookup occurs at upload or execution end. No native context
means no native candidate; lack of stable path-free native identity permits only explicit binding.

An authority-backed lookup and durable capture constitute one serialized operation relative to mapping and
project lifecycle commits. The implementation must use a transactional local capture or equivalent
durable commit protocol; an ordinary lookup followed by an unfenced asynchronous enqueue is
insufficient. The mapping authority retains the capture result before acknowledging it, and the
collector can recover that exact result into its spool after an interrupted acknowledgement.
If authority is definitively not reached or proves no capture committed, the collector may instead
atomically finalize a `local_absent` proof and sanitized evidence in its own intact durable lane.
It claims no authority lookup or trusted mapping time. An indeterminate authority attempt may not
fall back: resolve its original identity first. Both variants permanently finalize one snapshot.
An allocated evidence identity can never acquire a second result. Positive capture also requires
the mapping to have been effective at the supported observation/start occurrence: the occurrence
uncertainty interval must be wholly after the approving commit's upper bound. If approval or a
competing revision overlaps that interval, use `absent`, not a guessed project. The same authority
order at equal proven point instants resolves ties only for live observations serialized there.
Delayed native callbacks whose occurrence predates the current decision cannot use current state.
This version does not perform historical mapping queries to newly attribute recovered evidence:
without a previously durable capture proof, recovered engagement/starts use `absent`.

With a valid fresh authority view, evaluate exactly these steps:

1. Collect approved, occurrence-eligible explicit bindings for this exact launch/session scope.
   Any presented explicit binding that is revoked, archived, expired in scope or unverifiable
   blocks fallback: return `absent`. Never silently attribute elsewhere after owner intent fails.
2. If no explicit binding was presented, collect approved, occurrence-eligible native mappings
   for the exact context/site/Harness namespace. Revoked or archived targets are ineligible.
3. At the chosen priority, zero candidates means `absent`, one means its project/basis, and two
   or more distinct mapping UUIDs means `ambiguous`, **even if all targets are the same UUID**.
   Never choose by insertion order, lexicographic UUID, latest revision across different mappings,
   matching label or majority. Duplicate copies of the same mapping UUID/revision count once;
   divergent copies mean invalid authority (`absent`), not additional candidates.

Explicit outranks native; two eligible explicit bindings are ambiguous even with one native match.
An ambiguous higher tier never falls through. Approval may create overlapping mappings; it does
not secretly supersede another mapping UUID. Owner revocation can remove competing candidates
for subsequent captures only; target revision alone cannot resolve mapping-identity ambiguity.
Multiple native contexts observed without a uniquely
supported context selection are `ambiguous`; do not select one by repository or current UI tab.

`absent` means no defensible eligible choice at capture, including missing/untrusted/unavailable
authority, unknown project, failed freshness/time proof, offline or stale cache, and missing context.
`ambiguous` means a verified view establishes multiple eligible choices/context alternatives.
Unavailable or incomplete state cannot establish ambiguity; it is `absent`. These are the only
wire reasons; do not add `offline`, `revoked`, `unknown`, diagnostic text or a confidence score.
If timing/evidence itself is invalid, suspend that evidence under the existing protocol instead
of disguising it as valid Unassigned. Measurement failure must not block AI work indefinitely.

There is no positive cache lease: every new assigned capture requires a current linearizable
authority head and valid clock proof. Cached candidates may assist owner display only. On offline,
stale, revoked access or untrusted lookup time, capture valid evidence as Unassigned `absent` in
the durable collector spool; subsequent reconnect never upgrades it. Collector authentication/site
failure separately suspends collection/delivery as required by the owning protocol. Revocation
committed before capture excludes that decision; capture committed first retains its assignment
even if delivered after revocation/archive. Unseen remote revocation is not instantaneously known:
loss of the fresh authority channel precludes assignment rather than promising offline revocation.

Execution ends carry no attribution field and inherit exactly the accepted same-collector start's
project or Unassigned reason. Rename, mapping change, archive, restored state or new credentials
cannot move or close a segment. A start captured before revision and an engagement after revision
may legitimately differ. A pending start remains pending; no fabricated endpoint or provisional
runtime follows. Missing start proof/state cannot be reconstructed from current native context.

## Privacy boundary and future service interface

| Destination | Permitted content and limits |
| --- | --- |
| Generic evidence/service ingestion | Only existing `project_attribution`: `{kind: cukup_project, project_id: UUIDv4, basis: approved_mapping or explicit_binding}` OR `{kind: unassigned, reason: absent or ambiguous}` on engagement/start. Ends omit it. Other existing closed protocol fields remain unchanged. No approval ID, context key, label, digest, receipt extension or metadata bag is added. |
| Collector/mapping authority only | Native contexts/selectors, approvals/revisions, capture proofs, private audit and key material. Restrict to account owner and authorized site collector; encrypt backups, bound access and avoid raw diagnostics. Raw native IDs may be held only when required by a reviewed stable path-free adapter policy; prefer domain-separated account/site/namespace keyed fingerprints, never unkeyed hashes. Fingerprints and random refs remain sensitive and never enter evidence or public outputs. |
| Future service registry/read interface | Only account-owned project UUID, active/archive presentation status, and separately approved safe label. No native keys, mapping records or capture proofs. UUID ownership lookup is account-scoped; archived known UUID remains resolvable. A present-day registry lookup is not proof of historical mapping approval and cannot rewrite/reject old assignment merely because the project is now archived. Unknown/wrong-account project must fail closed in a future enforcing route, never silently become Unassigned. Exact route/errors and rollout are deferred. |
| Dashboard/public reports/logs | No native IDs, paths/remotes, selectors, proof refs/digests, owner/site/collector IDs or raw errors. Stable project UUIDs remain internal grouping keys, not DOM/tooltips/public JSON. Public review uses synthetic fixtures and aggregate verdicts only. Logs use fixed categories without identifiers or payloads. |

Paths, repository remotes and prompt/body content are not accepted selectors even in the mapping
authority. A path-free key's encoding, maximum size, stability/reuse guarantees and fingerprint
rotation must be frozen per adapter before implementation; unspecified means no native mapping.
If native identity can be recycled, require a supported incarnation discriminator or explicit binding.
Fingerprint rotation retains exact old key versions/associations, never remaps or merges by digest.

Labels sent to a future service are a separate constrained display value explicitly approved for
disclosure, not arbitrary native names. Raw native-name refresh stays local unless it satisfies that
separately reviewed display policy. Identical safe labels do not merge UUID lanes; missing/colliding
labels use privacy-safe display-only fallback. Renaming can change current display of the same lane,
not recorded ownership. No frozen historical dashboard text or native-name synchronization API is
required. Project lanes remain targetless and non-additive; label lookup never determines totals.

The existing receiver's immutable snapshot at receipt persists the collector's capture result;
it does not resolve current mappings. Current parsing alone cannot enforce the new guarantee.
A future physical collector rollout must verify this local protocol and registry ownership checks
before claiming approved attribution. Service authentication still runs on every attempt. A future
OIDC approval-verification design needs separate review and may not add local proof data to this
generic wire by implication. Stage 5P rejects assigned starts/engagement until that gate is changed.

## Replay, correction and recovery

Retry exact captured evidence through its original lane/order/identity and current valid auth.
Canonical duplicates preserve original receipt and attribution; changed project/basis/reason under
the same evidence identity conflicts. New higher-order duplicates with newly minted IDs are not a
correction mechanism. FIFO blockers and unseen old-order rejection remain; do not resequence.
Correct mistakes only through new prospective owner decisions for genuinely new observations.
No accepted or queued Unassigned-to-assigned conversion, historical backfill, relabeling of accepted
ownership, compensating evidence or cross-authority deduplication is permitted. Explicit historical
correction remains outside ADR 0007's initial design.

Mapping authority recovery must retain complete project/mapping/operation history and capture
results, allocator high-water, site/account bindings and compatible verification keys. Before
acknowledging writes, commit them to an independently rollback-resistant head and recoverable
content, with freshness and writer fencing equivalent to [Stage 5S](stage-5s-authority-control-storage.md).
It is a separate restricted authority, not permission to store native keys in Stage 5S service
control records or to initialize/activate its accounting authority. A backup hash alone is not
freshness proof. No history/operation eviction or destructive key rotation is defined in version 1.

Restore under stopped/fenced writers: matching fresh head plus full verified content may resume;
an older proven ancestor must replay the exact committed suffix; same sequence/different digest,
ahead/divergent state, wrong account/site, missing key, missing witness or unsupported version
quarantines mapping state and blocks assigned capture. New valid evidence may still be Unassigned
if the independent collector lane is intact. Never regenerate UUIDs, reset revisions, resurrect a
revoked mapping or archived project, or treat an empty restored store as a new authority.
Recover lost capture acknowledgements by original evidence identity; an indeterminate capture
cannot also be enqueued as Unassigned. If its durable result cannot be recovered, suspend that
capture/lane rather than inventing another fact. Collector spool rollback retains existing
duplicate/order/site guards; copied spools cannot transfer sites, including never-uploaded records.

Service restore separately preserves accepted evidence and registry UUID ownership/tombstones;
its future registry mutations must join Stage 5S's all-mutator frontier before acknowledgement.
Collector/mapping backups cannot overwrite service evidence or establish service authority.
Rollback requires compatible readers/writers/proofs or suspended assigned capture, never deletion
of accepted state or reinterpretation as legacy. [Stage 5Q](stage-5q-legacy-history-authority.md)
no-backfill/no-cross-authority-dedupe and [Stage 5R](stage-5r-authority-activation-contract.md)
armed/active accounting fences remain independent. No project mapping can select or undo C.

## Independent acceptance vectors

These are future implementation requirements, **not executed runtime tests**. Use synthetic
accounts A/B, sites X/Y, projects P/Q and mapping identities M/N (distinct UUIDv4 fixtures in tests).
Verify exact canonical snapshots, receipts, proofs, head and spool contents, not just counts.
Times below are synthetic millisecond offsets, unrelated to accounting C.

| Input | Independent expected result |
| --- | --- |
| M native→P approved at 10; live occurrence/capture at 9, 10 ordered after approval with exact point proof, 11 | `absent`, P, P. A callback at capture 11 for occurrence 9 stays absent. Interval [9,11] straddling approval cannot assign. |
| Same wire occurrence 12/precision 1, capture 20, approval at 10; supported occurrence bounds [11,13] versus [9,15] | First P; second absent. Identical wire precision and trusted capture time do not establish identical occurrence uncertainty. No supported bounds also means absent. |
| M→P at order 2; M revision→Q at order 5, same clock instant as captures at orders 4 and 6 | First P, second Q; timestamps alone cannot choose. Retry first after order 6 is still P. |
| M→P and N→Q versus M→P and N→P, same eligible native context | Both ambiguous. Two copies of M at the same revision give P; conflicting copies of M give absent. |
| Explicit→Q plus native→P; then two explicit mappings→Q; then revoked presented explicit plus native→P | Q/explicit_binding; ambiguous; absent. None selects P. |
| M→P at X/Harness amp; identical native text at Y, account B, or another Harness namespace | Only exact A/X/amp context selects P. Others absent; registry request for A's P authenticated as B fails closed. |
| Cached M→P; disconnect; revoke M remotely; capture then reconnect | Disconnected capture absent whether or not revocation happened. Retry unchanged; next online native lookup absent. No stale-P lease. |
| Authority never reached versus authority possibly committed then acknowledgement lost | First may durably finalize local_absent without authority head/time/order. Second suspends pending identity resolution, never finalizes a competing local_absent; recovered authority result is replayed exactly. |
| Start P at 20; rename at 21; M→Q at 22; archive P at 23; end at 29 | Start/end lane P; new live engagement at 24 uses Q. P display may refresh; UUID and start proof unchanged. New direct binding to archived P cannot assign. |
| Capture P then lose ack; revoke then retry same evidence identity; change its project to Q | Recover original P once; exact delivery duplicate preserves receipt; changed valid content conflicts. No new ID/order to escape conflict. |
| Recover old occurrence 12 at 40 with mapping approved at 10, no old capture proof | Absent despite seemingly matching historical dates. With retained original P capture, replay P instead; never recompute. |
| Backup at head 7, revoke at 8/archive at 9, witness 9 | Restore suffix through 9 before assigned capture; cannot revive head 7. Missing suffix means no assignments. Same head 9 with changed target digest quarantines. |
| Collector moved from X to Y before its first service accept | Quarantine old spool before network; fresh Y collector cannot close X segment. Matching display label never establishes continuity. |
| Legacy slug P-name matches safe label on P and a current native project | Zero generic writes or identity linkage. Existing legacy totals/receipts and generic ownership unchanged. |
| Sentinel path/remote/native ID in unknown evidence field, label or log; approved project UUID in public DOM | Prohibited disclosure rejected/redacted before output, no raw rejection log. Native-key handling stays restricted; a project UUID is not a public label. |

Future tests must also inject revocation/archive races, owner denial, clock trust loss, capacity
exhaustion, duplicate operation requests, crash before/after capture commit, proof-key loss and
unsupported recovery versions. Prove failure does not stop AI work, invent loss/endpoints, mutate
existing evidence or strengthen synchronization/coverage. No runtime test suite is claimed here.

## Deferred implementation and publication

Exact interfaces required before coding: closed canonical bounded local record codec and retention;
owner HTTP/authentication/authorization/revocation and replay protection; adapter-specific native-key
policy; trusted clock/uncertainty and serialized capture protocol; independent authority journal,
freshness/fencing and recovery; project registry API/storage and account ownership enforcement;
collector/outbox integration; privacy-safe display policy and dashboard contract. None is implemented
or activated. OIDC synchronization, workload attestation, trusted-clock activation, authority
activation and production provisioning remain separate blockers/slices, not incidental follow-through.

Stage 5V changes only this document and ROADMAP. Neither path matches the main-push
[service publication workflow](../.github/workflows/publish-service.yml); this slice is publication-
neutral, while cumulative prerequisite publication/schema/rollback implications remain unchanged.
No TypeScript/runtime/schema/DDL/migration/API/dashboard/client/collector/config/workflow behavior,
production access, database/settings mutation, push, publication, deployment or activation is
authorized or performed. Documentation review does not approve any actual mapping or project.
