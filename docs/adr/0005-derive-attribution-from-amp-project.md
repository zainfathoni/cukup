---
status: accepted
---

# Derive attribution from the exact Amp Project

Cukup derives each future Project Slug from the exact Amp Project selected by the executor instead of persisting a slug in per-checkout Amp settings. When the executor provides the immutable Amp Project ID, the plugin resolves it through Amp's supported exact project lookup and requires identity continuity in the response. Physical runners do not currently provide that ID, so the plugin instead asks Amp's supported project-status lookup to match the current workspace and accepts only one unambiguous `matched` Project whose canonical Project and match identities agree. Both paths normalize only the Project name returned by Amp and cache only successful resolution. A missing, failed, ambiguous, mismatched, or non-normalizable Project resolves visibly to Unassigned and is retried. Cukup does not derive a name itself from workspace paths, Git remotes, or package metadata.

Only the normalized Project Slug may cross Cukup's event boundary. The Amp Project ID and lookup response remain local and are never stored in Cukup events or logs. Existing turn snapshots and historical events remain immutable when a Project is renamed or this resolver changes.
