# Stage 5S: authority control storage and recovery checkpoint

This documentation-only slice closes the logical storage/recovery contract left by
[Stage 5R](stage-5r-authority-activation-contract.md). It defines no DDL, wire protocol, selected C,
or activation. [Stage 5Q](stage-5q-legacy-history-authority.md) still forbids legacy backfill,
cross-authority deduplication, and summed authorities. An armed boundary cannot be abandoned after C.

**Decision: use one account-serialized, externally committed recovery journal; SQLite is its
transactional materialization.** A checkpoint is the journal's monotone authenticated head, not a
second best-effort write after a SQLite acknowledgement. Every accepted write affecting recoverable
service state participates, starting at explicit initialization, including before arming. A local
SQLite-only implementation cannot satisfy rollback resistance. An equivalent implementation must
prove the same commit, recovery, and freshness properties below, not merely store another checksum.

## Existing storage is not the recovery witness

[ServiceStore](../service/store.ts) currently creates/open-migrates SQLite, uses WAL and immediate
transactions, and refuses versions above **8**. Legacy ownership precedes duplicate lookup; exact
replay retains first receipt, while unseen old order is rejected. [Shadow evidence/coverage](../service/shadow-evidence.ts)
preserves immutable facts and bindings; [synchronization](../service/shadow-synchronization.ts)
replaces a collector's latest snapshot. Source sequences therefore cannot represent all writes.
[Backup operations](../service/operations.ts) verify SQLite integrity and adjacent metadata;
[operations guidance](service-operations.md) retains snapshots. Neither establishes that a valid
older snapshot is the latest accepted history. No authority tables or external witness exist now.

The following version **1** is a logical control format, not SQLite `user_version`, evidence wire
version, or dashboard schema. A future persistence slice assigns its own SQLite migration version
above 8. No existing migration may silently initialize authority or synthesize approvals.

## Closed logical records

All records reject unknown fields, duplicate keys, missing required fields, invalid enum values,
overflow and unsupported versions; no coercion, truncation, arbitrary JSON or extension bag.
`Ref` is a service/authentication-generated lowercase UUIDv4 (36 ASCII bytes), scoped by account;
it is never a native identifier, user input label, URL or path. `Digest` is 64 lowercase hex SHA-256
characters. Revisions/counters are integers 0..9007199254740991; increments at the ceiling refuse
without wrap. UTC milliseconds are integers 0..253402300799999. Null is allowed only where stated.
Canonical bytes use RFC 8785 JSON, validated integers only, sorted/deduplicated Ref arrays, explicit
nulls and every listed field; domain-separated digests include record type and format version.
Equality compares canonical content, not just a digest. Control records are at most 65536 UTF-8
bytes each; a transaction has at most 64 control records and 4194304 canonical control bytes.
History grows append-only: these are per-record/transaction bounds, not permission to evict history.
Capacity exhaustion blocks new commits without deleting old records or losing replay protection.

Every record below includes `format=1`, `account:Ref`, `lineage:Ref`. Every immutable reference
resolves to retained canonical content plus its digest; cross-account/lineage references reject.
The names below are logical fields, not table or endpoint names.

