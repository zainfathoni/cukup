# Issue #9: Spanner qualification, not provider selection

Research date: 2026-09-15. **NO-GO for selecting stock managed Spanner under the
unchanged Stage 5R/5S/5X contract.** Continue only targeted API clarification;
provisioning is not the next step. This is a documentation-only decision-preparation
outcome, not an implementation or proof that no possible provider can qualify.

## Baseline and scope

[Issue #9](https://github.com/zainfathoni/cukup/issues/9) and
[PR #16](https://github.com/zainfathoni/cukup/pull/16) were read live. PR #16 was OPEN,
not merged. The local checkout is main and lacks the Stage 5 contract documents.
The four documents were therefore read through GitHub's contents API at the PR's
[pinned head](https://github.com/zainfathoni/cukup/commit/ef8fd9205ad74c01bfe1118cf874ffd7a12591c4):
`docs/stage-5r-authority-activation-contract.md`,
`docs/stage-5s-authority-control-storage.md`,
`docs/stage-5x-owner-project-control-contract.md`, and
`docs/stage-5y-commit-authority-provider-decision.md`.
No assumption that these contracts are already on main or implemented is made.

No provider authentication, account inspection, provisioning, purchase, cloud
mutation, deployment, GitHub edit, push, merge, or commit was performed.
All provider evidence below is public documentation or an unauthenticated API
description. The three GitHub references were verified via the existing GitHub
API access (their unauthenticated web URLs return 404). Public provider links
were fetched live; the mistaken `/point-in-time-recovery` URL
returned 404 and was replaced with the working `/pitr` citation.

## Requirement-to-evidence matrix

**G** = provider-documented primitive, **P** = application protocol still requiring
implementation/rehearsal, **B** = selection blocker. A G does not qualify the whole row.

| Required primitive | Documented guarantee | Concrete design and remaining gap | Verdict |
| --- | --- | --- | --- |
| Linearizable head; atomic head/revision/epoch/auth/gate/floor predicates | Serializable transactions are externally consistent; reads and writes in a successful writing transaction reflect its commit timestamp [1,2]. | One database, account head row, immutable sequence rows; read every predicate and conditionally advance head in the same transaction. No repeatable-read, stale reads, partitioned DML, blind mutations, or separate auth lookup. Application writer epochs are feasible, not a native clock epoch. | G + P |
| Actual commit time with bounded interval, sample, policy and trust epoch | Commit timestamp is assigned at commit, atomically stored, microsecond granularity [3]. | Useful actual database timestamp, not documented `TimeProof{instant,lower,upper,epoch,sample,policy}`. No published per-commit UTC uncertainty interval, sample-age predicate or repair epoch in reviewed commit API/discovery [4,5]. Do not set lower=upper merely because a timestamp exists. | B |
| Atomic U<C, L≥C, U<deadline and sample-expiry checks | Pending timestamp is a column placeholder, not a scalar expression [6]. CHECK cannot reference commit-timestamp columns; generated columns cannot reference them [7,8]. | Cannot implement `CHECK(commit_ts < C)` or compute proof/digest from pending timestamp. `CURRENT_TIMESTAMP` is not TrueTime [3]. `maxCommitDelay` controls optional batching delay, not latest permissible UTC commit [4,5]. A client timeout is not an atomic deadline guard [9]. | B |
| Finalized history/result, full StateDigest, encrypted recovery bytes/RecoveryDigest and authenticated checkpoint in one commit | Multi-table atomic writes and timestamp substitution are supported [2,3]. | Application can precompute arbitrary supplied bytes, but not bytes that include the unknown final timestamp/proof. Required order is finalized records → state digest → encrypted redo/digest → checkpoint/MAC. Pending timestamp cannot feed these expressions [6–8]; no equivalent finalization hook appears in [4,5]. Post-commit signing/filling is a prohibited second write. | B |
| Never-registered → one lineage; non-reusable permanent identity/head | Transactional absence checks; FGAC explicitly supports SELECT/INSERT-only ledgers [2,10]. | Independently pinned account→database/lineage; initialization-only registration insert, permanent retained identity, no runtime reset/delete. Service/SQLite administrators receive no raw authority write credentials. Trusted authority alone advances head under protocol. Mutable head UPDATE privilege does not enforce monotonicity by itself. Admin/restore custody and lifetime continuity remain unproved. | G + P |
| Protection across deletion/restore | Restore creates a new database, never overwrites an existing one [11]. Drop protection can prevent accidental database deletion [12]. | Pin live witness independently of SQLite; restored DB is only a candidate projection, never automatically the authority. Drop protection is mutable, absent on restored DBs and does not stop project deletion [12]. No native irreversible registration fence established against cloud admins. Contract requires protection against service credentials/SQLite admins, not all-powerful Google/project admins; owner must approve that boundary. | P; approval blocker |
| Fresh authenticated head and final release/current-use fence | Strong reads include commits completed before the read starts [1,2]; IAM authentication supported [13]. | Strong head + consistent content snapshot + verified projection is a useful witness. It does not freeze state until HTTP release, prove bounded age after a stalled RPC, or provide trusted current UTC. Read-only transactions don't block writers; even read-write transactions with no writes don't validate unchanged data through commit [2]. Release coordination, bounded fresh read, client validity and clock trust remain unproved. | G + B |
| Owner revocation and restricted registry/mapping/capture order | Transactions span tables, **not databases** [2]; FGAC separates table/column privileges [10]. IAM access changes are eventually consistent [14]. | Separate logical tables/encryption domains in one database under a restricted authority could preserve one order without exposing selectors to service. Separate databases/HTTP lookups cannot claim atomicity. Owner denial version must be transaction data, not IAM propagation. Privacy, partitioned recovery and final release design still need review. | G + P |
| Lifetime genesis/suffix/results/tombstones/keys | Live ledger rows can be INSERT-only [10]; MVCC history defaults to 1 hour, PITR max 7 days [15]; backups max 1 year [16,17]. | Keep genesis and all committed redo/checkpoints as current append-only rows without TTL, not old MVCC versions. Keep all crypto/codec versions, original receipts, successful IDs and retirement fences. Unlimited growth requires budget/capacity policy; neither PITR nor backup expiry licenses pruning. | G + P |
| Exact recovery without silent accepted-write loss | Backup is consistent at versionTime, excludes subsequent changes, IAM policies and change-stream data [16]. Restore requires original CMEK key/version [11]. | Recover older SQLite from live authority's entire exact suffix. A cloud backup alone cannot reconstruct writes after versionTime. If live suffix is unavailable, refuse; do not rename/repin old backup as fresh witness. Database roles restore but IAM grants do not [10,11]. No demonstrated total-authority-loss recovery with zero loss. | G + P; recovery blocker |
| Bounded refusal, retries and delayed-attempt resolution | ABORTED permits whole-transaction retry; UNKNOWN requires reading current state; single-use commits can duplicate [4]. Deadline errors can accompany successful writes [9]. | Retain operation ID/request; unknown means indeterminate. Resolver transaction advances writer fence and reads outcome against same head: earlier pending commit must serialize before fence or fail its old-epoch predicate. Journal fence changes too. Pin retry budgets and prove all delayed attempts check epoch. No new ID on timeout. | G + P |
| Capacity, failure, restart and release rehearsal | 100 MiB commit, 80,000 mutations including indexes, 10 MiB cell [17]; small PU instances have latency caveats [18]. Regional replication survives one-zone failure [19]. | Account head serializes all writes and may bottleneck. Bound encrypted redo/chunks/index overhead, genesis size and state-digest computation, not just 4 MiB control records. Provider availability is not a maximum response latency. Rehearsals below remain unexecuted. | G + P |

Preserve operation-specific guards: cancel needs pre-C time but not valid gates;
discard-prepared needs proof of no prior approval but no C/time guard. Historical
authorized retries need no new mutation time, while all new 5X owner writes do.
Reads/retries still require authentication, witness freshness and release fencing.

## Exact API boundary and failed transaction trace

The candidate consumer would use authenticated `sessions.beginTransaction` with
explicit SERIALIZABLE, transactional reads/SQL for registration/head/epochs,
authorization/gates/floors and operation lookup, followed by `sessions.commit`
using the returned transaction ID [2,4]. Strong read-only transactions supply a
consistent witness/content snapshot. This is a candidate mapping, not a new Cukup
wire schema and not a working `commitFinalized` implementation.

The live discovery document [5] exposes these CommitRequest fields:
`transactionId`, `singleUseTransaction`, `mutations`, `returnCommitStats`,
`maxCommitDelay`, `requestOptions`, `precommitToken`. CommitResponse includes
`commitTimestamp`, `commitStats`, `precommitToken`, `isolationLevel`,
`readLockMode`, `snapshotTimestamp`. The live schema is richer than the rendered
REST page, but neither supplies interval/sample/epoch proof or commit-time
predicate/finalizer. `precommitToken` is a multiplexed-session retry token, not
a reservation of UTC commit time; a response containing it means not committed.

Attempt: at C−2 ms, authorize and read all database predicates. Stage approval,
redo and checkpoint using a fresh client sample. Submit commit, delayed until
C+3 ms with no intervening database writes. Serializable storage predicates can
still hold. There is no demonstrated server guard that rejects the now-late
approval. Timestamp substitution records C+3 but cannot fix the precomputed
proof/digests or uncommit the approval. A second transaction rejecting or
completing it breaks the one-boundary contract. Checking after response is too late.

Even with a hypothetical zero-uncertainty commit timestamp, [6] rules out using
`PENDING_COMMIT_TIMESTAMP()` in SELECT or as input to **any scalar expression**.
[7] says: “The expression can't reference columns that have set the
`allow_commit_timestamp` option.” [8] says that option “isn't allowed on generated
columns or any columns that generated columns reference.” These are explicit
restrictions, not an inference from missing examples.

Storing a fixed redo program containing a future timestamp placeholder, then
deriving finalized state/signature only during recovery, would change 5S's
retained finalized-content/digest/checkpoint contract. An external timestamp
reservation or externally coordinated finalization system likewise needs its own
supported proof; it is not supplied by a normal Spanner transaction callback.

## Remaining unknowns that can change the decision

1. **Provider API:** Is there a supported API beyond [4,5] that exposes an
   actual-commit UTC interval/proof, evaluates both strict upper deadlines and
   lower activation bounds plus freshness/epoch predicates, and permits the whole
   finalized crypto/content construction atomically? Request exact versioned API,
   guarantee and delayed-commit trace before buying a proof environment. No such
   capability was established; the ordinary SQL routes above are explicitly barred.
2. **Time semantics:** Pin the relationship of database commit timestamp to the
   contract's A, UTC/leap policy, interval uncertainty, sample max age, monotonic
   validation and restart/repair epoch. The documented 20-hour leap smear belongs
   to CURRENT_TIMESTAMP [6]; do not infer that it specifies an exported TrueTime
   interval or supplies the contract's leap policy. Millisecond rounding must
   enclose the actual interval; precision is not uncertainty.
3. **Release:** Specify final authorization/head/time linearization without relying
   on Spanner locks for external HTTP resources (expressly cautioned against [2]).
   Prove stalled reader/writer failover, denial before release, C crossing and
   client validity. Do not add journal writes to read-only paths to hide this gap.
4. **Trust/recovery:** Identify independent registration/trust-root custody,
   authority administrator and reset permissions; recoverability after total
   journal loss; no service-controlled endpoint rebinding; supported floors and
   all encryption/MAC key versions. Prove rather than assume cloud restore continuity.
5. **Scope/capacity:** Inventory every accepted mutator including token admin,
   synchronization, mappings and migrations. Specify one-database privacy boundary,
   codec, initial data size, bytes/write, full-state hashing cost and sustained
   account-serialized throughput. No production size or quota was inspected.

## Smallest safe proof and rehearsal plan

**Stop gate 0, now:** use public API/SQL documentation and the local reasoning
checks below. They suffice to reject the ordinary design, not to qualify Spanner.
No cloud credentials or emulator are necessary to establish the published SQL
restrictions. Do not build a full adapter while the finalization primitive is missing.

The following credential-free Python check is executable as-is. It demonstrates
the precheck/commit gap and conservative integer conversion, not Spanner behavior:

```python
from itertools import product

# Synthetic C=1000 ms; offsets, not a selected cutover or live clock.
C = 1000
bad = [(s, a) for s, a in product(range(997, 1004), repeat=2)
       if s <= a and s < C and not a < C]
assert len(bad) == 12 and (998, 1003) in bad
assert [(u < C) for u in (999, 1000, 1001)] == [True, False, False]
assert [(l >= C) for l in (999, 1000, 1001)] == [False, True, True]
# The straddling interval [999,1001] allows neither operation.
assert not (1001 < C) and not (999 >= C)
for lower_us, upper_us, expected in (
    (998001, 999999, (998, 1000)),
    (1000000, 1000000, (1000, 1000)),
    (1000001, 1001999, (1000, 1002)),
):
    enclosing = (lower_us // 1000, (upper_us + 999) // 1000)
    assert enclosing == expected
# Truncating 999999us to 999ms would wrongly grant upper<C;
# conservative upper=1000ms refuses. This assumes bounds already proved.
print("PASS: 12 late-commit counterexamples; boundary and enclosure vectors")
```

**Gate 1, only if API evidence changes:** a loopback-only pinned emulator may
check SQL acceptance/rejection and transaction/redo plumbing. Use synthetic rows,
no ADC or cloud CLI login, no production endpoints. Expected rejected probes:
CHECK referencing commit_ts, generated column referencing commit_ts, scalar use
of pending timestamp, read-after-pending. A successful timestamp column write is
the positive control. Emulator state is in-memory, lacks IAM/TLS/roles/drop
protection and differs in locking/performance [20]; it cannot prove TrueTime,
durability, access isolation or actual capacity. Emulator was not run in this task.

**Gate 2, separate scoped owner approval:** only a demonstrated replacement for
the missing primitive justifies a disposable paid cloud rehearsal. Pin SDK/API,
codec/crypto, clock/freshness and finite request/retry/release budgets beforehand.
Implement a runnable harness with two independent writer processes, real disposable
SQLite projections, a controllable RPC delay/drop proxy and an independent decoder.
Run the following cases against the exact candidate API; do not synthesize provider
TimeProofs or infer internal Google clock faults from skewing the client machine.

| Fault/input | Independently required outcome |
| --- | --- |
| Competing head 11/revision 4 writers; epoch 7 vs fenced 8 | One permitted head successor; stale epoch cannot commit even with correct revision. No loser operation/history rows. |
| Approve/cancel U=C−1 vs U=C; activate L=C−1 vs L=C | First pre-C case may commit, equality rejects; activation blocked before and eligible at equality. Straddling interval permits neither. |
| Valid sample at staging; expire before commit; deadline C+1 and commit C+1 | No successful transition or operation. Test delay at RPC, retry and finalization stages. |
| Lost response; resolver fences epoch while delayed attempt continues | Resolve exact original outcome if commit won, otherwise delayed old attempt cannot later commit. Missing lookup alone never proves absence. |
| Crash before journal / after journal / after SQLite before ack | Respectively old state / recover exact committed suffix / original idempotent result. Preserve original A, receipts, IDs and full digests. |
| Owner denial or gate invalidation before versus after activation | Earlier denial/invalidation prevents commit; later invalidation suspends delivery, does not erase activation. Cancellation before C remains possible with invalid gates. |
| Strong read stalls while denial/head changes or C crosses before release | Revalidate/recompute or unavailable; never stale current success. Delayed old client response cannot restore pre-C progress. |
| Restore at head 5, live head 8; same-sequence fork; local-ahead | Exact suffix through 8 or refusal; forks/ahead quarantined. Credential rotations and target changes restored, not just counts. |
| Cloud backup predates head; missing journal/key; endpoint points to restored DB | No silent authority adoption, no reinitialization. Explicitly test IAM/drop-protection restoration and registration pinning separately. |
| At and beyond application byte/counter limits; retries at capacity | Bound new commits without truncation/eviction; original authorized retries intact. Measure encrypted bytes, cell sizes, mutation/index cost and account-head contention. |
| Transport partition, capacity exhaustion, expired credentials, process restart/skew | Finite unavailable/indeterminate, no SQLite fallback; new epoch/time trust required. Provider-internal time-loss guarantees require provider evidence, not emulator claims. |

Recovery verification compares canonical logical content, original receipts and
results, both digests, genesis and every suffix, not a green status or row count.
Provider-managed regional failover/clock faults must use an approved supported
method or remain explicitly untested; client partitions are not region-loss tests.

## Owner decisions before any credentials or spend

| Decision | Approval material needed |
| --- | --- |
| Provider/deployment | Accept new dependency and isolated authority hosting, administrator trust boundary, allowed failure mode and recovery objectives. No activation date is selected. |
| Region/edition | Compare `regional-asia-southeast2` Jakarta with `regional-asia-southeast1` Singapore [19], based on real service location, residency and latency, not user's timezone alone. Regional is three zones, not regional-disaster failover. Multi-region requires Enterprise Plus and exact approved placement; do not invent a Jakarta/Singapore dual-region. |
| Capacity and money | Approve bounded paid rehearsal and separate recurring ceiling. Minimum granular capacity is 100 PU; 1000 PU=1 node; no suspend [18]. Compute bills at least one hour, completed backup at least 24 hours [21]. Include authority compute, growing ledger/index/MVCC storage, backup copies, replication/egress, keys, logs and recovery spare capacity. No CUD/free-trial assumption; free trial lacks backup/restore and SLA [17]. |
| Price quote | Public pricing page default is Iowa, **not Jakarta**: Standard $0.90/node-hour, hence illustrative 100 PU × 730 hours = $65.70 compute only [21]. Do not present this as a Jakarta/Singapore quote. Get exact selected regional SKU/currency/tax and retained-byte estimates before approval. Formula: hours × PU/1000 × regional node rate + all storage/backup/network/key/host costs. |
| Retention and keys | Lifetime no-TTL genesis/suffix/results/tombstones; delete floor genesis. Pin encrypted image/redo and MAC/signature algorithms, verification/decryption key custody and all versions. CMEK backups retain original key version after rotation [16]; CMEK alone is not the application's authenticated encrypted RecoveryObject. No destructive key rotation or retention reduction. |
| Credentials/access | Prefer workload federation for external hosting [13], only with a separately verified workload identity. Do not reuse the blocked collector OIDC design by assertion. Approve runtime/authority/initializer/recovery/admin identities and privileges; no owner/editor/database-wide bypass grants to runtime. Deny reset/delete/DDL/restore/project/key administration; test inherited grants too [10,12,14]. |
| Recovery/release | Approve fencing/stopped-writer procedure, preserved failed copies and independent trust configuration, compatible binary/codec floors, freshness/uncertainty and response budgets, monitoring and operator ownership. Backup RPO is not authority RPO; missing suffix means unavailable, never accepted-write loss hidden as success. |

## Recommendation and minimum capability still missing

**Do not select Spanner.** Stock Spanner qualifies the storage/ordering substrate,
not the required complete authority. Selection can reopen only with a supported
atomic interface that both (a) evaluates final-time interval/freshness/epoch and
boundary predicates and (b) binds that final proof into the retained finalized
records, full state digest, encrypted recovery and authenticated head in the same
durable decision. Lifetime protected identity/recovery and final release remain
independent qualification gates even if that interface appears.

Stage 5Y's DynamoDB+ClockBound and stock etcd+ClockBound candidates do not merit
another generic comparison now: the supplied baseline already identifies the same
missing commit-time hook. No new guarantees for them were established here. A
provider offering a documented programmable final-time guarded commit could merit
targeted research; a custom consensus/time authority is a new system, not a cheap
adapter. Changing 5R/5S to permit post-commit derivation/two-step finalization would
require a separately reviewed contract decision, never an implementation shortcut.

## Exact public citations

All numbered URLs below were verified with live GET requests on the research date.
Section names identify the relevant evidence without depending on changing line numbers.

1. https://docs.cloud.google.com/spanner/docs/true-time-external-consistency — External consistency; strong-read FAQ.
2. https://docs.cloud.google.com/spanner/docs/transactions — Transaction types; successful serializable reads/writes; read-only operations; external-resource locks; durability.
3. https://docs.cloud.google.com/spanner/docs/commit-timestamp — Overview; pending timestamp; providing your own value/CURRENT_TIMESTAMP caveat.
4. https://docs.cloud.google.com/spanner/docs/reference/rest/v1/projects.instances.databases.sessions/commit — Entire request/response; ABORTED/UNKNOWN; single-use non-idempotency.
5. https://spanner.googleapis.com/$discovery/rest?version=v1 — CommitRequest, CommitResponse, RequestOptions, TransactionOptions, Mutation schemas.
6. https://docs.cloud.google.com/spanner/docs/reference/standard-sql/timestamp_functions — PENDING_COMMIT_TIMESTAMP restrictions; CURRENT_TIMESTAMP smear; UNIX_MILLIS truncation.
7. https://docs.cloud.google.com/spanner/docs/check-constraint/how-to — Add a check constraint, expression restrictions.
8. https://docs.cloud.google.com/spanner/docs/generated-column/how-to — Add a generated column, commit-timestamp restrictions.
9. https://docs.cloud.google.com/spanner/docs/error-codes — DEADLINE_EXCEEDED, ABORTED, UNAVAILABLE and RESOURCE_EXHAUSTED.
10. https://docs.cloud.google.com/spanner/docs/fgac-about — Ledger use case, privileges, database-level coexistence, backup/restore.
11. https://docs.cloud.google.com/spanner/docs/backup/restore-backup-overview — New database requirement, excluded IAM, CMEK versions, restore states.
12. https://docs.cloud.google.com/spanner/docs/prevent-database-deletion — Limitations and permissions to disable protection.
13. https://docs.cloud.google.com/spanner/docs/authentication — ADC and outside-Google-Cloud workload federation.
14. https://docs.cloud.google.com/iam/docs/access-change-propagation — Eventually consistent policy/group changes.
15. https://docs.cloud.google.com/spanner/docs/pitr — One-hour default/seven-day maximum; database deletion exclusion.
16. https://docs.cloud.google.com/spanner/docs/backup — versionTime contents/exclusions, expiry, encryption versions, copy failure and billing.
17. https://docs.cloud.google.com/spanner/quotas — Commit/mutation/cell/storage/backup/free-trial limits.
18. https://docs.cloud.google.com/spanner/docs/compute-capacity — PU granularity, small-instance caveats, storage, no suspend.
19. https://docs.cloud.google.com/spanner/docs/instance-configurations — Regional placements/replication and edition/topology tradeoffs.
20. https://docs.cloud.google.com/spanner/docs/emulator — In-memory state, unsupported security, locking/performance differences.
21. https://cloud.google.com/spanner/pricing — Default Iowa table, hourly minimum, all billed components and backup minimum.

## Checks and limitations

Executed: live issue/PR/contract reads; public REST discovery inspection; Python
counterexample/boundary/enclosure block above (PASS: 12 counterexamples and boundary
vectors); 21 public citation GETs (all HTTP 200); three GitHub references resolved
through authenticated GitHub API; `git diff --check` and untracked-file whitespace
check with `git diff --no-index --check /dev/null docs/issue-9-spanner-qualification.md`.
No product code changed, so no product build/test suite was necessary. No emulator,
live provider transaction, failover, time-trust, IAM or recovery rehearsal was run.
This document is research evidence and a no-go recommendation, not conformance certification.
