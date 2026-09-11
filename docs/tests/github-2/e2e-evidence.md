# E2E evidence: dashboard Gantt lanes and day-detail cards

Environment:
- PR: [#2](https://github.com/zainfathoni/cukup/pull/2)
- Branch: `feat/dashboard-gantt-and-day-details`
- Commit: `c2bcc11748769bb60338638e8e07ea4b61afbff8`
- Browser: Chromium 152.0.7977.82, headless, 1440 × 1100 viewport
- Candidate surface: local static browser harness serving the authenticated dashboard document and bundled client from this branch
- Baseline surface: the same harness from `origin/main`
- Fixture: `service/dashboard/mockDashboardReport`, 7-day range, Asia/Jakarta

## Summary

- Gantt timeline: passed. The candidate names project and executor lanes, preserves the union row and concurrency shading, and marks the unobserved future with `now`.
- Day-detail card: passed. Hovering the final heatmap day opens a card with date, verdict, target, project/executor breakdown, interval span, and non-additive guidance.
- Browser console/network: passed. No console errors or failed requests after serving the local favicon; the scenario did not invoke the authenticated report refresh POST.

## Evidence

### Before/after dashboard visualization comparison

Result:
- The baseline single-row timeline is contrasted with the candidate's named Gantt lanes and explicit `now` marker.
- The candidate hover state is shown with the detail card outlined; its content remains available in the daily-values table for the keyboard path.

Reproduction context:
- Route/surface: dashboard document (`/`) rendered in the local browser harness; timeline section and Overall day-by-day heatmap.
- Interaction: load the page, then hover the final heatmap cell for `Mon, Aug 31, 2026`.
- Data: deterministic `mockDashboardReport`; no customer or merchant data.

![Annotated before/after comparison of PR #2 dashboard changes](./assets/pr-2-dashboard-before-after.png)

Limitations:
- This is local render verification of the dashboard UI and bundled client. OAuth, live service authentication, deployed routing, and the refresh API were not exercised in this visual scenario.
