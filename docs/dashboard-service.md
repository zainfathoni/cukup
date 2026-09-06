# Dashboard service contract

The dashboard backend is part of the deployed Bun service, but it is a separate host and authentication boundary. The single-owner dashboard is live at `cukup.dev`; ingestion remains isolated at `api.cukup.dev`. This document records the active contract and does not by itself authorize configuration, credential, DNS/TLS, or production mutations.

## Host-first route matrix

The service compares the original `Host` with the two configured canonical hostnames before matching a path or authenticating a request. A hostname with a port, alternate casing, suffix, or unexpected value does not match. `X-Forwarded-Host` is ignored.

| Exact host | Routes | Authentication |
| --- | --- | --- |
| `CUKUP_API_HOSTNAME` (default `api.cukup.dev`) | `GET /healthz`, existing `/v1/*` | Existing physical bearer or Amp workload OIDC rules |
| `CUKUP_DASHBOARD_HOSTNAME` (default `cukup.dev`) | Routes below | Dashboard session cookie only |
| Anything else | None | Generic `404 not_found` |

`GET /up` is the sole host-agnostic exception. It returns only the same minimal readiness body used by the container and Kamal Proxy health checks, because Kamal 2.10.1 cannot configure a health-check `Host` header. The container port must remain private to Kamal Proxy; all other paths still pass through exact host routing. Public API health remains `GET /healthz` on the API host.

The dashboard host exposes:

- `GET /`: minimal sign-in page without a valid session; the dashboard document with a valid session, whose first paint uses the 30-day trend range;
- `GET /auth/github`: starts GitHub OAuth with a random state value and S256 PKCE;
- `GET /auth/github/callback`: accepts the one exact configured callback, exchanges the authorization code, fetches the authenticated GitHub user, and compares the numeric `id`;
- `POST /logout`: expires the session and transient OAuth cookies, then redirects to `/`;
- `GET /assets/dashboard.css` and `GET /assets/dashboard.js`: local build artifacts only;
- `GET /assets/favicon.svg`: an inline, locally served mark with no remote reference;
- `POST /dashboard/report`: same-origin, cookie-authenticated report operation.

Dashboard routes do not inspect `Authorization`; `/v1/*` does not inspect `Cookie`. A credential valid at one host therefore has no meaning at the other. Dashboard configuration failure returns the same generic not-found response as a disabled route and does not affect API health or ingestion startup.

When `CUKUP_BEHIND_TLS_PROXY=1`, secure routes require the single exact header value `X-Forwarded-Proto: https`. They do not accept comma-separated or case-varied values. This mode is safe only while the service port remains private to the trusted proxy; a client that can bypass that network boundary could supply proxy headers. Without proxy mode, the request itself must use HTTPS. The proxy must preserve the original `Host` and health-check the API host.

## Configuration

Host routing always exists. Dashboard routes are enabled only when every OAuth/session value below is present and valid:

| Environment variable | Contract |
| --- | --- |
| `CUKUP_API_HOSTNAME` | Optional canonical API hostname; defaults to `api.cukup.dev` |
| `CUKUP_DASHBOARD_HOSTNAME` | Optional canonical dashboard hostname; defaults to `cukup.dev` |
| `CUKUP_GITHUB_OAUTH_CLIENT_ID` | GitHub OAuth application client ID |
| `CUKUP_GITHUB_OAUTH_CLIENT_SECRET` | GitHub OAuth application client secret |
| `CUKUP_GITHUB_ALLOWED_USER_ID` | One positive immutable numeric GitHub user ID, not a login name |
| `CUKUP_DASHBOARD_SESSION_KEYS` | Comma-separated base64url-encoded 32-byte keys, primary first |

The callback is derived, not independently configurable:

```text
https://${CUKUP_DASHBOARD_HOSTNAME}/auth/github/callback
```

Generate a session key without recording it in shell history or logs, then put it directly into the protected secret store. One suitable generation pipeline is `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`. For rotation, prepend a new key, keep the prior key in the ring for at least seven days, restart, then remove the prior key after every cookie it encrypted has expired. Rotation has no SQLite migration.

Missing, malformed, partial, or incorrectly sized OAuth/session input disables all dashboard routes. It does not terminate the service process. The existing required ingestion inputs, including `CUKUP_OIDC_ALLOWED_USER_ID`, remain independent.

## OAuth and session design

OAuth state and the PKCE verifier live in an authenticated-encrypted `__Host-cukup_oauth` cookie for at most ten minutes. The browser-visible authorization URL contains the exact callback, state, S256 challenge, and no application redirect target. The token request uses the same exact callback. GitHub HTTP is injected behind an interface in tests, so the test suite makes no external requests.

After token exchange, the service calls `https://api.github.com/user` and accepts only the configured numeric `id`. Login, account mismatch, GitHub outage, malformed response, state failure, and code failure all produce the same generic account-authorization response. OAuth codes, access tokens, GitHub account fields, and cookie values are not logged.

