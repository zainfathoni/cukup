---
status: accepted
---

# Derive attribution from the exact Amp Project

Amp owns project selection. Replace per-checkout Cukup settings with the exact Amp Project, so attribution does not depend on separate repository configuration.

Prefer Unassigned work to a guessed identity. Paths, Git remotes, and package names are not project authority.

Only the normalized Project Slug can cross the event boundary. Keep native Project IDs and lookup responses local and out of logs.

Renames and resolver changes affect future evidence. They must not rewrite accepted snapshots or historical events.

Read [the Amp adapter](../../plugin/legacy-amp-adapter.ts) and [project validation](../../plugin/project.ts) for lookup, normalization, and failure behavior.
