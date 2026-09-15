# Stage 5AA: inactive authority-report transport

Status: **complete documentation contract; no endpoint or consumer enabled**. This pins one
incompatible wire profile of [Stage 5Z](stage-5z-authority-report-envelope.md), not a replacement
for dashboard schema 1/2 or summary schema 1. All requirements below are prospective. Existing
routes, initial HTML, bundles, authentication, ingestion and local plugin behavior remain unchanged.
No authority state, selected C, trusted clock, provider, migration or activation is introduced.

**Version 1 refuses current use.** There is no reviewed client UTC/deadline proof today, and
[5Y](stage-5y-commit-authority-provider-decision.md) selects no commit/time provider. Version 1 can
carry only verified non-current snapshots or payload-free refusals. A future current-capable profile
requires a new reviewed incompatible transport version; setting a flag or filling a null is forbidden.
Even snapshot production remains blocked on 5R/S/Y recoverable authority and release interfaces.
This closes wire choices, not the implementation or arming gates in 5Z.

## Inspected boundaries and deliberate isolation

[Backend](../service/dashboard/backend.ts) renders schema-2 initial HTML and serves POST
`/dashboard/report`; [client](../service/dashboard/client.ts) uses the same legacy normalizer on
initial and refresh data. [Report parser](../service/dashboard/report.ts) accepts schema 1/2 with
shallow normalization, not a closed recursive authority codec. [Controller](../service/dashboard/controller.ts)
retains stale target comparisons and queues requests without a session/generation installation fence.
[Builder](../service/dashboard/report-builder.ts) reads independent panels and labels with injected
wall time, not a recoverable authority snapshot. Backend/controller/builder/render tests preserve
these existing behaviors; their success cannot qualify this transport.

[App](../service/app.ts) separates `cukup.dev` dashboard cookies from `api.cukup.dev` bearer/OIDC
principals. `/v1/summary` is legacy and `/v1/time` is not trusted time. Existing
[protocol](../service/protocol.ts) and [harness protocol](../service/harness-evidence-protocol.ts)
closed object checks cannot detect keys already lost by JSON.parse. The bounded streaming/fatal
UTF-8/decoded duplicate-key reader in [synchronization](../service/shadow-synchronization.ts) is a
useful precedent, not a drop-in proof of this profile's deadlines and recursive response validation.

## Exact prospective HTTP surface

There is one report endpoint: **POST `https://cukup.dev/dashboard/authority-report/v1`**.
It lives only on the configured exact dashboard host (production `cukup.dev`), never the API host.
No query string, including a bare `?`, trailing slash, encoded-path alias, redirect, GET/HEAD report,
OPTIONS negotiation, range/filter URL, export route, or automatic downgrade is accepted. Deployment
must preserve the raw request target for these checks. TLS is mandatory; only an explicitly trusted
TLS-terminating hop may assert exact `X-Forwarded-Proto: https`. Forwarded host cannot select routing.
Unknown/wrong host or insecure transport returns fixed 404; it never redirects credentials.

Requests require a single `Content-Type: application/vnd.cukup.authority-report+json; version=1`
and a single identical `Accept`. Media type and parameter names are case-insensitive; optional HTTP
whitespace around separators is ignored. The sole parameter value is unquoted `1`; no charset,
wildcard, quality factor, repeated parameter or comma-separated alternative. Responses use that same
media type on **all application statuses**, including errors. Bytes are always UTF-8. An otherwise
well-formed Accept with sole positive decimal version other than 1 gets 406/unsupported_version; missing or
otherwise invalid Accept gets the same result. Invalid Content-Type gets 415/unsupported_media_type.
Content-Type version other than 1 is invalid and gets 415, including when Accept also names it.
Content-Type is checked before Accept. No negotiation via existing capabilities or schema numbers.

Fetch uses credentials same-origin, redirect error, cache no-store, and AbortSignal cancellation.
Require exact `Origin: https://cukup.dev` (or configured dashboard origin) and
`Sec-Fetch-Site: same-origin`; absent, opaque `null`, cross-site and multiple values reject. This is
an intentionally stricter JSON-fetch-only rule than the legacy no-referrer form-navigation exception.
No CORS access-control headers, JSONP, cross-origin preflight success or bearer fallback.

