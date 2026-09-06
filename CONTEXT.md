# Cukup

Cukup measures AI-assisted Working Time and Agent Runtime across supported Harnesses and presents one authoritative view without collecting prompt content.

> This glossary is the accepted product model for the Harness Adapter phase. Current production remains Amp-only v1/v2 and uses historical turn-interval Working Time; Engagement Windows and Agent Runtime are not implemented yet.

## Language

**Working Time**:
The union of Engagement Windows after Cukup's timezone and clipping rules. Working Time measures evidenced human collaboration with AI and is the only time metric compared with a work target.
_Avoid_: Agent Runtime, editor time, screen time, online time

**Agent Runtime**:
The union of observed intervals in which supported Harnesses execute work, including scheduled and unattended execution. Agent Runtime is reported separately and is never compared with a human work target.
_Avoid_: Working Time, human attention, productivity

**Harness**:
An AI-agent environment observed by Cukup, such as Amp or Tycho. A Harness is not an Executor: one Executor may run multiple Harnesses concurrently.
_Avoid_: Executor, model, provider

**Harness Adapter**:
The Cukup boundary that observes one Harness and translates its supported signals into harness-neutral evidence. Adapters may have different observation capabilities but must preserve the same timing and privacy semantics.
_Avoid_: Harness plugin, event uploader

**Adapter Capability**:
A declared category of evidence a Harness Adapter can observe, such as prompt composition, submission, approval, or runtime. Capability disclosure describes measurement coverage; it never changes the definition of Working Time. Missing composition capability means reported Working Time is a lower bound.
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
Harness-neutral evidence reconstructed from durable Harness state after a notification was missed. A durable native timestamp may retain its original instant; otherwise recovery begins only when observed. A missing terminal fact remains open and crash-capped rather than receiving a fabricated end.
_Avoid_: Synthetic lifecycle event, guessed timestamp, hook replay

**Authoritative Summary**:
The service-calculated daily or weekly classification of Working Time against its target.
_Avoid_: Local estimate, cached total

**Project Slug**:
A lowercase kebab-case classification resolved locally from an exact Harness-native project identity and attached to evidence for consistent filtering across Harnesses and Executors. An exact normalized identity may map automatically; differing identities require an explicit local alias. Invalid, missing, or ambiguous mappings remain Unassigned and are never guessed from workspace or repository metadata.
_Avoid_: Project Label, repository path, Git remote, package name, per-checkout setting

**Project Activity**:
The targetless union of Working Time intervals carrying one Project Slug. Project Activity is intentionally non-additive across slugs when concurrent projects overlap. Agent Runtime by project is a separate view.
_Avoid_: Project Working Time, allocated time

**Executor Label**:
The display classification for where work evidence originated: a Machine Label for physical hardware or `amp-orb` for an Amp-managed orb.
_Avoid_: Host, source identity, device ID

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
Working Time without a Project Slug, including historical evidence recorded before project attribution existed.
_Avoid_: Unknown project, uncategorized event
