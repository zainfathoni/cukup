# Cukup

Cukup measures Zain's Amp-backed working time across executors and presents one authoritative view of that work.

## Language

**Working Time**:
The union of Amp-backed work intervals after Cukup's grace, crash-cap, timezone, and clipping rules.
_Avoid_: Editor time, screen time, online time

**Authoritative Summary**:
The service-calculated daily or weekly classification of Working Time against its target.
_Avoid_: Local estimate, cached total

**Project Slug**:
A lowercase kebab-case classification derived from the exact Amp Project identity and attached to Working Time for consistent project filtering across executors.
_Avoid_: Project Label, repository path, Git remote, package name, per-checkout setting

**Project Activity**:
The union of work intervals carrying one Project Slug. Project Activity is intentionally non-additive across slugs when concurrent projects overlap.
_Avoid_: Project Working Time, allocated time

**Executor Label**:
The display classification for where work evidence originated: a Machine Label for physical hardware or `amp-orb` for an Amp-managed orb.
_Avoid_: Host, source identity, device ID

**Executor Activity**:
The union of work intervals carrying one Executor Label. Executor Activity is intentionally non-additive across labels when concurrent executors overlap.
_Avoid_: Machine Working Time, per-device allocation

**Machine Label**:
The canonical Fleet name of the physical machine that produced work evidence.
_Avoid_: Hostname, device ID, source instance ID

**Bearer Lineage**:
A physical machine credential and its rotation replacements, which retain one Machine Label and the same owned sources.
_Avoid_: Token ID, bearer value

**Unassigned Executor**:
The Executor Label for physical evidence whose Bearer Lineage never bound to a canonical Machine Label.
_Avoid_: Unknown machine, hidden evidence

**Unassigned Work**:
Working Time without a Project Slug, including historical evidence recorded before project attribution existed.
_Avoid_: Unknown project, uncategorized event
