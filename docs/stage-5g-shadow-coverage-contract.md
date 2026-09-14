# Stage 5G: shadow coverage design contract

This documentation-only slice defines the minimum durable facts and report semantics needed before
ADR 0007 shadow measurements can appear in a dashboard. It does not add a wire payload, schema,
route, collector behavior, aggregate, or dashboard. Existing Stage 5A–5F code remains internal and
non-authoritative; legacy v1/v2 behavior and wording remain unchanged.

The central rule is that **coverage is not one status**. Capability, known irreversible loss, report
availability, pending execution, and synchronization are independent dimensions. A report may, for
example, be ready while one collector is capability-limited, has a known loss interval, has pending
execution, and reports a blocked backlog. Implementations must preserve all applicable dimensions
rather than choose one reassuring account-wide label.

## Closed report vocabulary

Future report projections use only these values. Values apply to an explicit collector/site and
occurrence interval unless the table says otherwise.

| Dimension | Closed values | Meaning |
| --- | --- | --- |
| Capability assessment | `unknown`, `declared_for_scope`, `declared_limited` | `declared_for_scope` means the collector declared every capability required by the named metric scope. It is not proof of continuous observation. `declared_limited` identifies the missing capabilities. |
| Collection integrity | `unknown`, `known_loss` | Only an accepted explicit irreversible-loss fact produces `known_loss`. In every other case integrity remains `unknown`; there is intentionally no `complete` or `no_loss` value. |
| Report availability | `ready`, `stale`, `unavailable` | This is the existing panel-delivery meaning: current result, retained prior result after failure, or no usable result. It says nothing about collection integrity. |
| Execution closure | `none_pending`, `pending` | Derived only from accepted execution starts lacking accepted ends at report time. Pending execution is not a collection gap and contributes no runtime. |
| Synchronization | `unknown`, `clear`, `queued`, `retrying`, `blocked` | Requires a server-visible bounded spool observation. `clear` means only that the reported spool was empty at that observation; it does not claim complete collection. Without such an observation the value is `unknown`. |

The Working Time capability scope requires the five base `engagement.*` capabilities in the closed
version-1 vocabulary. The Agent Runtime scope requires `execution.segments`. Recovery capabilities
are listed separately as limitations; they never turn a base capability into proof of replay or
continuous observation. `process.lifecycle` satisfies neither metric scope. A later protocol version
may define a different closed requirement set, but must not reinterpret a version-1 declaration.

Dashboard language must say **“declares required observations”**, **“limited declaration”**,
**“known collection loss”**, **“data unavailable”**, **“execution pending”**, and the exact
synchronization value. It must not say “full coverage”, “complete”, “no work”, “no attention”, or
“synchronized” merely because evidence exists, a receipt is recent, a total is zero, or no loss fact
exists. Totals remain “Working Time · estimated” and “Agent Runtime”; missing evidence never becomes
actual attention or inferred work.

## Durable facts and identities

The accepted Stage 5A evidence record remains the source for evidence occurrence, receipt time,
collector UUID, server-bound execution-site UUID, source sequence, exact capability snapshot,
recovery/timing claims, and project attribution. Its pending/closed segment projection remains the
only currently durable basis for execution closure.

Two new generic facts are required before a positive capability or known-loss projection can be
implemented:

1. A **capability declaration** identifies one collector and its server-bound execution site, the
   protocol version, the exact closed capability set, and an occurrence-time effective instant. It
   applies prospectively until that collector's next accepted declaration. The declaration has its
   own immutable UUID and participates in that collector's durable source sequence. Restarting or
   reinstalling while retaining durable collector state preserves its collector identity and source
   sequence. Creating fresh identity state or explicitly resetting identity creates a new collector
   identity. Retained queued records keep their original identities; reports must not stitch distinct
   collector identities merely because they share a site.
2. An **irreversible-loss declaration** identifies one collector/site, its own immutable UUID and
   source sequence, a closed half-open occurrence interval `[start, end)`, the affected capabilities,
   and one bounded reason: `storage_exhaustion`, `source_without_replay`, `abrupt_termination`,
   `operator_discard`, or `unspecified`. It may be emitted only when the collector can explicitly
   bound evidence that cannot be recovered. A sequence gap, absent evidence, process silence,
   delayed receipt, retry, blocker, stale declaration, or report failure must never synthesize it.