Authentication is the [dashboard owner session](../service/dashboard/auth.ts): GitHub OAuth with
state/PKCE and the configured immutable allowed GitHub numeric ID, encrypted host-bound
`__Host-cukup_session`, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. Exactly one session cookie
is required. Validate current allowed owner, session expiry and revocation policy at admission and
release. Reject any Authorization header with 401 even if a valid cookie is also supplied. Physical
tokens and workload JWTs cannot read this route; a dashboard cookie grants no ingestion rights.
Session read permission does not approve, prepare, arm, activate or mutate authority or projects.
The existing stateless seven-day cookie alone does not supply 5S serialized revocation/version
fencing: implementing that dependency remains blocked, not silently assumed from login success.

## Request and bounded codec

The request has exactly these fields (all required):

```json
{"transport_version":1,"range":{"start":"2026-09-19T17:00:00.000Z","end":"2026-09-21T17:00:00.000Z"}}
```

This range is synthetic, not a selected cutover. No caller as-of, timezone, target mode, account,
selection/C, IDs, filters, labels, nonce or request/session identifier is allowed. The range is
half-open, nonempty, at most 31622400000 milliseconds (366 Jakarta civil days). Each time is an
exact round-tripping `YYYY-MM-DDTHH:mm:ss.sssZ` string with integer UTC milliseconds in
0..253402300799999. Server supplies trusted as-of; future ranges are not coerced to observed zero.

Both request and response parsers must enforce these bounds before installation/rendering:

| Budget | Inclusive maximum and failure |
| --- | --- |
| Request headers | 16384 bytes total, 64 fields, each value 4096 bytes; ingress rejects excess with 431/invalid_request before body or account reads. |
| Request body | 1024 bytes, measured incrementally regardless of Content-Length; excess 413/payload_too_large. |
| Response body | 262144 bytes, including wrapper; serialize/validate completely before releasing headers. Overflow becomes 503/report_unavailable, no truncated lanes or metrics. |
| Error body | 128 UTF-8 bytes; exact fixed object below, no diagnostic text. |
| Response headers | 16384 bytes total, 64 fields, each value 4096 bytes; final trusted egress enforces before release, with separate Fetch-visible checks below. |
| JSON nesting | 16 containers including root; enforce during tokenization, before recursive decoding. |
| Arrays | 2 sections; 64 disclosure lanes; per lane 128 capability intervals, 128 losses, 128 pending starts; each capability list at most 15. No pagination or truncation. |
| Strings | Decoded keys at most 64 UTF-8 bytes; labels 1..128 UTF-8 bytes; all other strings restricted to exact timestamps/literals below or in 5Z. |
| Request timing | Headers complete within 2000 ms from connection acceptance; body within 2000 ms from completed headers. Absolute server deadline 5000 ms from completed headers includes authentication, body, calculation and final release validation. |
| Response timing | Server completes body transmission within 1000 ms of release authorization; client deadline 6000 ms from fetch invocation through final byte and validation. No per-chunk reset. |

Header budgets count each original field occurrence **before coalescing**, after HTTP header
decompression: sum name octets + value octets + 4 per field (colon/space/CRLF accounting), plus 2
for the final terminator. Exclude the request/status line and HTTP/2/3 pseudo-fields; the fixed
authority/method/path checks independently constrain those. Count duplicate occurrences separately.
Request ingress applies this definition before forwarding or body reads. Final trusted response
egress applies it after all proxy-added fields, rejects forbidden headers (including Set-Cookie),
and emits a bounded fixed 503/report_unavailable instead; if that cannot be guaranteed, close the
stream. No unvalidated intermediary may subsequently add headers. Header decompression itself
must be resource-bounded at ingress/egress, not buffered without limit before these checks.

Browser Fetch hides forbidden response headers and combines duplicates. The client therefore
checks the same numeric budgets over **Fetch-visible normalized entries**, counting UTF-8 encoded
name/value lengths with the accounting above, and validates visible required/forbidden headers.
It must reject visible excess or mismatch but cannot prove original counts/bytes or absence of
hidden Set-Cookie. Full raw-field and forbidden-header compliance requires trusted-egress tests;
JavaScript iteration over response.headers is not that proof. No browser claim relies on it.

