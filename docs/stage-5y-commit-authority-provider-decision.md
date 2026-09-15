# Stage 5Y: external commit authority and trusted-time decision

Status: **comparison complete; no provider selected; implementation blocked**. Public provider
documentation reviewed 2026-09-15. This is a bounded evaluation of three credible building blocks,
not a claim that no possible provider can satisfy the contract. No account or resource was inspected.

[Stage 5S](stage-5s-authority-control-storage.md) remains the logical journal contract;
[Stage 5R](stage-5r-authority-activation-contract.md) remains the authority/time contract;
[Stage 5X](stage-5x-owner-project-control-contract.md) remains the owner-control boundary.
None is weakened or implemented here. Stage 5P remains blocked; Stage 5W has no eligible native
source. No date, project mapping, cloud dependency, provisioning or activation is approved.

## Existing mechanisms cannot supply the missing authority

[ServiceStore](../service/store.ts) opens a writable database and migrates before serving, with WAL
and schema ceiling 8. Its mutation surface includes `issueBearer`, `rotateBearer`, `revokeBearer`,
`bindExecutorLabel`, `ingest` (including source ownership and original receipts),
`appendPhysicalCoverage`, delegated shadow evidence/coverage and synchronization writes,
`putTargetOverride`, `clearTargetOverride`, and migrations. Direct token administration is a writer
too. Future owner/configuration/version changes and Stage 5X project writes must join the same
external frontier or be disabled; wrapping only activation or HTTP ingestion misses accepted state.
Exact duplicates/rejections do not advance the frontier. Mapping selectors/proofs must remain in
the restricted authority, with equivalent atomic registry/mapping/capture serialization and
partitioned recovery, not copied into generic service records.

[operations.ts](../service/operations.ts) uses `VACUUM INTO`, integrity checks and SHA-256 metadata;
restore replaces a SQLite file and can remove WAL/SHM. These establish snapshot integrity, not
freshness against a later acknowledged commit. [ADR 0003](adr/0003-off-site-sqlite-backups.md)
and the [runbook](service-operations.md) define verified local snapshots and independent off-site pulls with operator-configured retention.
the prospective journal's zero-loss committed frontier or lifetime retention policy. Introducing a
cloud dependency requires a separate explicit decision and proven credentials/retention/restore;
this comparison neither supersedes ADR 0003 nor introduces B2/object storage.

[Deployment](../config/deploy.service.yml) provides one persistent volume and a half-CPU/256 MiB
service role, not an independent quorum. The [synchronization clock](../service/shadow-synchronization.ts)
defaults to untrusted; its boolean trust plus monotone samples does not expose uncertainty or a
commit-bound proof. Authenticated [`/v1/time`](../service/app.ts) returns the injected clock
(default `Date.now()`); transport authentication does not turn that value into trusted UTC.

## Qualification checklist, unchanged from 5R/5S/5X

These are requirements on the complete deployed authority, not features inferred from an ACID label.

| Obligation | Evidence needed before selection/implementation |
| --- | --- |
| One commit order | Authenticated linearizable head reads and conditional append/CAS; compare current head, writer epoch, revisions, authorization version, applicable gates and floors in the same atomic transaction. An expired lease without a checked fencing token is insufficient. |
| Registration | Independently pinned account binding; atomic never-registered→one-lineage registration; permanent non-reuse/retirement fence, inaccessible to service credentials or SQLite administrators for reset/delete. Missing is not virgin. No retirement operation is introduced. |
| Finalized recovery | Atomically finalize successful request/result/history, actual TimeProof/A, full-state digest, encrypted recovery bytes/digest and authenticated checkpoint/head. Retain genesis and every committed suffix, original receipts, operations, tombstones and keys. Staging may be separate; finalized authority may not be a second write. |
| Freshness and rollback | Fresh authenticated witness independent of disposable SQLite; compare sequence, lineage and full digests. Old ancestor replays exact suffix; local-ahead, same-sequence fork, unknown key/version/floor or missing content quarantines/refuses. Signed old heads alone prove no freshness. |
| Trusted time | Pinned source, UTC/leap policy, bounded [L,U], instant within bounds, sample/policy/epoch, maximum age and uncertainty, monotonic guard and explicit restart/repair revalidation, all valid at actual commit. Prepare/approve/cancel require U<C; activate requires L≥C; applicable gate deadlines require U<deadline. |
| Scope and release | Stage 5X new owner writes, including labels/archive/revoke, require commit proof. Preserve 5S's operation-specific exceptions (e.g. discard-prepared has no C/time guard). Historical authorized retries need no new mutation time, but reads/retries still need verifiable authentication/witness freshness and final release fencing. |
| Bounded refusal | Finite caller deadlines, bounded requests/retries/capacity, no stale success. Timeout after possible commit is indeterminate; fence delayed attempts and resolve the original operation at a fresh head before claiming absence. No offline/local-only acknowledged acceptance. |