| Record | Exact remaining fields and constraints |
| --- | --- |
| Root | `revision`, `selection:Ref`, `headSequence`, `headDigest`, `stateDigest`. One per account; mutable only by committed journal projection. Revision starts at 0 and increases by exactly one per decision transition, not for evidence or gate updates. Points to the one current Decision at that revision. |
| Decision | `revision`, `previousRevision` (null only at 0), `selection:Ref`, `state` (`legacy/prepared/armed/active/cancelled`), `terms` (Ref or null), `approval` (Ref or null), `activation` (Ref or null), `operation:Ref`, `commitSequence`. Unique account/revision; immutable. `legacy` exists only at revision 0 with all three refs null. Prepared has terms only; armed adds approval; active adds activation; cancelled retains terms and any former approval, never activation. |
| Terms | `id:Ref`, `C`, `civil` (exact `YYYY-MM-DDT00:00:00.000+07:00`), `zone` (literal `Asia/Jakarta`), `direction` (literal `legacy-to-generic`), `authorityContract` (literal `5R`), `manifest:Ref`, `manifestDigest:Digest`. Civil conversion must equal C and be Monday. Immutable from preparation onward. |
| Approval | `id:Ref`, `selection:Ref`, `preparedRevision`, `armedRevision`, `terms:Ref`, `termsDigest:Digest`, `manifest:Ref`, `manifestDigest:Digest`, `owner:Ref`, `authorizationDecision:Ref`, `authorizationRevision`, `operation:Ref`, `time:TimeProof`, `commitSequence`. `armedRevision=preparedRevision+1`; owner and authorization references are supplied by owner control, never ingestion credentials or copied claims. Immutable authenticated acceptance of all terms and limitations. |
| Activation | `id:Ref`, `selection:Ref`, `approval:Ref`, `approvalDigest:Digest`, `C`, `A`, `revision`, `operation:Ref`, `time:TimeProof`, `commitSequence`. Unique per approval and selection; A is actual trusted journal commit time, not C or retry time. `A=time.instant`; C exactly equals approved C. |
| Operation | `id:Ref`, `actor:Ref`, `kind` (`initialize/prepare/approve/cancel/discard-prepared/activate`), `expectedRevision`, `selection:Ref`, `termsDigest` (Digest or null), `requestDigest:Digest`, `resultRevision`, `resultDecisionDigest:Digest`, `commitSequence`. Unique account/operation identity; immutable successful outcome only. Canonical request has exactly actor, kind, expectedRevision, selection, termsDigest, plus common format/account/lineage and id. Terms digest null only for initialize; initialize expects revision 0 in an absent root. Actor is an owner-control or authorized activator reference, not a credential. |
| Manifest | `id:Ref`, `scope:Ref[]` (0..256 approved internal site/collector scope refs), `limitations` (closed set below), `evidence:GateEvidence[5]`, `targetPolicy:Ref`, `implementation:Ref`, `configuration:Ref`, `floor:Floor`, `validUntilMs`. Evidence array contains each gate kind exactly once, sorted by kind. All refs are immutable versioned objects, not mutable names. |
| GateEvidence | `kind` (`shadow-reconciliation/consumer-fences/coverage-acceptance/oidc-exclusion/recovery-rehearsal`), `snapshot:Ref`, `digest:Digest`. Snapshot is restricted review evidence, not a new evidence family. |
| GateStatus | `manifest:Ref`, `generation`, `valid:boolean`, `reason` (`validated/revalidated/expired/scope-changed/implementation-changed/configuration-changed/readiness-failed`), `evidence` (five GateEvidence records or null), `time` (TimeProof or null), `validUntilMs` (milliseconds or null), `commitSequence`. Append-only unique manifest/generation; exact successor increments by one. Generation 0 is valid/validated and copies the Manifest evidence/deadline. Revalidated is valid, allowed only after activation under unchanged approved bindings. Valid records require evidence/time/deadline and time.upper < deadline; invalid records have these three fields null. Other reasons require false. |
| Floor | `sqliteVersion`, `controlVersion` (1), `journalVersion` (1), `reader:Ref`, `writer:Ref`, `recovery:Ref`, `clientFence:Ref`, `clockPolicy:Ref`, `ownerPolicy:Ref`. SQLite version must include schema-8 prerequisites plus future control migration. References pin compatible capability sets, not sortable release strings. |
| TimeProof | `instant`, `lower`, `upper`, `epoch:Ref`, `sample:Ref`, `policy:Ref`. All three times use UTC milliseconds; lower ≤ instant ≤ upper. Source sample, freshness, uncertainty and monotonic validation must be proven at the commit point under the pinned clock policy. This is an interface to Stage 5R trusted time, not a clock implementation. |

