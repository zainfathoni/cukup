# Dashboard phase record

**Historical plan; implementation complete.** The dashboard and v2 attribution are deployed. This record does not authorize another rollout.

## Why was this phase needed?

The owner needed a dashboard that remained available when Amp executors were offline. The phase added presentation and attribution without changing historical Working Time.

The original plan used per-checkout Project Slug settings. [ADR 0005](adr/0005-derive-attribution-from-amp-project.md) replaced that proposal with Amp-owned project selection.

## Which decisions still matter?

- Keep the dashboard personal and read-only.
- Do not infer machine health from recent activity.
- Do not divide concurrent time between projects without evidence of human attention.
- Keep protocol migration separate from behavior enablement.

The implementation sequence was protocol and persistence, plugin attribution, dashboard backend, dashboard UI, then production operations.

## Where are the current requirements?

- [ADR 0004](adr/0004-personal-dashboard-and-explicit-attribution.md): decisions and rejected alternatives.
- [Dashboard operations](dashboard-service.md): OAuth setup and release checks.
- [Service operations](service-operations.md): recovery and migration-aware rollback.
- [PR #2 evidence](tests/github-2/e2e-evidence.md): historical browser results and their limits.

Read [dashboard source](../service/dashboard/) for implemented behavior. Do not use this historical plan as a second implementation specification.