Durations use monotonic resource timers, **not UTC authority proof**. Reused connections apply the
header deadline from the start of the next request; ingress must also bound idle connections.
Header/body timeout is 408/invalid_request when a response can still be sent. Computation/release
timeout is 503/report_unavailable. Disconnect, exceeded write deadline or expired client deadline
cancels work/stream and discards incomplete data. No automatic retry; an explicit retry is a fresh
read/generation under all guards. Infrastructure failures that cannot deliver a fixed response are
transport failures, never parseable success. No SSE, NDJSON, progressive rendering or unbounded queues;
allow at most one executing and one latest queued read per session, otherwise 503/report_unavailable.

Content-Encoding must be absent on requests/responses; no compression/decompression bombs. A single
Content-Length, if present, is canonical nonnegative decimal and must equal actual bytes; HEAD
responses must omit it as specified below. Reject
conflicting or detectably inconsistent framing at ingress. Body limits count bytes in the
HTTP-framed message, not bytes from a subsequent request. In HTTP/1.1, a valid Content-Length
defines that boundary; extra bytes after it cannot be assumed to belong to the preceding body or
retroactively require its rejection. Isolate subsequent-message parsing and reject invalid framing
with 400/invalid_request or close the connection when no response is safe. For a supplied body
stream, count actual bytes rather than trusting length metadata. Cancel at the first excess
chunk without retaining it. Reject BOM, malformed UTF-8, overlong sequences, invalid JSON grammar,
trailing documents, duplicate **decoded** keys at every depth (including escaped aliases), unpaired
surrogates, and unknown/missing fields. No coercion or partial salvage. Numbers use lexical
`0|[1-9][0-9]*` only and must be safe integers before conversion; no negative zero, fraction,
exponent, overflow or underflow. Thus 1.0 and 1e0 reject even if numerically integral.
Plain JSON.parse or response.json without a preceding bounded strict token pass is insufficient.

## Exact responses: snapshot or refusal, never current

A report response has exactly `transport_version`, `validity`, `report`:

```json
{
  "transport_version": 1,
  "validity": {"current_use":"forbidden","valid_until":null,"proof":null},
  "report": {
    "contract_version":1,"timezone":"Asia/Jakarta",
    "range":{"start":"2026-09-19T17:00:00.000Z","end":"2026-09-21T17:00:00.000Z"},
    "as_of":null,"authority":"unresolved","cutover":null,
    "delivery":"unavailable","reason":"authority_unavailable","sections":[]
  }
}
```

This is the exact **503 authority refusal** shape for that valid request. `report.range` always
equals the admitted request range, including refusals. `validity` has exactly those three fields
and literal values. TLS authenticates the response channel, not UTC. Non-null proof/deadline,
`current_use` other than forbidden, or delivery current rejects the whole envelope. No signing key,
algorithm, TimeProof, clock epoch, checkpoint or control identity is exported. Null means **no
current-use permission at any instant**, not infinite validity or permission until refresh.
Date.now, performance.now, HTTP Date/Age, `/v1/time`, TLS, receipt age and signed old timestamps
cannot upgrade it. A future proof protocol must bind authenticated fresh time, uncertainty, session,
request and release, cap its deadline by C/gates/time/session, and survive delay/suspend/replay; that
separate review must assign a new version. This explicit refusal is the conservative resolution of
5Z's missing authenticated deadline/client-proof representation.

`report` otherwise uses **exactly the closed logical objects/fields and capability/loss vocabulary
in 5Z's “Closed logical envelope, version 1”**, with the following narrower wire rules. This is a
normative frozen reference, not permission to import current dashboard types or future enum additions.
All envelope/range/section/disclosure times use the canonical strings above; no epoch numbers.
Cutover is null or that timestamp, and a non-null C must be Jakarta Monday midnight.

- Verified reports require non-null trusted `as_of`, verified authority and sections partitioning
  the requested range: legacy only without C; with C, one nonempty section per intersected side,
  legacy then generic. No overlap, gap, empty section, duplicate authority or extra metric.
  Sections span requested occurrence bounds; metric calculation caps at as-of, not section relabeling.
  Only active authority can supply generic numeric data. Armed post-C sections without activation
  have unavailable/report_unavailable metrics and disclosures (or not_started before they elapse),
  never generic shadow numbers promoted into authority. A wholly future section has no metric data.