Manifest `limitations` is a sorted, duplicate-free subset of exactly:
`missing-human-evidence`, `runtime-only`, `unassigned-attribution`, `pending-endpoints`,
`delivery-limits`, `recovery-limits`, `known-loss`, `unknown-capability`, `unknown-synchronization`,
`oidc-disabled`. It must describe the actual approved scope; empty is not proof of completeness.
`oidc-disabled` is required while Stage 5P remains blocked; `runtime-only` also requires
`missing-human-evidence`. Detailed scoped evidence stays behind the five bounded snapshot bindings,
not in free text. Pin validUntilMs explicitly; approval and activation require trusted upper time
strictly below it. Expiry/invalidation after arming blocks activation, never releases its C fence.
Binding a Manifest to Terms requires **Manifest.validUntilMs > Terms.C**; equality leaves no
possible activation instant. Validate this during preparation, approval and recovery (invalid terms
reject a new operation; impossible persisted terms are corrupt/unavailable). A positive window is
necessary, not sufficient: clock uncertainty and actual gates must still permit the final commit.
Manifest expiry is an approval/activation deadline, not a permanent post-activation shutdown.
After activation, current delivery additionally requires the latest GateStatus to be valid with
trusted U < its own validUntilMs and unchanged approved bindings. Failure/expiry suspends affected
delivery but does not change authority. An authorized gate validator may journal a revalidated
GateStatus with five new restricted evidence snapshots and an explicit renewed deadline under the
same approved configuration's freshness policy. Policy/budget must be pinned before implementation.
It must re-prove all five gate kinds against the exact approved scope, limitations, target policy,
implementation, configuration and floor; it cannot change Terms, Manifest, Approval, C or A.
An unchanged deployment may thus recover readiness without another selection or Decision revision.
Changed bindings require separate policy; revalidation cannot bless changed terms. Before activation
an invalid manifest cannot be revalidated: discard a never-approved draft, cancel an armed decision
before C and prepare a new candidate, or remain armed/unavailable after C. An active delivery-readiness
renewal never authorizes another activation.

GateStatus writes use an authorized validator in the same fenced serialization domain, CAS both
the expected latest generation and head, and check the bound decision/state at commit. Exact retry
of the same manifest/generation/content returns the retained status without another write; changed
content at an occupied generation conflicts; skipped/stale generations conflict. Snapshot arrays
have the same five unique sorted kinds as Manifest. Revalidation versus invalidation is serialized:
if invalidation wins first, stale revalidation cannot clear it without new checks against that head.
An invalidation arriving after renewal suspends delivery again. Expiry is checked at release even
without an expired-status write. GateStatus is not an owner approval or an Operation alias.

No root, manifest or approval may be updated in place to edit approved terms. Immutable Decision
history, Operation, Approval and Activation records are retained even after cancellation/replacement.
Foreign-key/uniqueness/append-only constraints can live in SQLite; checks across records and the
journal must also be validated on read/recovery. A writable SQLite flag is not an authorization.

## Initialization, opening and migration

An independently configured account binding locates the witness; do not trust a restored database
to choose its account, witness endpoint, verification key or lineage. The witness maintains a
non-reusable account registration with exactly one lineage, including a terminal retirement fence.
Only separately approved initialization may CAS a **proven never-registered** account to a new
lineage. Absent/unreachable response, deleted local files, empty database or valid schema-8 backup
is not that proof. A missing registered head, invalid signature, unknown key or retired account
blocks opening; no automatic new account/lineage. Account rebinding/reuse is outside this contract.

Initialization fences all old writers, verifies the consistent supported service snapshot (empty
or populated), retains it externally, and commits sequence 0, explicit legacy Decision revision 0,
Root and initialize Operation. Existing rows/receipts/ownership/targets are preserved exactly;
none becomes generic. The genesis snapshot establishes the accepted-write baseline, not a claim
that pre-initialization lost records were recovered. Gate rehearsal must disclose that limitation.
Only this reviewed procedure admits a pre-control database. Reopening it later is restoration,
not initialization. Failure before journal commit leaves no initialized account; commit uncertainty
requires witness lookup, never blindly retrying initialization under a new identity.

Before constructing a write-capable store, inspect schema/control/journal versions and registration
read-only. Refuse future/unknown versions and unsupported floors **before migration or mutation**.
Recognized older versions need a separately reviewed lossless, journaled upgrade on a disposable
copy, consistent backup and retained recovery chain; no downgrade or deletion of unknown fields.
Only after checkpoint reconciliation may compatible SQLite migration/materialization commit its
schema version and data atomically. Migration failure cannot advance the externally committed
upgrade; if the upgrade already committed externally, remain unavailable until its exact local
projection succeeds. Restart reacquires fencing and fresh clock trust, validates the full control
graph and head, and reconciles before serving. Missing/corrupt pointer, dangling refs, duplicate
revision, invalid C, digest mismatch or active-without-approval is unavailable, never explicit legacy.

## Journal and checkpoint: the external guarantee

