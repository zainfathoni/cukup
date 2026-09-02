---
status: accepted
---

# Derive attribution from the exact Amp Project

Cukup derives each future Project Slug from the exact Amp Project selected by the executor instead of persisting a slug in per-checkout Amp settings. The plugin resolves the immutable Amp Project ID through Amp's supported project lookup, requires identity continuity in the response, normalizes only the returned Project name, and caches only successful resolution. A missing, failed, mismatched, or non-normalizable Project resolves visibly to Unassigned and is retried rather than guessed from workspace paths, Git remotes, or package metadata.

Only the normalized Project Slug may cross Cukup's event boundary. The Amp Project ID and lookup response remain local and are never stored in Cukup events or logs. Existing turn snapshots and historical events remain immutable when a Project is renamed or this resolver changes.
