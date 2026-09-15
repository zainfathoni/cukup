# Issue #10: Amp platform guarantees investigation

Reviewed 2026-09-15 (Asia/Jakarta). **No-go for generic OIDC ingestion and native
approved project capture.** No reviewed source supplies all Stage 5P/5W guarantees.
Keep production shadow attribution `Unassigned`, generic OIDC ingestion disabled,
and OIDC synchronization unsupported/unknown. This is absence of a sufficient
published contract, not evidence that Amp cannot provide the capability.

This is a standalone local investigation, not an eligibility-policy change or
implementation authorization. [Issue #10](https://github.com/zainfathoni/cukup/issues/10)
had no comments when read. [PR #16](https://github.com/zainfathoni/cukup/pull/16)
was OPEN. Its Stage 5P, 5V, 5W and 5X contracts were read at
[the reviewed PR revision](https://github.com/zainfathoni/cukup/commit/ef8fd9205ad74c01bfe1118cf874ffd7a12591c4),
because they are absent from this checkout's base. ADR 0005 was read locally:
its legacy name/slug resolver and “immutable Amp Project ID” wording are not
external evidence for generic identity or approval. Legacy behavior is unchanged.

## Evidence standard and verified sources

Public pages were fetched in full, including their authoritative raw Markdown
renditions listed by [Amp's documentation index](https://ampcode.com/llms.txt).
The public OIDC endpoints were fetched without credentials. Examples and observed
response shapes were not promoted to lifecycle guarantees. No private Amp server
source or unpublished project API contract was available in the reviewed material;
that limits the finding, rather than proving the absence of an internal facility.

| Ref | Authoritative source and exact relevant statement/contract |
| --- | --- |
| S1 | [Handling Secrets — OIDC](https://ampcode.com/docs/orbs/handling-secrets#oidc): RS256; default lifetime 10 minutes, requested 60 seconds–one hour; `user_id` is “The user who created the thread”; `thread_id` is “The thread and orb identity”; `project_id` absent without a project; `workspace_id` absent for a personal thread; exchanged tokens have `token_use=exchanged`. Standard claims are `iss`, `aud`, `sub`, `iat`, `exp`, `jti`. |
| S2 | [Handling Secrets — Design the Trust Policy](https://ampcode.com/docs/orbs/handling-secrets#design-the-trust-policy): “Any orb can request the same audience”; “Use immutable IDs instead of `email` for access rules.” The Google Cloud section explicitly calls `thread_id` “unique” and below the 127-byte subject limit. These are substantive statements, not a lifecycle specification. |
| S3 | [Handling Secrets — How It Works](https://ampcode.com/docs/orbs/handling-secrets#how-it-works): project scope is “a stable identity shared by all orbs for one project”; subjects are owner-qualified, `workspace:<workspace-id>:project:<project-id>` or `user:<owner-user-id>:project:<project-id>`; “Moving a project to a different owner changes its subject.” Current project access is checked for each project-scoped mint. Workspace-scoped minting can continue after membership removal until the request credential expires, up to 24 hours. |
| S4 | [Live OIDC discovery](https://ampcode.com/api/workload-identity/.well-known/openid-configuration): issuer `https://ampcode.com/api/workload-identity`, matching HTTPS `jwks_uri`, `response_types_supported=["id_token"]`, `subject_types_supported=["public"]`, `id_token_signing_alg_values_supported=["RS256"]`. `claims_supported` is exactly `aud,email,email_verified,exp,iat,iss,jti,project_id,sub,thread_id,token_use,user_id,workspace_id`. [JWKS](https://ampcode.com/api/workload-identity/jwks.json) returned one RSA signature key declaring RS256 at review time; key count is an observation, not a permanence or rotation promise. |
| S5 | [Projects — Threads and Projects](https://ampcode.com/docs/projects#threads-and-projects), Overview and Repository Linking: “Every thread belongs to at most one project”; assignment occurs when the thread starts. Names can change; private projects can move to a workspace, not vice versa. Deletion can keep threads permanently archived/read-only. Existing threads retain their repository after a project repository change. The stable GitHub ID mentioned here identifies the repository, not the Amp project. |
| S6 | [Orbs](https://ampcode.com/docs/orbs): each orb thread gets a fresh isolated environment; waking retains “conversation, files, and services.” [Customizing Orbs — The Orb Lifecycle](https://ampcode.com/docs/orbs/customizing#the-orb-lifecycle): a snapshot is a saved prepared orb; current thread environment and workload credentials are applied after snapshot preparation/restoration. Setup output can be reused for “another thread or project member.” Setup request credentials are removed before snapshotting; runtime credentials are fresh before resume. |
| S7 | [Plugin API type reference](https://ampcode.com/docs/plugin-api): plugins “may run for multiple threads concurrently”; all plugin events are thread-scoped; `AgentStartEvent`/`AgentEndEvent` contain `thread.id` and message `id`; tool events contain `thread.id` and `toolUseID`. `PluginEventContext` has a thread handle. `activeThread` is the user's UI focus. `workspaceRoot` is stable only for the plugin process lifetime and is a filesystem URI. `PluginExecutor` exposes kind/keepAlive, not an incarnation. `User`/`Workspace` expose opaque IDs; no native-project field or project-context version occurs in the reviewed event/context interfaces. |
| S8 | [Plugin API](https://ampcode.com/docs/plugin-api), `onDispose`: bounded cleanup, no callback on crash/SIGKILL. [Event-Driven Orbs — Delivery Guarantees](https://ampcode.com/docs/orbs/event-driven#delivery-guarantees): external webhook requests are stored before HTTP 202, have at-least-once delivery and stable server-owned event IDs; registration remains with its first owning thread, even when loaded elsewhere. Delivery is not strict FIFO; repeatedly failing events are dropped after 24 hours. These guarantees belong to webhooks, not agent/tool hooks or Cukup's outbox. |
| S9 | [Threads](https://ampcode.com/docs/threads): conversation identity is separate from execution location; threads can run in an orb, runner or local CLI. Ordinary archive is reversible; project-deletion archive is permanent; deletion removes the thread permanently. No ID recycling or executor replacement contract is stated. |
| S10 | [Workspaces](https://ampcode.com/docs/collaborate/workspaces): a user belongs to at most one workspace; membership and workspace deletion exist. [Multiplayer](https://ampcode.com/docs/collaborate/multiplayer): participants can prompt and access the orb, secrets, terminal and files. Thread creator is therefore not proof of the human who caused an occurrence or an exclusive human operator. |
| S11 | [Runners](https://ampcode.com/docs/cli/runners): a caller can choose a stable runner ID with `--runner-id`; IDs are case-insensitive hostnames. This is not a non-caller-selectable incarnation assertion. [TypeScript SDK](https://ampcode.com/docs/sdk/typescript): the project option selects a new orb thread's project; it does not provide evidence-time context attestation. |

The installed public API was also read with `amp plugins show-docs` on CLI
`0.0.1789461065-g3013e9`, released 2026-09-15T08:31:05Z. Its relevant event,
system and executor interfaces have the same gaps as S7. The repository-pinned
plugin dependency is older; neither package types nor CLI success can establish
undocumented server lifecycle semantics. Search-engine excerpts differed from
the live OIDC page in examples; live full-page content takes precedence.

## Requirement-to-evidence matrix

**Supported** means only the stated part has explicit backing. **Absent** means
the required guarantee was not found in reviewed sources. **Confirm** marks a
specific ambiguity requiring an explicit Amp answer. These labels do not assert
that an undocumented behavior is false.

| Requirement | Supported evidence | Absent guarantee / confirmation needed | Decision |
| --- | --- | --- | --- |
| P: authenticate issuer, audience, creator and exchanged token | S1–S4 define signature, claims, scopes and verification endpoints. | Confirm exact supported schema/version and setup-versus-runtime distinction for the future incarnation assertion. Audience alone is never authorization. | Existing authentication building blocks only; not site enrollment. |
| P: incarnation survives renewal/process restart/pause/same-environment resume, changes on replacement/clone/different restore | S2 calls thread identity unique; S6 promises retained files. | **Absent:** issuer-wide never-reused environment identity, same-thread replacement semantics, single-active-environment restore rule and immutable creator binding over that lifecycle. | No field combination, `jti`, hash, hostname or local UUID qualifies. |
| P: credentials attest actual execution site | S1 names thread/orb and creator; S6 applies fresh runtime credentials after restore. | **Confirm:** credential-to-incarnation binding, whether access to another thread/project can request its assertion, and copy/replay boundaries. Bearer tokens do not prove physical presence per HTTP request. | Cannot infer attestation from possession of token/files. |
| P: durable immutable spool ownership, including zero accepted facts | S6 documents ordinary persistence and setup snapshot sharing. | **Absent:** supported same-site durable storage with clone/template exclusion, local pre-upload incarnation verification and safe restoration semantics. Cukup must implement single-writer persist-before-ack ordering and quarantine. | No bootstrap-by-first-upload; copied never-uploaded lane remains blocked. |
| P: revocation and delayed requests | S3 gives a workspace minting delay and project-scope access checks; JWT expiry is documented. | **Confirm:** runtime thread-scope checks, deletion/transfer/disable invalidation, already-minted token treatment, refresh/key cache policy. Up to 24 hours of minting is not a 24-hour bound on access: last minted token may live another hour. That is a conditional envelope, not a documented global revocation SLA. | Need explicit accepted external stale window plus independent atomic Cukup local denial. |
| W: exact stable native project key with bounded codec and non-reuse | S2 recommends immutable IDs; S3 promises a stable owner-qualified project subject; S5 permits rename/delete/transfer. | **Absent:** exact project-ID grammar/size, stability across rename explicitly tied to ID, deletion/recreation/clone/restore non-recycling, transfer-away/back semantics. | Source set remains empty; Stage 5W's 1–128 ASCII-byte codec is Cukup policy, not Amp's guarantee. |
| W: exact platform owner/account scope | S3 gives project owner-qualified subjects; S7 exposes authenticated user/workspace; S10 documents membership. | **Confirm:** current project owner/type binding for runtime thread-scoped context, personal project in workspace versus personal/no-project claim omission, membership changes and workspace deletion/recreation/non-reuse. User workspace is not necessarily project owner. | No inferred owner scope; transfer must require new prospective approval. |
| W: project bound to actual occurrence, not UI focus or later lookup | S5 assigns a project at thread start; S7 binds hooks to thread/message/tool use. | **Absent:** atomic native project + owner + incarnation context at the exact occurrence, context revision, lifecycle race handling, supported occurrence interval/uncertainty and delayed/replayed callback semantics. | A thread ID followed by `projects get/status` or minting a later JWT cannot qualify. |
| W: recoverable capture after process/response loss; terminal no-commit fence | S8 provides useful but distinct webhook delivery guarantees. | **Absent for hooks:** durable deduplication/replay/occurrence contract. **Cukup-owned unmet work:** reservation, serialized mapping/capture journal, exact result recovery and fencing of delayed authority requests. | Webhooks cannot substitute for capture ownership or settle an indeterminate Cukup request. |
| V/X: owner approval and registry/capture serialization | Amp access grants neither Cukup owner approval nor immutable mapping capture. | **Cukup-owned unmet work:** owner binding, selector verification, restricted channel, trusted time, independently fresh rollback-resistant authority, registry/mapping/capture fences and replay recovery. | Even full Amp identity confirmation would not activate mapping controls. |
| P: synchronization, coverage or accounting authority | None of S1–S11 supplies Cukup status-spool/clock/coverage proofs. | Independent synchronization and authority gates remain. | OIDC synchronization stays unsupported/unknown; no backfill, cutover or stronger completeness claim. |

## Safe subset and conditional implementation order

**No newly enabled Stage 5P/5W runtime subset follows from this evidence.** The
safe work now is the cited refusal, precise platform questions and future
synthetic conformance specifications. Existing authorized physical Unassigned
collection is unaffected; it is not a new Stage 5P/5W capability. Explicit
launch/session binding is a separate possible design, not an available shortcut:
it still needs a real non-reusable lifecycle and all Stage 5V/X authority gates.

If Amp establishes **P identity and storage only**, an independently reviewed
shadow OIDC evidence-ingestion slice can proceed toward **Unassigned only**:

1. Pin the exact assertion/schema, issuer, scope grammar, lifecycle/storage policy
   and revocation bounds. Establish local same-incarnation verification before
   collection acknowledgement; no unknown assertion fallback.
2. Design/review durable private site fingerprints and UUID mapping, immutable
   creator/collector binding, atomic local denial, key rotation, trusted auth
   clock, backup recovery and first-fact transaction. Keep legacy verification separate.
3. Implement same-site durable single-writer outbox and pre-network quarantine,
   then generic evidence acceptance, default off. Run Stage 5P's synthetic signed
   assertion/fake-clock vectors against real disposable persistence, including
   never-uploaded copied spools, response loss, expiry/denial races and recovery.
4. Review any activation separately. No assigned evidence, coverage uploader,
   synchronization, cross-site forwarding, deployment or cutover follows.

If Amp establishes **W project/context only**, revise the eligible-source policy
only after review, then resolve Stage 5V/W/X owner, clock, journal and recovery
dependencies before implementation. A physical-site mapping slice need not wait
for orb OIDC, but does need a qualifying physical event-context source. Implement
restricted codecs/selector verification and owner authorization, then the fenced
registry/mapping/capture protocol, then collector integration with exact replay.
Test rename/transfer/recreate, asymmetric owner/site contexts, delayed callbacks,
revocation/archive races, lost capture acknowledgements and terminal no-commit
fences. OIDC assigned capture still needs its separately reviewed approval
verification transport; W confirmation does not override Stage 5P's refusal.

## Smallest precise request to Amp (draft; not sent)

Please answer with a supported, versioned contract or explicit “unsupported,”
not sample tokens or observed UUID behavior:

1. **Execution incarnation:** Which signed claim or authenticated token-bound
   assertion identifies one actual orb execution incarnation? Does it remain
   identical through token/key renewal, process restart and retained-orb
   pause/resume, and necessarily differ for same-thread replacement, clone or
   restoration as another environment? Is it issuer-wide non-reusable,
   non-caller-selectable, immutably bound to the creator, and retained on restore
   only if no second active environment can share it? State whether `thread_id`
   itself meets every condition or provide the additional discriminator.
2. **Storage and credential boundary:** What supported same-incarnation durable
   storage can retain a private spool outside reusable templates/snapshots, and
   how can a collector verify its retained binding before any upload, including
   before its first server acceptance? Specify restore/rollback behavior and how
   the runtime assertion is bound to the actual environment rather than project
   access or copied files. We do not require bearer tokens to prevent malicious
   exfiltration; we require the supported collector to detect copied state.
3. **Native project/owner identity:** What exact project-ID codec/size and owner
   tuple are supported? Are IDs unchanged by rename and never recycled after
   deletion/recreation/clone/restore? What happens on owner transfer, including a
   return to an earlier owner, and workspace deletion/recreation? How does a
   runtime thread verify current project owner/type, including a personal project
   whose creator belongs to a workspace? If reuse is possible, expose a
   platform-attested project/ownership incarnation discriminator.
4. **Occurrence-bound context:** Which supported hook/API binds native project,
   owner scope and execution incarnation atomically to the exact thread and
   start/engagement occurrence? Specify identity/version, live versus delayed or
   replayed delivery, ordering/deduplication guarantees, occurrence-time bounds
   and invalidation on project deletion/transfer or executor replacement. Can the
   consumer revalidate/fence that context at capture commit, without a later
   current-project lookup? If unavailable, please expose such a context contract.
5. **Invalidation:** For runtime thread-scoped assertions and each optional
   context, which checks occur at mint time versus request-credential issuance?
   Specify worst-case continued minting and already-minted validity after user
   disablement, membership removal, project deletion/transfer or orb destruction,
   and supported discovery/JWKS rotation/cache rules. Confirm how setup tokens
   are distinguished from eligible runtime incarnation assertions.

Amp need not build Cukup's mapping journal or approval system. A minimal platform
capability is a lifecycle-qualified incarnation assertion, verifiable retained
storage binding, and occurrence-bound project/owner context with explicit
non-reuse and invalidation semantics. If these are unavailable, explicit refusal
is sufficient to preserve the no-go decision.

## Validation and limitations

Verified full-page citations against live public Markdown and fetched discovery
and JWKS. No workload token was minted, decoded, read or retained. No production
data, settings, plugins, services, GitHub issue state, pushes, merges or external
posts were touched. No runtime tests apply to this research-only artifact;
future conformance vectors above are requirements, not executed platform tests.
No implementation or published source observation was used to infer a guarantee.
The remaining blocker is authoritative Amp confirmation plus the independent
Cukup protocol/authority work identified above. This draft is uncommitted.