TimeProof remains exactly Stage 5S's format, not a new wire API. Millisecond conversion must conservatively
enclose provider uncertainty (lower rounded down, upper up), preserve `lower≤instant≤upper`, and
never round an unsafe boundary into permission. No uncertainty budget, sample age or epoch policy is
invented here. Unspecified remains untrusted. A complete future proposal must also implement 5R's
trusted-as-of and client/server release fences; database consistency does not prevent C crossing
between calculation and response release.

## Three candidates and their time pairings

“Possible building block” below means an application could model that property; it is not a
guarantee that the provider enforces Cukup's journal, append-only policy or owner authorization.

| Candidate | Publicly supported storage primitive | Time pairing and decisive gap | Operational/cost boundary |
| --- | --- | --- | --- |
| Managed Google Cloud Spanner, serializable isolation and strong reads | External consistency; multi-row atomic transactions can serialize head/epoch/registration and retained journal rows. IAM-authenticated access. | Native TrueTime-derived commit timestamp is real, but reviewed APIs do not establish commit-time interval/epoch/freshness predicates plus finalized encrypted/digested recovery in that same commit. **Not selected.** | Managed replication avoids running a quorum on the VPS. Paid instance compute, retained database/index data, backups and network charges; edition/region/capacity and budget need owner approval. No free-trial durability assumption. |
| Single-Region DynamoDB transactions, strong head reads/transactional reads | Conditional writes with serializable transactions; head/epoch and operation rows can participate. SigV4/IAM. Exclude eventual reads, caches and cross-Region transaction assumptions. | EC2 Amazon Time Sync + ClockBound gives host error-bound information, not a DynamoDB-assigned commit proof or server-evaluated UTC guard. A sampled client value is stale-able during RPC/commit. **Not selected.** | Request/capacity charging plus storage/backups, transaction overhead and an additional supported EC2 time host; operationally smaller than self-hosted consensus, but not free or compatible with the current VPS by assertion. |
| Separately operated etcd v3.6 quorum, linearizable KV Txn | Durable strict-serializable KV transactions and revisions; compare head/epoch and append keys atomically. Pinned client/peer TLS and authorization required. Watch and `serializable` stale-read mode are not fresh witnesses. | Same EC2 ClockBound option only if deployed on eligible hosts; stock Txn has no demonstrated commit-time UTC proof/predicate interface. Revision is logical order, lease TTL is not UTC proof. **Not selected.** | Quorum hosts/disks/network, certificates, monitoring, upgrades, backups, time validation and on-call become owner responsibilities. Three independent voters is a candidate topology, not a configured service or availability claim. Lifetime journal growth is a poor fit for small metadata-store quotas. |

### Spanner is closest, but a timestamp column does not close the protocol

Google's [external consistency guarantee][g-consistency] explicitly includes linearizability for
serializable transactions. Do not choose repeatable-read isolation or stale reads for this contract.
Its [commit timestamp documentation][g-time] says the timestamp is assigned at commit and atomically
stored via a placeholder; after `PENDING_COMMIT_TIMESTAMP`, the table and derived indexes cannot
be read by subsequent statements in the transaction. It also explicitly says `CURRENT_TIMESTAMP`
is not based on TrueTime and cannot be used to compare with a commit timestamp.

The unresolved question is **which supported commit primitive can evaluate U<C/L≥C and expiry at
that final instant, expose retained sample/epoch/uncertainty evidence, and finalize the 5S acyclic
records→state digest→encrypted recovery→checkpoint construction atomically?** The reviewed pages
do not establish one. TrueTime's internal uncertainty management is not a documented client
TimeProof interface. Reading the committed timestamp and signing or filling recovery in a later
transaction introduces the prohibited gap. Checking a host clock before commit or rejecting a
success afterward cannot uncommit an approval that crossed C. This is not a claim that Spanner
lacks external consistency or real commit timestamps; those guarantees alone are insufficient.