- HTTP 200 requires delivery snapshot, reason refresh_required and at least one stale metric with
  data. Every usable metric is stale/refresh_required, with observed_minutes a nonnegative safe
  integer, target none, no comparison. No ready metric or target status/comparison is legal in this
  profile, even for complete historical civil days; those richer/current comparisons stay deferred.
  Preserve 5Z's clipping/global union/flooring and authority labels, never sum sections or runtime.
- Legacy sections contain only authority, range, working_time. Generic adds agent_runtime and
  disclosures. Their metric discriminants are respectively legacy_working_time,
  working_time_estimated and agent_runtime. Unavailable metrics have state unavailable, reason
  report_unavailable or not_started, and no data. Not_started requires section.start >= as_of.
- Generic disclosures use stale/refresh_required with data, or unavailable/report_unavailable
  without data. For a wholly future generic section, unavailable/not_started is used instead.
  Stale data covers exactly `[section.start,min(section.end,as_of))`, which must be nonempty;
  every synchronization is unknown. Capability/loss intervals lie within that range; pending
  starts use 5I occurrence scoping within it. Equal pending timestamps from distinct starts may
  repeat; they are not identifiers. Capability lists are duplicate-free and keep 5I metric-specific
  assessment rules. Unknown assessment has only status; no fabricated empty missing lists.
- Labels are display-only, HTML-escaped as text, without controls or private identity encodings.
  Use unique privacy-safe 5O labels/ordinals; failure to produce safe bounded labels refuses the
  report rather than dropping a lane. Unknown capability, known loss and zero accepted engagement
  are valid snapshot data, never evidence of zero actual work or complete coverage.
- If verified but no metric has data, HTTP 503 carries delivery unavailable, reason
  report_unavailable, and verified non-null as-of, cutover (possibly null), and payload-free metrics.
  Independently available disclosures may remain stale; they cannot alone make HTTP 200. Required
  disclosure failure withholds both generic metrics; target-only dependency failure withholds
  working time but may preserve runtime. Independent pre-C history may survive post-C failure.
  For this targetless profile no target lookup is needed solely to construct a comparison.
- Authority/recovery/time/floor failure produces the unresolved 503 example, no sections; no
  default legacy. Bounded serialization/codec failure instead returns the fixed error below,
  without a partially usable report. Invalid nested wire data rejects the entire response even
  when the other section looks correct; section failure is a validated semantic state, not salvage.

All content-bearing non-report application responses are exactly `{"error":"CODE"}`, with no transport wrapper,
range, numbers, message, stack or Retry-After. A client admits a report only for 200 or 503 with the
exact report shape; 503 is never a successful refresh. Error objects never become observed zero.

HEAD follows the same rejection/status precedence and security/media headers, but **never sends a
body** and must omit Content-Length. This HTTP exception applies to every HEAD error, including
401/404/405; it does not authorize HEAD reporting or bypass authentication. Authenticated HEAD on
the exact route returns bodyless 405 with Allow: POST, not report metadata or a successful refresh.

| Order / condition | Status / fixed CODE |
| --- | --- |
| Header/framing limits or invalid framing | 431/invalid_request for limits; 400/invalid_request for framing |
| Host/path/TLS mismatch | 404/not_found |
| Missing, invalid, expired, denied session or Authorization present | 401/unauthorized (no login redirect or Bearer challenge) |
| Wrong method after authentication | 405/method_not_allowed; Allow: POST |
| Query or Origin/Fetch-Site failure | 400/invalid_request |
| Request encoding or Content-Type failure | 415/unsupported_media_type |
| Accept mismatch or unsupported media version | 406/unsupported_version |
| Oversize body; body timeout | 413/payload_too_large; 408/invalid_request |
| Strict syntax, field, bounds or range failure | 400/invalid_request |
| Exact request shape with positive integer transport_version other than 1 | 406/unsupported_version, before authority reads |
| Capacity, computation timeout, oversized/invalid output, internal failure | 503/report_unavailable |