The external domain supplies authenticated linearizable reads/CAS, durable immutable recovery
objects, monotonically increasing fenced writer tokens, and non-rollbackable account registration
and head. Service-backup replacement, service credentials and SQLite administrator access must not
reset/delete it. Signatures/MACs authenticate content but do not prove freshness: replaying an old
valid signed head must fail a fresh witness read. Keys/trust roots and their rotation continuity
live outside service backups; loss of access or proof blocks delivery. A second file, SQLite WAL,
periodic off-site backup or optional Stage 5Q audit ledger alone does not meet this guarantee.

The exact logical Checkpoint fields are common format/account/lineage plus `sequence`,
`previousDigest:Digest|null` (null only at 0), `writerEpoch`, `decisionRevision`,
`decisionDigest:Digest`, `selection:Ref`, `state` (Decision enum), `approvalDigest:Digest|null`,
`C:null|milliseconds`, `activationDigest:Digest|null`, `acceptedFrontier`, `stateDigest:Digest`,
`recoveryObject:Ref`, `recoveryDigest:Digest`, `floor:Floor`, `commitTime:TimeProof|null`.
Its authenticated envelope adds exactly `key:Ref` and `signature` (base64url, 1..1024 ASCII bytes).
The deployment must pin one signature/MAC algorithm and key policy before implementation; no
caller-selected algorithms. Digest covers canonical checkpoint content excluding signature.
Decision-derived fields must match that revision; C persists in cancelled decisions too, but only
armed/active fences routing. commitTime is required for prepare/approve/cancel/activate and valid
GateStatus creation; otherwise null. It equals the finalized record's TimeProof when one is stored.
Genesis has sequence=acceptedFrontier=0; every later committed transaction increments sequence
by exactly one and sets acceptedFrontier=sequence. It covers **all** accepted service mutations,
not max event sequence, receipt timestamp, row count, or greatest observed source ID.

RecoveryObject is an immutable, versioned, authenticated encrypted **complete recovery image or
exact transactional redo against previousDigest**, durably retained outside replaceable backups.
It covers both authorities' rows and receipts, source/collector order and replay bindings, endpoint
state, coverage, latest synchronization, targets, ownership/token lifecycle/labels/site bindings,
control history/current pointer/idempotency, gate invalidations, and versioned owner authorization,
configuration and compatibility dependencies. Closed existing schemas govern existing data; this
is not an arbitrary new control payload. Native local spools are not copied here: preserve them
separately and never resequence them. A future storage implementation must pin the image/redo codec,
encryption and crash durability before coding; it may not omit an acknowledged mutation family.
StateDigest commits to the canonical full logical state at this sequence, excluding Root's headDigest
and stateDigest and checkpoint/signature themselves (avoids self-reference); includes original receipts and
all current and retained control records. RecoveryDigest commits to the retained recovery bytes.
Neither digest substitutes for recoverable content or a fresh head proof.

Both image and redo payloads omit the **current** checkpoint/envelope and derived Root.headDigest;
that marker is reconstructed from the authenticated enclosing checkpoint at projection. Redo must
not embed an instruction containing the not-yet-computed current checkpoint digest either. The
acyclic construction order is finalized logical records → StateDigest → recovery bytes/digest →
checkpoint digest/signature → derived local head marker. Root.stateDigest can be carried in recovery
bytes after StateDigest is computed; it is excluded only from its own logical hash input. Previous
checkpoint digests may be retained normally. An image with a SQLite container uses this defined
logical projection, not a raw copy containing a circular current marker.

At initialization all mutation entry points, including administration, credential rotation, target
edits, synchronization and migrations, must join this serialization domain or be disabled. Mutable
external owner/configuration state must provide a version fence validated at journal commit; a
denial/config change cannot hide in a separate unsynchronized database. This is an integration
prerequisite, not authorization to modify existing routes here. Snapshot-only report reads do not
advance acceptedFrontier; exact duplicates and rejected requests do not advance it either.

## Commit ordering and exact outcomes

One fenced account writer or equivalent serializable coordinator performs the following protocol.
SQLite immediate transactions protect local projection only; a process mutex or an expiring lease
without a fencing token is insufficient. Final CAS checks the still-current writer epoch and head.

