# PR #2 design and verification record

This is a historical record, not the current UI specification. See [PR #2](https://github.com/zainfathoni/cukup/pull/2).

## Why change the charts?

The old timeline showed overlap without identifying concurrent projects or executors. The old heatmap exposed too little daily detail.

The change added named lanes and hover cards. A `now` marker distinguished unobserved future time from idle time.

## Which tradeoffs mattered?

- Keep the hover card pointer-only and `aria-hidden` at this stage. Up to 366 new tab stops would harm keyboard use.
- Provide equivalent details in the `View daily values` table.
- Disable hover cards below `56rem` and without hover support at this stage. The narrow scroll container would clip them.
- Permit targets in day details because the heatmap shows Overall Working Time, not filtered quotas.
- Keep response schema 1 because fields were additive and the only client shipped with the same build.

Later date-selection work changed the narrow-screen and keyboard interactions. See its [evidence record](../heatmap-date-selection/e2e-evidence.md).

## What was verified then?

`bun run check` passed 157 tests, typecheck, and build.

Chromium checks covered widths of 380, 600, 900, 1100, 1280, and 1600px, with 7-, 90-, and 366-day ranges. No page-level horizontal overflow occurred. Cards stayed inside the viewport at first, middle, and last cells. Checks included an empty timeline and expanded details.

The [E2E record](e2e-evidence.md) contains the comparison image, environment, and limits. OAuth, live authentication, deployed routing, and report refresh were not exercised in that visual scenario.

The 366-day trend line remained hard to read. That pre-existing issue was outside this change.