[Authentication/IAM][g-auth] can separate runtime and administration, but does not itself implement
non-reusable registration or constrain every writer to the journal protocol. A restricted committing
authority, outside the SQLite administrator/service reset boundary, and enforced privileges need
review. Ordinary mutable tables are not provider-enforced immutable records. [Backups][g-backup]
are consistent at their version time and retained up to one year; that is not lifetime genesis
history. Retained append-only application rows and protected trust roots must survive recovery;
an older restored database must not become the witness by merely changing an endpoint. CMEK backup
key versions remain fixed at creation and must stay decryptable after rotation. [Limits][g-limits]
include 100 MiB commits and 80,000 mutations including indexes; complete recovery/genesis sizing
still needs proof, not an assumption that the control-record bound covers all service data.

### DynamoDB provides useful CAS, not commit-time UTC evaluation

[Transactions][a-txn] support 100 distinct items/4 MB per transaction, with 400 KB item limits and
conditions; head updates must carry their own conditions, not a second action on the same item.
These limits leave no automatic room for Stage 5S's maximum control bytes plus recovery content.
Chunked immutable staging is conceivable but does not solve finalized-time content atomicity.
Strong single-item reads or `TransactGetItems` are required as appropriate; Query/Scan are not
multi-item transaction snapshots. Lifetime operation rows must be retained explicitly: the native
idempotency token lasts only ten minutes. Streams may interleave transaction records, and backup
propagation can be partial for recent transactions; neither can replace the committed journal.
The evaluated profile is single-Region, not global-table failover or an inferred cross-Region ACID
guarantee. [IAM/SigV4][a-auth] authenticates access, not append-only semantics or version-fenced owner
revocation. A conditional create only proves absence in the current table, not never-registration
after deletion/restore. Protected registration/history and independent endpoint/key continuity remain
unproven deployment gates. [PITR][a-pitr]'s 1–35 day recovery window is not lifetime history.

[ClockBound documentation][a-clock] describes EC2 Linux clock accuracy and explicitly requires
adding the PTP hardware error bound; chrony alone underestimates it. [Time Sync][a-time] distinguishes
smeared NTP from unsmeared PTP during leap seconds. Neither supplies a proof bound to DynamoDB's
actual commit or a condition function evaluating that time. Even a perfectly authenticated sample
can expire while a request waits. Bracketing a response with two samples is post-commit evidence,
not an atomic pre-C refusal mechanism. No EC2 credentials, time host or library is installed here.

### etcd needs more than a lease, revision and recoverable snapshot

[KV guarantees][e-guarantees] support durable strict serializability, but explicitly exclude watches
from linearizability and allow uncertain outcomes after timeouts/leader elections. A fencing epoch
must be compared inside every Txn, not inferred from lease ownership. [TLS][e-security] supports
authenticated peers/clients; automatic self-signed transport alone does not authenticate identity.
An authority must enforce append-only keys and deny runtime deletion/rewrites/registration reset;
raw write permission is not that enforcement. Default [limits][e-limits] are 1.5 MiB requests and
2 GiB storage (8 GiB suggested maximum), below a general all-history recovery design's needs.
MVCC history is compactable; separately retained journal keys would still consume quota.

[Restore documentation][e-restore] explicitly permits older revisions and creates a new logical
cluster. Bumping revision and marking compacted invalidates watchers; it cannot recover missing
committed outcomes or prove the new cluster is the old registered lineage's latest head. Separate
non-resettable registration/freshness continuity is still required. Stock etcd with an external
clock sample also leaves no demonstrated atomic hook for finalized commit-time predicates/content;
adding a custom consensus/time authority would be a new system to specify and prove, not an adapter
licensed by this decision.

## Rejected shortcuts and availability limits

- SQLite/WAL, another volume on the same VPS, local mutexes and SSH snapshots do not witness every
  external committed write. Hashes/signatures on an old snapshot do not prove current head.
- SQLite then remote checkpoint, or remote CAS then authoritative timestamp/recovery write, is a
  two-write adapter. Uploading uncommitted staging first is permitted only when the final primitive
  atomically commits all finalized content and guards. Never acknowledge on staging.
- Wall clock, HTTP Date, OAuth expiry, receipt time, `/v1/time`, `precision_ms`, logical revisions,
  lease TTL and a time-server sample before upload do not establish the required commit TimeProof.
- Merely eventual or object-versioned storage does not establish a linearizable guarded multi-record
  commit. Even strong object CAS/retention alone supplies neither atomic time predicates nor all
  finalized recovery content. Object storage is not categorically eventual; its actual guarantees
  must be proven if ever proposed, under ADR 0003's separate approval gate.