1. Obtain a fresh witness head and verified local projection at that exact head. Authenticate and
   authorize the caller without leaking operation existence to an unauthorized account/actor.
   Validate closed request syntax/version, then look up account/operation identity. An exact
   successful retry returns the original stored result after current authorization, before stale
   revision/time/gate checks. A changed canonical request under that ID is `operation_conflict`.
2. For a new operation, check expected Root revision, allowed transition, immutable terms and
   operation-applicable guards below.
   Build the prospective transaction in isolated staging; never expose it as committed SQLite state.
   Reserve no success on a pending flag. Retain proposed recovery content durably in the external
   domain; uncommitted staging objects have no authority and may later be garbage-collected.
3. At one external serializable commit boundary, revalidate expected head/revision, writer epoch,
   owner authorization version, compatible storage/recovery deployment and operation-applicable
   gate/time guards. The external commit primitive must atomically finalize the transaction, its actual
   commit TimeProof (and A), recovery content, and CAS the checkpoint to the resulting state. This
   is a required transactional interface: assigning a timestamp before a slow upload and later
   calling it actual commit time is not compliant. Recovery content must include these finalized
   outcomes. Atomic journal commit is the selection/data linearization point in Stage 5R.
4. Apply precisely that committed transaction, including Decision history, operation result,
   pointer, data and local head marker, in one durable SQLite transaction. Verify the projection's
   stateDigest. Only then acknowledge success or release authoritative responses from that head.
   Readers never observe staging or mixed revisions. A later head requires reconciliation/revalidation
   at response release; Stage 5R's time/C fence still applies independently of storage consistency.

The external primitive may use a transactional journal instead of physically rewriting a full image.
It must retain sufficient committed redo to reconstruct finalized outcomes. A provider unable to
couple the final checks and durable commit must refuse operations; a two-write best-effort adapter
is not an acceptable implementation. Backend choice and trusted clock mechanics remain deferred.

Guard applicability is explicit: prepare/approve/activate require valid, unexpired gates and
unchanged approved bindings; prepare/approve require U<C, activate requires L≥C. Cancel requires
current owner authorization, expected revision, writer/head fencing and trusted U<C, **regardless
of invalid/expired gates or failed target-consumer readiness**. Storage/recovery compatibility is
still mandatory for cancellation. Initialize uses the separately approved registration/snapshot
guards, not candidate gates. Data mutations retain their own authorization/validation/time rules,
not authority approval gates; recovery consistency remains mandatory for all writes. GateStatus
renewal uses its own guards above. A gate cannot prevent the owner exercising valid pre-C cancellation.

`discard-prepared` separately closes a nonbinding draft, including after its proposed C. It requires
current owner authorization, expected revision, writer/head and compatible recovery fences, exact
selection/terms and proof that **no Approval has ever existed for this selection**. It needs no
candidate gate or C/time guard and writes one cancelled Decision with null approval/activation plus
Operation; history remains intact. This refines Stage 5R's routing-neutral prepared lifecycle, not
its armed cancellation rule. A concurrent approval either wins and makes discard conflict, or loses
to discard's revision CAS. It cannot discard an armed or active selection even before C.

