Reworks the two dashboard visualizations that were carrying the least information per pixel.

## Activity timeline → Gantt lanes

The old timeline was a single row of unioned blocks. It could tell you *that* two things overlapped, via a dashed yellow block, but never *which* two.

It is now a lane chart. An `All selected` union row keeps the existing raw-evidence concurrency shading, then a `By project` group and a `By executor` group each get one lane per label with activity that day:

```
                     00:00   03:00   06:00   09:00   12:00   15:00   18:00
All selected  6h 20m ┃                        ▓▓▓▓   ▓▓█▓   ▓▓█▓            ┃
BY PROJECT           ┃                                                      ┃
cukup         4h 20m ┃                        ▒▒▒▒   ▒▒▒           ▒▒       ┃
deep-work-in… 1h 30m ┃                                 ▒▒▒▒                 ┃
personal-site 1h 36m ┃                                        ▒▒▒           ┃
BY EXECUTOR          ┃                                                      ┃
nixos-worksta 3h 10m ┃                        ░░░░   ░░░                    ┃
amp-orb       3h 50m ┃                                 ░░░░   ░░░░░         ┃
                                                                   ╎ NOW
```

Intervals are unioned *within* a lane, so a lane never overlaps itself and every vertical alignment across lanes is genuine concurrency — which is the whole point of the shape. Project lanes and executor lanes describe the same minutes, so the section says plainly that they must not be added.

Two smaller fixes in the same chart: lane strokes drop from 2px to 1px and the dashed concurrency stroke becomes a fill, which is what made the old cells read as heavy. And a `now` marker dims the rest of the day — `buildTimeline` clips at the current minute, so that tail was previously indistinguishable from idle time.

## Heatmap → hover detail cards

Each cell used to carry a `<title>` with a date and a total. Hovering now opens a card:

```
┌──────────────────────────────────┐
│ MON, AUG 31, 2026                │
│ 6h 20m                   [UNDER] │
│ Target 8h 0m · 1h 40m remaining  │
│ ─────────────────────────────    │
│ PROJECTS                         │
│ cukup 4h 20m · personal-site     │
│ 1h 36m · deep-work-… 1h 30m      │
│ EXECUTORS                        │
│ amp-orb 3h 50m · nixos-works…    │
│ 7 intervals · 08:15–16:30        │
│ Activity overlaps; never add up. │
└──────────────────────────────────┘
```

The heatmap moved from SVG rects to a CSS grid to make this possible. `style-src 'self'` forbids inline style attributes, so cell density is a class picked from the column count and the card's anchor edge is resolved server-side.

## Two judgment calls worth reviewing

**The card is pointer-only and `aria-hidden`,** rather than making up to 366 cells focusable. 366 new tab stops would be worse than what exists today. The keyboard path is the `View daily values` table, which gains target, status, intervals, first–last and both breakdowns — a net accessibility gain over the hover-only `<title>` it replaces. Below `56rem`, or on any device that cannot hover, the board scrolls horizontally and the card is disabled; those go together because a scroll container clips on both axes and would cut the card off.

**Day details carry a target,** which the docs previously scoped to the Overall panel alone. The heatmap renders the Overall series, which *is* the globally unioned target-bearing one, so this is consistent rather than new — but `docs/dashboard-service.md` now states it explicitly instead of leaving it inferable.

## Report shape

Needed new fields, so this reaches into `report-builder.ts`:

- `timeline.lanes` and `timeline.minutes`
- `trend.days`, one entry per date, each with a target-bearing verdict, interval count, first/last activity and non-additive project and executor breakdowns

`schema_version` stays at 1. The fields are additive and the only consumer is the client bundled from this same build.

While in there: each zoned day boundary is now resolved once per range instead of once per series, and `Intl.DateTimeFormat` instances are memoised. `render.ts` is bundled into `dashboard.js` and re-runs on every refresh, so a 366-day range was constructing formatters in the hundreds per render.

## Verification

`bun run check` is green — 157 tests, typecheck, build.

Behaviour was checked in Chromium against the fixture at 380/600/900/1100/1280/1600px across 7-, 90- and 366-day ranges: zero page-level horizontal overflow, and the hover card stays inside the viewport at the first, middle and last cell in every combination. Also checked the empty-timeline state (the every-morning case) and both `<details>` expanded.

## Not included

The trend line chart is an unreadable picket fence at a 366-day custom range. That predates this change and was outside the ask, but it is the obvious next fix in that section.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## E2E evidence

<details>
<summary>Local Chromium browser verification</summary>

Passed on the PR branch with a deterministic dashboard fixture and a matching `origin/main` baseline.

Result:
- The dashboard timeline changes from one unioned row to named project and executor Gantt lanes, retains concurrency shading, and marks unobserved future time with `now`.
- Hovering the final heatmap day opens a detail card with date, verdict, target, project/executor breakdown, interval span, and non-additive guidance.

Reproduction context:
- Browser: Chromium 152.0.7977.82, headless, 1440 × 1100 viewport.
- Surface: dashboard document (`/`), timeline and Overall day-by-day heatmap.
- Fixture: `service/dashboard/mockDashboardReport`, 7-day range, Asia/Jakarta.
- Interaction: load the page, then hover the final heatmap cell for `Mon, Aug 31, 2026`.

Console/network notes:
- No console errors or failed requests. The local harness served the favicon and did not invoke the authenticated report refresh POST.

![Annotated before/after comparison of PR #2 dashboard changes](docs/tests/github-2/assets/pr-2-dashboard-before-after.png)

This is local render verification of the dashboard UI and bundled client; OAuth, live service authentication, deployed routing, and the refresh API were not exercised in this visual scenario.

</details>
