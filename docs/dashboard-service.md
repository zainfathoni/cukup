# Dashboard operations

The single-owner dashboard is deployed at `cukup.dev`. Ingestion stays at `api.cukup.dev`. This document does not authorize configuration or production changes.

## What external setup is required?

Create a dedicated GitHub OAuth application. Register this exact callback:

```text
https://${CUKUP_DASHBOARD_HOSTNAME}/auth/github/callback
```

Provision these values through protected runtime configuration:

- `CUKUP_GITHUB_OAUTH_CLIENT_ID`;
- `CUKUP_GITHUB_OAUTH_CLIENT_SECRET`;
- `CUKUP_GITHUB_ALLOWED_USER_ID`: the owner's immutable numeric ID, not a login name;
- `CUKUP_DASHBOARD_SESSION_KEYS`: comma-separated base64url 32-byte keys, newest first.

Keep the container port private to Kamal Proxy. Direct access would let a client forge trusted proxy headers.

Kamal Proxy 2.10.1 cannot set a health-check Host header. This limitation requires the host-independent `/up` route; public API liveness uses `/healthz`.

## How must session keys rotate?

Generate a key directly into the protected secret store. Do not capture its value in history, logs, or review artifacts.

1. Prepend the new key to the key ring.
2. Restart the service after approval.
3. Keep the prior key for at least seven days.
4. Remove it only after every session that used it has expired.

## Which browser cases need release checks?

For each dashboard release:

1. Verify exact host routing and credential separation.
2. Verify public TLS, `/up`, and API-host `/healthz`.
3. Test OAuth start, callback, report, and logout in a real browser.
4. Test guarded `Origin: null` logout.
5. Check URLs, logs, and assets for sensitive data.
6. Verify keyboard use, narrow layouts, reduced motion, and contrast.
7. Confirm that dashboard failures do not affect ingestion.
8. Verify database integrity, backup recovery, mixed-version ingestion, and the v4 rollback floor.

The `Origin: null` case matters because the `no-referrer` policy affects same-origin form navigation. Do not remove its fetch-site guard to fix logout.

## How do week changes affect filters?

Selecting a day in another ISO week clears both filter dimensions; selecting another day within the same week preserves them. Implicit Jakarta Sunday–Monday rollover also clears filters and reloads the report. Old-week options remain disabled during the transition, and superseded responses are not rendered.

## Where are implementation details defined?

Read [routing and configuration](../service/dashboard/backend.ts), [OAuth and sessions](../service/dashboard/auth.ts), and [report contracts](../service/dashboard/report.ts). Read [ADR 0004](adr/0004-personal-dashboard-and-explicit-attribution.md) for rationale, and [service operations](service-operations.md) for recovery.