Both fact families must use a future reviewed closed protocol and the same authentication-derived
site binding, strict parsing, persist-before-acknowledgement, immutable identity, duplicate, conflict,
ordering, clock, and prohibited-field rules as accepted evidence. The exact framing, batch limits,
DDL, and endpoint are deliberately deferred. This document fixes semantics, not an implementation
shape.

Occurrence intervals are UTC instants and half-open. Receipt timestamps describe when the cloud
accepted a fact, never when capability or loss occurred. Capability changes do not rewrite earlier
declarations or evidence snapshots. An evidence record retains the exact declaration carried when it
was produced; a standalone later declaration governs only future occurrence time. Equal effective
instants with different declarations are identity conflicts, not merge candidates.

Account, project, and metric reports may summarize source-scoped disclosures, but must retain the
collector/site lanes and effective intervals from which they came. Multiple collectors at one site,
one collector identity never moving between sites, and capability changes over time must not become
an account-wide boolean. Project attribution remains attached to evidence, not to declarations,
loss, or spool state.

## Ownership boundaries

### Collector and local spool

The collector owns truthful capability declarations and explicit loss declarations for failures it
can bound. The local spool owns persist-before-send evidence, local queue/retry/blocker state, and any
future privacy-safe synchronization observation. Queued or retrying data is recoverable backlog, not
loss. A terminal FIFO blocker is still retained data, not loss, unless a later explicit operator
discard produces an irreversible-loss declaration for a bounded occurrence interval.

Stage 5C's current `status()` and Stage 5D command remain local-only aggregate diagnostics. Their
existence does not authorize upload and gives the cloud no synchronization knowledge. A future
reviewed synchronization protocol may report only collector/site identity, observation time, the
closed synchronization value, bounded aggregate record/byte counts, and a bounded oldest-queued
occurrence time. It must not report payloads, IDs of evidence/projects, hostnames, paths, tokens,
response bodies, arbitrary errors, or infer a collection watermark. A newer observation supersedes
an older one for current status; historical observations remain immutable. Expiry policy and wire
framing remain deferred.

### Cloud persistence

The cloud owns authentication-derived execution-site binding and immutable append-only persistence
of accepted evidence, declarations, loss intervals, and any later reviewed spool observations. It
may retain occurrence and receipt time separately. It rejects identity/site conflicts and never
fills sequence gaps, closes pending segments, extends declarations backward, fabricates loss, or
converts a recent receipt into completeness.

### Aggregation and report projection

Aggregation owns interval clipping, metric-specific capability assessment, pending derivation, and
source-scoped disclosure. It unions only accepted contributing metric intervals as Stage 5E/5F
specify. Disclosures are not durations and never contribute to totals.

Late accepted engagement or execution endpoints revise the occurrence day/week and its unions. A
late end changes its segment from pending to closed and may add runtime from the original endpoints;
it does not erase a separately declared loss interval. Recovered evidence keeps its stored recovery
claim and occurrence time. Late declarations are projected by effective occurrence time, not receipt
time. Reports are current reconstructions from accepted facts, not “as known at receipt time” audits.

Availability wraps the projection result. If current persistence or aggregation cannot produce a
panel, the consumer may retain its prior successful value as `stale`; otherwise it is `unavailable`.
Neither state supplies zeroes. A ready zero means only that accepted contributing intervals in the
requested snapshot and bounds total zero.

### Dashboard wording

The dashboard owns plain-language disclosure without strengthening the facts. It presents each
source/interval limitation beside the affected metric, keeps Working Time, Agent Runtime, and legacy
turn-based Working Time separate and non-additive, and exposes pending and synchronization
independently. Account summaries may say that one or more sources have limitations, but must provide
the source-scoped detail and must not label the account covered or complete.

## What existing stages can and cannot establish