Checks follow table order, with streaming limits/deadlines enforced whenever consuming bytes.
Malformed/extra-field requests do not get version negotiation by hiding behind an unknown version.
Recheck session at release before any report/error that could disclose admitted account data; denial
becomes 401 with no data. When authority is verified, dependent section failures use the report
rules above instead of internal-error diagnostics. No 204, 206, 304 or success-shaped empty result.

## Release, initial load and private cache rules

Privately bind each calculation/cache entry to 5Z's selection revision/C, lineage/head, evidence,
target (where needed), disclosures/labels, as-of, range, owner session/auth version and reader floor.
Read one consistent recoverable context. Fresh witness, time, readiness and owner authorization
must still validate at serialized final release; any change requires recompute or refusal within
the same deadline. Snapshot-only does not permit bypassing recovery or releasing cached old state
as newly verified. Report reads do not perform activation or advance acceptedFrontier.

There is **no new HTML route or embedded report codec** here. A future separately gated consumer
must initially render an empty unavailable shell and issue the same POST as refresh; it cannot
hydrate from `/`'s legacy `dashboard-data`, reuse its bundle/normalizer, or flash current verdicts.
This slice does not add that shell or connect the endpoint to any existing consumer.

Use one in-memory report slot per document/session and range; no localStorage, IndexedDB,
sessionStorage, service-worker, HTTP/shared cache or offline fallback. Request generation and
session epoch are local-only counters, captured with the requested range, never wire identifiers.
Every new read/selection change increments generation and aborts the previous request; only the
latest generation of the same live session and exact range may install a fully validated response.
An older response/error cannot overwrite or stale a newer one even with a later as-of. Counter
exhaustion clears the document state rather than wrapping. Range changes clear the old visible slot.

Failed refresh may retain only an already compatible snapshot of that same range/session, original
as-of/C and labels, target none and synchronization unknown; show fixed refresh-required wording.
Initial failure has no numbers. Authentication denial/logout/session replacement clears private
state, aborts requests and invalidates generations across tabs before reuse. Hide/pagehide clears
the visible slot and cancels requests; resume/pageshow (including bfcache) or reconnect requires a
fresh session-validated read before displaying data. A future session integration must prove these
events, including cross-tab replacement/denial, without exporting session IDs; the present cookie
helper does not. Transport version mismatch discards incompatible incoming/cache objects, with no
schema normalization, legacy endpoint retry, plugin cache borrowing or local target fallback.

## Security, compatibility and implementation gates

Every response, including fixed errors, has Cache-Control: no-store, Vary: Cookie, Origin, Accept,
X-Content-Type-Options: nosniff, Referrer-Policy: no-referrer, X-Frame-Options: DENY,
Cross-Origin-Opener-Policy: same-origin, Cross-Origin-Resource-Policy: same-origin,
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none',
and Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=().
No ETag, Last-Modified, Content-Disposition, Server-Timing, Set-Cookie, debug or reflected headers.
HTTP Date, if supplied by infrastructure, is ignored for validity. No data-bearing GET, URL query,
control refs, hashes/revisions, private IDs, raw hostnames, paths, tokens, prompts or body logging.
Allow only fixed route/outcome categories in application/proxy diagnostics, no precise timings,
cookie/request headers, ranges, labels, totals or exception details. No public real-data artifacts.

Old summary schema 1 and dashboard schema 1/2 retain only their existing legacy meanings and routes.
Never send this profile or generic numbers through them; never wrap their data as verified authority.
New consumers reject old initial/refresh data; old consumers receive no new report data or bundle
through existing routes. A wrong-host request to the reserved route gets 404, not a summary.
No arming until all dashboard/summary/plugin status/cache/local fallback/export consumers either
implement a separately approved current-use fence or cannot claim current progress. HTTP errors
alone do not disable old plugin local/cached targets. This profile cannot satisfy that arming gate.

5R/S/Y authority persistence, all-mutator serialization, owner revocation integration, trusted time,
recovery provider and current-capable proof remain blockers. Rich views/filter/target codecs, new
consumer shell/bundle/session integration and runtime tests are separate implementation slices.
5P OIDC and 5W native eligibility blockers remain. No weakening of those gates, activation through
a read, runtime/schema/config/workflow change, shared state, production access, push or deployment.

## Asymmetric future acceptance vectors