None of these providers' consistency claims is a hard maximum successful commit latency. A
partition, unavailable quorum, authentication failure, throttling, capacity exhaustion or lost
time trust must stop affected writes/delivery. A future profile must pin finite RPC/retry/response
budgets and classify non-commit versus indeterminate using documented error semantics and delayed-
attempt fencing; client timeout is not server cancellation. Rehearse stopped writers and fresh-head
resolution, not automatic fallback to SQLite or an old replica. The existing backup RPO/RTO and a
provider availability SLA cannot be relabeled as this protocol's recovery/latency guarantees.

## Evidence required to reopen selection

1. **Provider/interface evidence:** supported API/specification and concrete transaction trace
   showing final commit-time interval/epoch/freshness validation and atomic finalized recovery,
   including late commit, lost response, cancellation and gate expiry. Prefer clarifying Spanner's
   precise gap first; this is research priority, not selection. If impossible, a change to 5R/5S
   needs a separately reviewed decision, not silent weakening in an implementation.
2. **Owner trust boundary:** explicitly approve any new provider/dependency and budget; identify
   independent registration/key custody and who can administer/delete/restore each domain. Prove
   service credentials and SQLite administrators cannot reset lineage/head or bypass guarded
   writes; do not claim resistance to all-powerful provider administrators without evidence.
3. **Credentials/provisioning:** separately authorize resource creation, private pinned endpoints,
   workload credentials, least privileges, key/session rotation and denial propagation. IAM changes
   alone are not serialized owner revocation. No account/resource identifiers or secrets belong here.
4. **Retention/version/recovery:** pin codec, encryption/authentication algorithms and key policy,
   immutable genesis/suffix retention with deletion floor genesis and no TTL, permanent operation
   identities/tombstones, floor compatibility and protected registration continuity across provider
   restore. Rotation must retain all verification/decryption keys. No deletion/destructive rewrap
   without the deferred versioned retention protocol. Bound growth before exhaustion; no eviction.
5. **Integration and rehearsals:** inventory/fence every mutator before initialization; prove atomic
   restricted mapping/registry/capture and authorization participation. Rehearse two stale writers,
   U=C−1 versus U=C, L=C−1 versus L=C, sample expiry during staging, denial/gate invalidation races,
   delayed commits, crash before/after journal commit and before SQLite projection, lost acknowledgments,
   older/forked/local-ahead backups, missing keys/content, capacity/future floors and restart epochs.
   Verify exact rows/receipts/results and full digests, not counts or success labels.
6. **Cost and operations:** obtain a region/edition/capacity-specific quote using [Spanner pricing][g-price]
   or the DynamoDB transaction charging model (two underlying reads/writes per item, retries also
   consume capacity), plus retained bytes, backups, egress, key management and any time/authority
   hosts. For etcd budget quorum hardware and operator labor. Pin alerts, owner response and a
   demonstrated recovery objective. No price ceiling or purchase is accepted by this slice.

These are future approval/evidence gates, not instructions to provision now. Public documentation
supports a useful shortlist but not a compliant pair. Implementation/provider blockers remain even
when this documentation review passes. No TypeScript, schema, API, configuration, workflow,
infrastructure, shared settings, production access, push, publication, deployment or activation
changes are included. Only this document and ROADMAP change; neither matches the main-push
[service publication paths](../.github/workflows/publish-service.yml). Cumulative prerequisites
include service changes and remain publication-sensitive, with schema-8-aware recovery/rollback
requirements. Documentation-only publication neutrality does not authorize publishing the baseline.

[g-consistency]: https://docs.cloud.google.com/spanner/docs/true-time-external-consistency
[g-time]: https://docs.cloud.google.com/spanner/docs/commit-timestamp
[g-auth]: https://docs.cloud.google.com/spanner/docs/authentication
[g-backup]: https://docs.cloud.google.com/spanner/docs/backup
[g-limits]: https://docs.cloud.google.com/spanner/quotas
[g-price]: https://cloud.google.com/spanner/pricing
[a-txn]: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html
[a-auth]: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/security-iam.html
[a-pitr]: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Point-in-time-recovery.html
[a-clock]: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/compare-timestamps-with-clockbound.html
[a-time]: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/set-time.html
[e-guarantees]: https://etcd.io/docs/v3.6/learning/api_guarantees/
[e-security]: https://etcd.io/docs/v3.6/op-guide/security/
[e-limits]: https://etcd.io/docs/v3.6/dev-guide/limit/
[e-restore]: https://etcd.io/docs/v3.6/op-guide/recovery/