| Transition / race | Exact logical outcome (not HTTP status codes) |
| --- | --- |
| legacy or cancelled → prepared | Owner-authorized new selection identity and immutable future valid C/manifest; one new revision. Prior cancelled candidate/history retained. Prepared → prepared edit is forbidden: discard/cancel draft then create a fresh identity. |
| prepared → armed | Exact prepared revision/terms, current owner approval, all gates valid, trusted U<C; one Approval, Operation and armed Decision in one commit. |
| prepared or armed → cancelled | Current authorized owner, expected revision, trusted U<C; one revision. Retain any Approval. At C, straddling uncertainty or lost clock trust cancellation cannot commit. No replacement of armed without this cancellation. |
| prepared → cancelled by discard-prepared | Authorized CAS with no past/current approval for that identity, before or after proposed C; one revision, retained draft history, no routing change. Replacement still requires new identity and future C. |
| armed → active | Current authorized activator, exact approval/terms, gates valid, trusted L≥C; one Activation and revision with actual A≥C. No evidence transformation. Active and legacy have no cancel transition. |
| Competing activators | After reauthorization, identical approval/terms with the same original armed expected revision returns the one committed Activation, even with a different operation ID. Do not append an alias Operation or revision; its returned canonical operation is the winner's. Changed terms/approval conflict. This sole convergent-success exception follows operation-ID conflict lookup and precedes stale-revision checks. |
| Exact retry after cancellation/replacement | Return that operation's historical committed result, not the current selection, after current authorization; no new revision/time. A revoked caller gets denied even for an exact retry. |
| Stale revision / competing new candidate | `revision_conflict`, no writes; never silently apply to a successor. A different ID with current revision but illegal transition gets `transition_conflict`. |
| Invalid schema or terms | `invalid_request` for malformed/unknown fields or invalid terms (including deadline≤C); `unsupported_version` for a future request format. No writes. Persisted invalid/future state is unavailable instead. |
| Untrusted/straddling time or not-yet-due activation | `time_blocked`; prepare/approve/cancel at or after C gets `boundary_closed`. No successful Operation is stored. Discard-prepared has no C guard. |
| Invalid/expired gate; authorization denial | `gate_blocked` for prepare/approve/activate, or `denied` for unauthorized operations; no decision transition. Gates do not block cancel. Serialized invalidation before activation blocks it; invalidation after activation suspends delivery, not authority. |
| Stale writer/head, busy or capacity | `retryable` only when non-commit is proven; caller must reread state and retain operation identity/terms. A revised request needs a new operation ID. |
| Lost commit response / storage exception | `indeterminate` until fresh head/journal lookup resolves commit; never assert rollback or mint a new operation. If committed, reconcile local projection then return original success. If proven absent, retry the same request through all current guards. |
| Missing/corrupt/future witness or projection | `unavailable`; stop authority delivery and affected writes. Do not acknowledge local-only acceptance. Existing evidence protocols keep their own exact duplicate/conflict/receipt semantics. |

Only successful control operations reserve IDs durably; a definitive rejected attempt may reuse its
ID and is fully revalidated. Thus failed attempts cannot masquerade as owner approvals. An in-flight
indeterminate attempt is not a definitive rejection. Authenticated rejections are fixed outcomes,
not persisted raw requests or exception logs. GateStatus changes advance journal sequence but not
Decision revision. Root head advances for every transaction; changing data does not approve terms.

## Crash, restore, retention and rollback

Crash before external commit leaves the previous decision (armed if activation was attempted),
even if staging exists. Crash after external commit but before SQLite projection/ack leaves the
new decision committed and recoverable; delivery is blocked until projection catches up. Lost ack
does not uncommit approval/activation/data. Witness advancement **precedes every acknowledged
write**; there is no permitted acknowledgement window protected only by an older checkpoint.

Recovery requires separately approved stopped/fenced writers and a retained copy of failed files.
Verify the independent account/lineage registration, fresh witness, keys, floor, recovery content
and backup without opening a migrating service. Compare **both** local head sequence/digest and
full canonical state digest. Under a newly fenced writer, use these cases:

| Local backup versus fresh witness | Required action before serving or accepting writes |
| --- | --- |
| Exact same sequence, digests and valid state | Open only after renewed trust, authorization/deployment fences and compatible floor checks. Equality of sequence alone is insufficient. |
| Older, proven ancestor | Restore exact missing committed transactions through witness acceptedFrontier, including approval, activation, receipts and administrative writes; verify stateDigest. Remain unavailable if any content/key is missing. Never advance the witness backwards. |
| Backup predates initialization | Only the registered genesis plus full retained suffix can establish state. Do not run initialize or regenerate identities. |
| Same sequence/different digest, local ahead, wrong lineage, broken chain | Quarantine as divergent/corrupt; no merge, default legacy or automatic adoption of local writes. A new projection may be rebuilt solely from verified external committed content under separate recovery approval. |
| Witness missing/stale/unverifiable or version/floor unsupported | Fail closed even if SQLite integrity and all backup hashes pass. Do not use a cached checkpoint as current proof. |

Recover the latest committed frontier, not merely the last acknowledgement the client remembers.
An armed approval recovered after C retains the same fence; invalid gates leave it armed/unavailable.
No new C, reapproval, queue resequencing, fabricated closures/loss, or legacy fallback repairs it.
Apply redo as recovery of the original transactions, not fresh ingestion with new receipt times.
Client retries then use original protocol identity/order: duplicates preserve receipt and count;
unseen old orders still reject. New writes remain fenced throughout restoration.

