# Cukup

Cukup measures AI-assisted Working Time and Agent Runtime across supported Harnesses and presents one authoritative view without collecting prompt content.

> This glossary is the accepted product model for the Harness Adapter phase. Current production remains Amp-only v1/v2 and uses historical turn-interval Working Time; Engagement Windows and Agent Runtime are not implemented yet.

## Language

**Working Time**:
An interaction-based estimate of human collaboration with AI, calculated as the union of Engagement Windows after Cukup's timezone and clipping rules. Working Time is not measured attention and is the only time metric compared with a work target.
_Avoid_: Agent Runtime, measured attention, editor time, screen time, online time

**Agent Runtime**:
The union of evidenced agent execution intervals, including inference, tool execution, and scheduled or unattended execution, but excluding explicit waiting for human input. Agent Runtime is reported separately and is never compared with a human work target.
_Avoid_: Working Time, human attention, productivity, process lifetime, CPU time

**Harness**:
An AI-agent environment observed by Cukup, such as Amp or Tycho. A Harness is not an Executor: one Executor may run multiple Harnesses concurrently.
_Avoid_: Executor, model, provider

**Harness Adapter**:
An integration that observes one Harness and translates its supported signals into harness-neutral evidence with declared timing and privacy semantics. Its ownership and packaging do not determine its observation capabilities or official support status.
_Avoid_: Measurement policy, cloud event uploader

**Adapter Capability**:
A declared category of evidence a Harness Adapter can observe, such as prompt composition, submission, approval, or runtime, describing coverage rather than changing metric definitions. Missing observations make Working Time a lower bound on the window metric obtainable with richer coverage, not on actual human effort.
_Avoid_: Permission, feature flag, accuracy score

**Harness Type**:
The closed canonical classification identifying the Harness that produced Agent Runtime, such as `amp` or `tycho`. Harness Type may accompany future Agent Runtime evidence but does not partition or alter globally unioned Working Time.
_Avoid_: Model, provider, executable, native session identity

**Engagement Observation**:
Local timestamp-only evidence of an explicit human interaction with a Harness, such as composing or submitting a prompt, sending a follow-up, approving an action, or taking over a run. Process liveness, generated output, completion, and waiting for approval are not Engagement Observations. Prompt content and input details are never retained.
_Avoid_: Keystroke log, prompt event, Agent Runtime heartbeat

**Engagement Window**:
A bounded Working Time interval opened or renewed by an Engagement Observation and ending after 15 minutes without another observation. An adapter that cannot observe prompt composition starts no earlier than its first supported observation; Cukup never backdates an unobserved window.
_Avoid_: Agent run, activity session, inferred attention

**Recovered Evidence**:
Harness-neutral evidence reconstructed from durable Harness state after a notification was missed, retaining original occurrence timestamps only when their meaning is supported. Otherwise recovery begins when observed; missing runtime endpoints remain unresolved rather than receiving fabricated completion times.
_Avoid_: Synthetic lifecycle event, guessed timestamp, hook replay

**Authoritative Summary**:
The service-calculated daily or weekly classification of Working Time against its target.
_Avoid_: Local estimate, cached total

**Cukup Project**:
A stable classification of work shared across approved Harness mappings or explicit user bindings, whose identity survives changes to its name or slug. Renaming changes presentation, not which project owns attributed evidence.
_Avoid_: Harness-native project, Project Slug, repository

**Project Slug**:
A lowercase kebab-case name for a Cukup Project, distinct from its identity and refreshed from supported native project information for future activity. Old and new names may coexist in recorded activity after a rename; matching slugs alone do not establish that projects from different Harnesses are the same project.
_Avoid_: Project identity, repository path, Git remote, package name, per-checkout setting

**Project Activity**:
The targetless union of Working Time intervals attributed to one Cukup Project, independent of its name changes. Activity across projects is intentionally non-additive when intervals overlap; Agent Runtime by project is a separate view.
_Avoid_: Project Working Time, allocated time

**Executor Label**:
The display classification for where work evidence originated: a Machine Label for physical hardware or `amp-orb` for an Amp-managed orb.
_Avoid_: Host, source identity, device ID

**Execution Site**:
The authenticated execution environment where generic evidence originates. Its identity survives restart of that environment but not replacement by a different environment; a shared display label does not establish continuity.
_Avoid_: Executor Label, thread identity, project identity, credential

**Collector Instance**:
One durable evidence-collection lane at one Execution Site. Restart can continue the same lane, but a new instance cannot inherit another instance's evidence identity or close its unfinished execution.
_Avoid_: Process, token, Harness, Execution Site

**Executor Activity**:
The targetless union of Working Time intervals carrying one Executor Label. Executor Activity is intentionally non-additive across labels when concurrent Executors overlap. Agent Runtime by Executor is a separate view.
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
Working Time without a resolved project attribution, including historical evidence recorded before project attribution existed. Missing or ambiguous mappings remain Unassigned rather than being guessed from paths, repository metadata, or prompt content.
_Avoid_: Unknown project, uncategorized event
