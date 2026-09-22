# Shared service API boundary

`api.cukup.dev` is the deployed authority for historical Amp-based Working Time. Production accepts v1/v2, not the future metrics in [ADR 0007](adr/0007-generic-harness-evidence-boundary.md).

## What must an integration preserve?

Accepted evidence keeps its original meaning. Do not rewrite records to repair a conflict or change historical totals to match a new metric.

A version preference controls new evidence, not permission to discard old evidence. Keep delayed v2 delivery available after a return to v1 starts.

Use HTTPS. Keep credentials out of URLs and logs. Treat health responses as liveness only, not proof of database integrity or successful authentication.

Obtain physical credentials through the [operator procedure](service-operations.md#physical-machine-bearer-lifecycle). Do not give them to Amp orbs.

## Where is the executable contract?

- [Routes and responses](../service/app.ts).
- [Closed event schemas and validation](../service/protocol.ts).
- [Client requests and response validation](../plugin/protocol.ts).
- [Authentication](../service/auth.ts).
- [Historical time calculation](../service/aggregation.ts).
- [Integration tests](../service/integration.test.ts).

Read these sources for field names, limits, error codes, and examples. This document does not maintain a second API specification.