The successful session is a purpose- and dashboard-host-bound AES-256-GCM envelope containing only the configured numeric subject and issued/expiry timestamps. It is stateless and survives service/SQLite restarts and temporary GitHub outages. Its fixed lifetime is seven days. The cookie is named `__Host-cukup_session` and always has:

```text
Secure; HttpOnly; SameSite=Lax; Path=/
```

It never has `Domain`. Duplicate cookie names, tampering, an unknown key, a different dashboard host, and expiry fail closed. Logout expires both `__Host-` cookies. Report and logout operations also reject an explicitly cross-origin `Origin` or `Sec-Fetch-Site` value.

An opaque `Origin: null` is not an explicitly cross-origin value. A same-origin form navigation from a `Referrer-Policy: no-referrer` document — which every dashboard response is — serializes its origin that way, so the sign-out form would otherwise fail in a real browser. An opaque origin is therefore decided by `Sec-Fetch-Site`, which must then be exactly `same-origin`; an absent or differing fetch site fails closed. A genuine cross-site post carries `Sec-Fetch-Site: cross-site`, a cross-origin `fetch` carries its real origin, and framing is already refused by `frame-ancestors 'none'` and `X-Frame-Options: DENY`.

## `POST /dashboard/report`

Selections exist only in the JSON request body. They never enter the URL, browser history, copied links, or request logs.

Preset request:

```json
{
  "projects": ["cukup", "Unassigned"],
  "executors": ["amp-orb"],
  "range": { "preset": 30 }
}
```

Custom request (both dates inclusive):

```json
{
  "projects": [],
  "executors": [],
  "range": {
    "preset": "custom",
    "start_date": "2025-09-01",
    "end_date": "2026-09-01"
  }
}
```

The request is a closed schema. Projects and executors must be unique exact values from the report's available-label lists. A preset is exactly `7`, `30`, or `90`. A custom range uses real `YYYY-MM-DD` civil dates, is ordered, and contains at most 366 inclusive days. The content type is `application/json`, and the body limit is 32 KiB. Invalid requests receive generic errors that do not echo selections.

Response schema 1 contains:

- `schema_version: 1`, UTC `as_of`, and `timezone: "Asia/Jakarta"`;
- `available_projects`, always including `Unassigned`, and source-derived `available_executors`;
- `overall`: globally unioned, target-bearing `today` and Monday-based current `week` values using authoritative exact-date target overrides;
- `timeline`: selected current-day intervals and raw-evidence concurrency markers;
- `trend`: globally unioned Overall Working Time plus independent, non-stacked, targetless selected Project, Executor, and combined series;
- `executors`: `occurred_at`-derived latest activity, `received_at`-derived latest synchronization, and `active`, `revoked`, or `not-applicable` credential state.

Every data section is a panel with `state: "ready"`, `"stale"`, or `"unavailable"`. The server marks an independently failed query unavailable; the browser preserves an earlier successful panel as stale. Neither layer substitutes zero for failure.

Aggregation first derives each mixed-v1/v2 session interval with the existing grace, crash-cap, monotonic-duration, clipping, Asia/Jakarta, and Monday rules. v1 and absent-v2 project attribution become `Unassigned`; executor attribution comes from stable source ownership. Values within one dimension use OR. Project and executor dimensions use AND. Each resulting set of underlying intervals is unioned before minutes are calculated. Displayed series are never added together, and filters never alter the global target-bearing Overall Working Time panel or series. Target overrides affect only that global Overall panel; activity evidence, worked minutes, filtered targetless series, and every dashboard route remain read-only.

All dashboard responses use `Cache-Control: no-store`, a restrictive Content Security Policy, frame denial, MIME sniffing protection, same-origin resource/opener policy, no-referrer, and a restrictive permissions policy. Executable JavaScript and CSS are bundled locally; there are no analytics, remote fonts, or external browser assets.

## Production acceptance and ongoing checks

The initial production gates passed before dashboard enablement: dedicated GitHub OAuth and immutable owner allowlisting, protected secret injection, dual-host proxy/DNS/TLS, real-browser sign-in/report/logout checks, guarded Chrome `Origin: null` logout, responsive 30-day first paint, mixed-v1/v2 preservation, backup verification, and migration-aware rollback retention.

For every dashboard-affecting release, continue to verify:

1. exact host routing and credential separation;
2. public TLS, `/up`, and API-host `/healthz`;
3. OAuth start/callback, authenticated report, cookie protections, and logout variants in a real browser;
4. no sensitive URL, response-log, application-log, or browser-asset leakage;
5. dashboard failures do not affect ingestion or API health;
6. database integrity, backup verification, mixed-version ingestion, and the migration-aware rollback floor.