Retain all control history, successful operation identities, approved manifests and their resolved
gate/authorization/clock/floor proofs for the account's lifetime, including cancelled candidates.
No TTL eviction. Version 1 retains genesis, every checkpoint and every committed recovery object;
its deletion floor is genesis. Compaction/deletion of committed recovery objects needs a separately
reviewed versioned retention protocol; no such operation exists here. Existing seven-/thirty-day
backup retention is not permission to delete external committed recovery content. Backup
metadata must bind account/lineage/head/state digest/floor and retain a compatible base plus suffix;
old snapshots can be discarded only when a newer verified complete recovery path remains.

No account deletion or retirement operation is specified/authorized here. A future separately
reviewed deletion policy must stop service and writers and preserve an external non-reusable
retirement fence so an old backup cannot resurrect the account. Until then, no control/checkpoint
deletion or key destruction is allowed. Encryption-key rotation must preserve verification and
decryption of every retained object; destructive rewrapping requires the deferred retention protocol.

Rollback floors are an intersection of required capabilities, not just SQLite version. They may
advance monotonically and cannot discard the armed fence, schema-8 facts, operation deduplication,
owner/gate checks, recovery or client C fences. An old binary that opens SQLite but lacks any floor
capability cannot become a writer or authoritative reader. Pause incompatible consumers/ingestion
as necessary while preserving accepted state and queues. Returning to legacy or selecting a second
cutover needs a new reviewed policy outside Stage 5R/S, never a backup restore or deleted pointer.

## Privacy and implementation boundary

Control/witness state is restricted account-owned security state, distinct from the optional
non-authoritative Stage 5Q audit ledger. No raw native IDs, hostnames, paths, token values, claims,
prompts, bodies or arbitrary metadata enter the new control records. Scope/snapshot/owner refs,
digests, timestamps and precise totals remain sensitive; do not expose them in reports, DOM,
logs or public artifacts. Recovery images necessarily preserve existing restricted service data
(including token hashes and ownership metadata); encrypt and restrict them as backups, never copy
that material into control records or telemetry. Do not newly collect raw credentials or native data.
Only fixed event/outcome categories may be logged by this protocol, without IDs, timestamps,
manifests, payloads, paths, clock samples or exception details. Public review uses synthetic vectors
and sanitized aggregate verdicts. Access revocation does not erase accepted state or cancel approval.

Deferred implementation interfaces are: external journal/CAS/durability and codec/crypto provider;
owner authentication/HTTP/authz version fencing and revocation/CSRF protection; trusted time/sample
policy and atomic commit-time validation; all-mutator serialization integration and SQLite DDL;
actual approval/activation execution; versioned report/API/dashboard/client target routing and
release fencing; compaction/recovery tooling and production provisioning. Stage 5P remains blocked.
No arming is permitted until those mechanisms and all Stage 5R gates are implemented and rehearsed.

## Disposable-storage acceptance vectors

These are independently specified **future tests**, not runtime verification performed by this
documentation slice. Use actual disposable SQLite plus an independently fault-injected journal,
two processes, synthetic owner/clock providers and recovery artifacts. Compare exact rows/receipts,
canonical control graph, root and external head, not merely counts or a mock outcome label. C is
only the Stage 5R synthetic fixture; no date is selected. Times below are offsets in milliseconds.

