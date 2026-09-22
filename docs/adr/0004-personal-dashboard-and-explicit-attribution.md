---
status: accepted
---

# Add a personal dashboard with explicit activity attribution

## Decision

Provide a single-owner, read-only dashboard at `cukup.dev`. Keep ingestion at `api.cukup.dev`. Use GitHub OAuth with an immutable owner ID, not a browser-visible machine bearer.

Keep Project and Executor Activity separate from overall target accounting. These views can overlap; they do not allocate human attention.

Bind physical Executor Labels to authenticated Bearer Lineages using canonical Fleet names. Keep missing attribution visible rather than guessing it or hiding evidence.

[ADR 0005](0005-derive-attribution-from-amp-project.md) replaces the original per-checkout project setting with Amp-owned selection. Keep native Amp Project IDs local.

## Approved target-override addendum

Permit an authenticated plugin workflow to change one Asia/Jakarta date's target. Allow full days off, half days, or restoration of the default. Require a preview and confirmation. Do not add free-text reasons or make the dashboard an editor.

Overrides change targets, not worked time or evidence. They do not create Project or Executor quotas.

## Considered alternatives

- Reject paths, Git remotes, and package names as project identity. They are not approved project classifications.
- Reject per-event machine claims and ephemeral orb hostnames. Executor identity belongs to the authenticated principal.
- Reject heartbeats as machine-health evidence. Inactivity does not establish failure.
- Reject a separate dashboard service and frontend framework. They add deployment and runtime boundaries without current product value.
- Reject splitting concurrent time between projects. Cukup cannot observe human attention allocation.

## Consequences

Keep dashboard filters out of URLs and logs because they contain project and machine labels. Do not add analytics or sensitive logging.

Keep mixed v1/v2 replay available after v2 emission. A rollback must preserve queued evidence, ownership, and historical meaning.

Deployment requires a dedicated GitHub OAuth application, protected secrets, a Fleet hostname allowlist, and separately approved DNS/TLS changes.

Use [dashboard operations](../dashboard-service.md) for setup and browser checks. Use [service operations](../service-operations.md) for the v4-aware rollback requirement. Read [dashboard source](../../service/dashboard/) for implementation.
