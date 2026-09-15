# Stage 5AB: inactive authority-report codec

Status: **complete inactive pure-codec slice**. This implements only the bounded request/response
codec frozen by [Stage 5AA](stage-5aa-inactive-authority-report-transport.md) and the closed logical
semantics in [Stage 5Z](stage-5z-authority-report-envelope.md). It does not mount the reserved route,
read storage, construct authority data, change a dashboard/client/plugin, or activate any behavior.

[`service/authority-report-codec.ts`](../service/authority-report-codec.ts) accepts UTF-8 bytes and
performs a strict token pass before semantic decoding. It rejects BOM and malformed UTF-8, unpaired
surrogates, trailing JSON, duplicate decoded keys at every depth, keys over 64 decoded UTF-8 bytes,
value strings over 128 decoded UTF-8 bytes, more than 16 containers, arrays over 128 entries, and
numbers outside lexical `0|[1-9][0-9]*` or the safe-integer range. Request bodies are bounded at
1024 bytes and response bodies at 262144 bytes.

Requests contain only transport version 1 and a canonical, nonempty, at-most-31622400000 ms range.
Responses must match that admitted range exactly. The validator admits only the Stage 5AA
`current_use: forbidden`/null validity shape; exact unresolved refusals; or verified stale targetless
snapshots and payload-free metric failures partitioned into Stage 5Z legacy/generic sections.
Canonical timestamps, Jakarta Monday cutovers, elapsed/not-started rules, disclosure clipping,
unique 1..128-byte control-free labels, unknown synchronization, locally frozen version-1
capabilities/loss reasons, shared-declaration metric assessments, and 2-section/64-lane/per-lane
array limits are checked recursively. Unavailable required disclosures withhold both generic metrics.
One invalid nested value rejects the entire response. Encoding first performs the same validation,
then emits fixed field order and refuses output over the response budget. A token-only conformance
check supports isolated parser-budget and future final-serialized-byte validation; it does not
perform semantic admission, which always requires the typed request or response decoder.

Focused asymmetric tests cover both sides of byte and collection limits, strict JSON failures,
timestamp/range edges, section partitioning, unavailable versus observed zero, targetless stale
metrics, disclosure semantics, and whole-response rejection. The module has no barrel or runtime
import. A future route still requires separate owner-session admission, streaming/deadline/header
enforcement, authority/recovery construction, release fencing, and consumer work.

This `service/**` addition is publication-sensitive under the existing main-push workflow even
though it is inactive. No push, publication, deployment, production access, migration, cutover, or
activation is authorized. Rollback removes this isolated module, tests, and documentation; it must
not downgrade or discard cumulative prerequisite schema-8 state.