These are required future tests, **not executed tests or rollout evidence**. Use real bounded
codecs/HTTP/session/client boundaries with disposable authority providers. C is symbolic only.

| Input / race | Independent expected result |
| --- | --- |
| Initial missing authority vs verified elapsed-empty | Missing: unresolved 503, no sections/numbers. Verified empty: snapshot 200 with stale observed 0, target none; never zero actual work. No initial current flash. |
| Old initial/new refresh vs new initial/old refresh | Never hydrate schema 1/2. Compatible POST can install snapshot; later old schema cannot replace it or enable targets. An unrecognized nested capability rejects the entire packet. |
| Bearer vs owner; cross-host | Valid bearer alone or cookie+Authorization: 401. Owner cookie with exact same-origin headers passes admission. API host: 404 even with owner cookie. Origin null: 400 after authentication. |
| HEAD refusal | Authenticated HEAD on the exact route: bodyless 405, Allow: POST. Missing-session HEAD: bodyless 401; wrong-host HEAD: bodyless 404. All retain security/media headers and omit Content-Length; none reads or exposes report data. |
| Versions and duplicate aliases | Exact request version 2: 406. Version 2 plus extra field: 400. Nested start plus escaped st\u0061rt: 400 even if equal. Invalid UTF-8/BOM/surrogate: 400; 1e0 and 1.0000000000000001 reject rather than round to 1. |
| Partial evidence vs corrupt packet | Valid unavailable working time and runtime 16: 200 snapshot with only runtime data. Required disclosure failure removes both generic metrics; valid legacy 11 can survive. Corrupt generic nested data invalidates even legacy 11. |
| Clipping vs addition | 5Z crossing fixture produces separate legacy 11, estimated 24, runtime 16; never 35, 40 or lane runtime 18. All comparisons absent. Two 40-second disjoint contributions floor once to 1 minute. |
| Request/response ceilings | Valid padded HTTP-framed request body 1024 bytes accepted, 1025 rejected 413, for both correct Content-Length and chunked delivery. Valid response 262144 accepted, 262145 never released; fixed 503. Lane 64 accepted, 65 refuses whole report; no truncation. |
| Framing isolation | Conflicting or detectably inconsistent framing gets ingress 400 or connection closure. HTTP/1.1 valid 1024-byte body plus extra bytes after its Content-Length boundary tests isolated subsequent-message parsing, not a guaranteed 413 for the completed first request. |
| Raw versus Fetch-visible headers | Egress with 65 repeated small fields rejects before release even if Fetch would combine them into one. A single Set-Cookie also rejects at egress despite being invisible to JavaScript. Separately, an oversized visible combined value makes the browser reject. |
| Stalled/chunked delivery | Body ends at 1999 ms eligible; at 2000 ms deadline expires. Trickle cannot reset timer. Client last byte at 6000 ms rejected; disconnect after headers installs nothing. |
| Initial vs refresh failure | Initial 503 has no invented data. Refresh failure retains only same-range/session compatible snapshot with original as-of/C, target none, synchronization unknown. |
| Session/range races | A for 7 days starts before B for 30; B finishes first, then A with later as-of: keep B. Logout/login during B: clear and discard B. Old failure arriving after successful C cannot stale C. |
| Release and expiry | Calculate at C−2 ms, release at C+1: recompute/refuse under current authority. Packet delayed past C remains forbidden-current even if released before C. Null deadline never means unbounded validity. Forged non-null proof rejects. |
| Cache/head/resume | Same as-of with late execution end changes 0→4 only after fresh head validation. Restored old head refuses. Sleep/bfcache across C clears display and needs fresh session read; backward wall clock cannot authorize current data. |
| Privacy and legacy fallback | Synthetic sentinel identifiers absent from JSON, headers, DOM/accessibility, cache and logs. 406/503 does not trigger legacy summary/local plugin fallback. Old ingestion/replays remain byte-semantically unchanged. |

Only this document, ROADMAP and service-api documentation change. None matches main-push
[service publication inputs](../.github/workflows/publish-service.yml); the slice is publication-neutral.
The cumulative prerequisite baseline includes service changes and is **not publication-neutral**;
publishing it still needs separate approval and schema-8-aware recovery/rollback precautions.