| Vector | Independent expected result |
| --- | --- |
| Virgin versus missing | Never-registered account plus approved populated schema-8 snapshot initializes legacy revision 0 at sequence 0 with identical rows. Same snapshot with witness already at sequence 9/armed cannot initialize; recover or unavailable. |
| State versus data order | Start root rev 4/head 11; commit legacy seq 7, generic seq 23, target clear: head 14, rev still 4. Exact replay legacy 7 leaves head 14 and receipt unchanged. Changed 7 conflicts; unseen legacy 6 rejects. No max-source frontier of 23. |
| Non-evidence restore | Backup head 14; rotate credential at 15, replace synchronization at 16, invalidate gate at 17. Restore must reach 17 with revoked old credential, exact latest snapshot and invalid gate, despite unchanged event counts. |
| CAS contenders | Two owners prepare from legacy rev 0/head 0 with distinct selection/operation IDs: exactly one rev 1/head 1; loser revision_conflict after reread, no orphan committed terms/manifest. Old expected 0 never approves winner. |
| Clock neighbors | For approve/cancel U=C−1 permits if otherwise valid; U=C rejects; [C−1,C+1] blocks. Activate L=C−1 blocks; L=C permits. Valid sample during staging but expired at journal CAS commits nothing. |
| Manifest window | Deadline C−1 or C rejects preparation/approval even at trusted C−10. Deadline C+1 is logically feasible: zero-uncertainty activation at C may commit; at C+1 it cannot. Recovery of approved deadline≤C is corrupt, not armable. |
| Draft versus armed expiry | Prepared rev 1 without approval at C+9: owner discard creates cancelled rev 2; fresh candidate requires new identity/future C. Armed rev 2 at C+9: discard conflicts and cancel is boundary_closed; no change. Competing approval/discard from prepared rev 1 yields only one rev 2, never both. |
| Cancellation asymmetry | Cancel armed rev 2 at C−1 commits rev 3 cancelled; old activator cannot converge to success. Cancellation first attempted at C fails even if no Activation exists. Replacement needs new identity/future C; old Operation exact retry stays historical. |
| Two activators | Armed rev 2, two IDs with same approval/original expected 2 at C+3 and C+8: one active rev 3, A from winner's actual commit. Loser returns that Activation/A/operation, no alias row. Same winning ID with changed terms conflicts even after active. |
| Commit gaps | Crash after staging before external CAS: unchanged armed. Crash after CAS before local commit: newer external active, no success ack, recovery installs it. Crash after local commit before ack: exact retry preserves A/revision/frontier. |
| Data ack frontier | Accept new evidence then lose SQLite and restore prior snapshot: acknowledged receipt/row must be recovered from journal. External durability failure permits no accepted ack. External commit-response timeout is indeterminate, never permission to resend with a new identity. |
| Race fences | Stale writer epoch cannot CAS even with current revision. Owner denial or gate invalidation committed first prevents activation; activation first survives later denial/invalidation but dependent delivery suspends for invalid gate. |
| Gate expiry after arm | Armed C, validUntil=C+5, downtime until C+9: activation blocked; approval/C unchanged, post-C unavailable. No legacy extension, refreshed manifest edit or second approval bypass. |
| Invalid gates versus cancellation | Invalidate armed manifest at C−10 (or let it expire); authorized owner cancel at C−1 succeeds with retained Approval/history. Same cancellation at C fails. Invalid gate cannot trap a still-pre-C owner. |
| Active readiness repair | Activate at C+2 before manifest deadline C+5; readiness fails at C+3. Delivery stops. Fresh revalidation under the identical approved bindings at C+9 with deadline C+20 restores eligibility; C/A/Decision revision unchanged. Changed configuration cannot be revalidated this way. Stale-generation renewal loses to a newer invalidation. |
| Acyclic image/redo | Independently serialize genesis and an activation as both a marker-free full image and exact redo; hash logical state, then recovery bytes, then checkpoint. Reconstruct Root.headDigest from enclosing checkpoint. Both restore identical logical records and StateDigest without a hash fixed point; byte-level recovery digests may differ between codecs. |
| Integrity versus freshness | Two internally valid backups at heads 5 and 8, fresh witness 8: only 8 can serve directly. Replayed valid signed head 5 is rejected. Same head 8 with changed target or receipt digest fails even when counts match. |
| Future/corrupt | Future logical version, future SQLite version, unsupported floor, missing pointer, truncated approval or wrong account: refuse before migration/writes. Existing bytes remain intact; no legacy initialization. |
| Retention ceiling | Full operation store/counter at max refuses new mutation, exact known retry still returns original authorized outcome. Cancelled operation cannot be pruned or become a fresh candidate on retry. Missing recovery key blocks restore, not just a warning. |
| Privacy/isolation | Sentinel native ID/path/token/body in new control request rejects before writes; no raw rejection logs. Recovery of accepted legacy rows creates zero generic facts; scope refs and proofs never enter public JSON/DOM/logs. |

Stage 5S changes only this document and ROADMAP. Those paths do not match the main-push
[service publication workflow](../.github/workflows/publish-service.yml), so this slice is
publication-neutral; the cumulative prerequisites are not. No runtime/schema/DDL/migration/API/
dashboard/client/collector/config/workflow behavior, production access, database/settings mutation,
selected C, authority activation, push, publication or deployment is authorized or performed.