| Question | Derivable now? | Basis or missing evidence |
| --- | --- | --- |
| Which exact capabilities accompanied an accepted evidence fact? | Yes | Stage 5A persists that record's exact capability snapshot. This is a point claim only. |
| Which execution starts are pending or closed? | Yes | Stage 5A `segments()`; pending contributes no Stage 5E/5F runtime. |
| When did evidence occur and when was it received? | Yes | Separate accepted occurrence and receipt timestamps. |
| Are current shadow totals complete or zero work? | No | Absence of contributing evidence proves neither collection completeness nor actual work/attention. |
| Was a period irreversibly lost? | No | Requires an explicit durable irreversible-loss declaration; none exists. |
| What could a collector observe between evidence records? | No | Requires durable prospective capability declarations; per-record snapshots do not prove continuity. |
| Is a physical outbox clear, queued, retrying, or blocked from the cloud's perspective? | No | Stage 5C/5D status is local only; a reviewed bounded server-visible protocol is required. |
| Is recent receipt proof of synchronized or complete collection? | No | Receipt freshness is neither a local backlog observation nor collection integrity. |
| Can an account-wide coverage boolean be computed? | No | Source identities, sites, intervals, capability sets, and independent dimensions must remain visible. |

## Executable acceptance cases for later slices

Later implementations must encode at least these asymmetric cases with independently calculated
expectations:

1. Collector A at site 1 declares only `execution.segments`; collector B at the same site declares
   all five engagement capabilities. Agent Runtime assesses A `declared_for_scope`, Working Time
   assesses A `declared_limited`, and B is assessed conversely for runtime. No site/account boolean
   replaces the two lanes.
2. One collector changes from execution-only at 11:59 to engagement-only at 12:00. The first
   declaration governs only `[11:59, 12:00)` and the second governs from 12:00; neither declaration
   rewrites the other interval or proves continuous observation.
3. Accepted source sequences 8 and 10 arrive 48 hours apart with no sequence 9. The report shows no
   `known_loss`; collection integrity remains `unknown`, and receipt freshness does not change it.
4. An execution start at 09:00 has no end while unrelated engagement arrives at 10:00. Execution is
   `pending`, runtime is unchanged, Working Time may use the engagement, and no generic loss is
   created.
5. A local spool has three queued records and one retry. Without a server-visible spool observation,
   cloud synchronization is `unknown` even if the cloud accepted another record one second ago.
   With a reviewed observation it is `retrying`, not `known_loss` or `clear`.
6. A bounded `[09:00, 09:20)` `source_without_replay` declaration coexists with two records queued
   from 10:00. The report shows `known_loss` for the earlier interval and `queued` separately; it
   neither treats queued records as lost nor erases the known loss when they upload.
7. A late execution end received Tuesday closes a Monday start. Monday runtime is revised from zero
   using the original occurrence endpoints and pending clears for that segment. Receipt time does not
   move runtime to Tuesday or imply synchronization; an overlapping loss declaration remains shown.
8. Two collectors on different sites use the same segment UUID. Their endpoints remain
   collector-scoped; closing one does not close the other. Capability, loss, pending, and sync remain
   separate per collector/site.
9. Current report generation fails after a prior successful value of 17 minutes. The panel is
   `stale` with 17 retained, not ready with zero. With no prior value it is `unavailable`, not zero.
10. A capability/loss/spool candidate containing a prompt, output, path, hostname, token, response
    body, arbitrary metadata, native harness ID, or free-form diagnostic is rejected and no raw
    candidate is logged or retained. Allowed aggregate counts are bounded before persistence.
11. Reinstalling collector binaries over a retained spool preserves collector A and its next source
    sequence, so a late end still closes A's earlier start. Installing with fresh identity state at
    the same site creates collector B; B cannot close A's segment, and reporting retains both lanes.

## Deferred implementation decisions

Future independently reviewed slices must choose protocol version/framing, DDL and migration,
authentication and route shape, bounded numeric limits, synchronization-observation expiry,
correction policy for an erroneous declaration, report/API payloads, detailed dashboard layout, and
cutover activation. OIDC/Amp-orb execution-site design, collectors beyond the existing experiment,
historical migration/backfill, support claims, target comparison, production settings/access,
publication, and deployment also remain deferred.

No historical declaration or loss may be backfilled from missing records, source-sequence gaps,
legacy events, receipt delays, or operator guesses. Any future correction mechanism must preserve the
original accepted fact and make the superseding fact explicit; it must not silently mutate history.

## Publication and compatibility

This slice changes documentation only and is publication-neutral. It does not match the current
plugin/service publication paths, alter a package or workflow, migrate a database, or activate a
runtime. The transferred Stage 5A/5B prerequisites retain their separate service-publication and
schema implications. No push, publication, deployment, production access, or shared setting change
is authorized here.
