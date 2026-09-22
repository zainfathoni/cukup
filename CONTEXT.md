# Cukup language

These terms define the accepted product model. They do not claim implementation or deployment; see the [roadmap](ROADMAP.md) for scope.

## Language

**Working Time**:
An estimate of human collaboration from the union of Engagement Windows. It is the only time metric compared with a work target.
_Avoid_: Agent Runtime, measured attention, screen time

**Agent Runtime**:
The union of evidenced agent execution intervals, including unattended execution but excluding explicit waits for human input. It has no human work target.
_Avoid_: Working Time, process lifetime, CPU time, productivity

**Harness**:
An AI-agent environment, such as Amp or Tycho. One Executor can run multiple Harnesses.
_Avoid_: Executor, model, provider

**Harness Adapter**:
An integration that converts supported Harness signals into evidence independent of the Harness. Ownership and packaging do not establish official support.
_Avoid_: Measurement policy, cloud event uploader

**Adapter Capability**:
A category of evidence that an adapter can observe. Limited capability means limited coverage, not a different metric definition.
_Avoid_: Permission, feature flag, accuracy score

**Harness Type**:
The canonical Harness classification for Agent Runtime, such as `amp` or `tycho`. It does not partition Working Time.
_Avoid_: Model, provider, native session identity

**Engagement Observation**:
Timestamp-only evidence of an explicit human interaction with a Harness. Execution, generated output, and waits for approval are not human interactions.
_Avoid_: Keystroke log, prompt content, runtime heartbeat

**Engagement Window**:
A Working Time interval opened or renewed by an Engagement Observation, ending after 15 minutes without another observation. It cannot start before supported evidence.
_Avoid_: Agent run, inferred attention

**Recovered Evidence**:
Evidence reconstructed from durable Harness state, with original timestamps only when their meaning is supported. Unknown runtime endpoints remain unresolved.
_Avoid_: Guessed timestamp, synthetic lifecycle event

**Authoritative Summary**:
The service's daily or weekly comparison of Working Time with its target.
_Avoid_: Local estimate, cached total

**Cukup Project**:
A stable work classification shared through approved Harness mappings or explicit user bindings. Its identity survives name changes.
_Avoid_: Harness-native project, Project Slug, repository

**Project Slug**:
A lowercase kebab-case project name, not its identity. Matching names do not prove that projects are the same.
_Avoid_: Project identity, repository path, Git remote

**Project Activity**:
The targetless union of Working Time for one Cukup Project. Overlapping project totals must not be added together.
_Avoid_: Allocated time, Project Working Time

**Executor Label**:
A display classification for where evidence originated: a Machine Label or `amp-orb`.
_Avoid_: Host, device ID, source identity

**Executor Activity**:
The targetless union of Working Time for one Executor Label. Overlapping executor totals must not be added together.
_Avoid_: Per-device allocation, Machine Working Time

**Machine Label**:
The canonical Fleet name of a physical machine.
_Avoid_: Hostname, device ID, source instance ID

**Bearer Lineage**:
A physical machine credential and its rotation replacements, with the same Machine Label and source ownership.
_Avoid_: Token ID, bearer value

**Unassigned Executor**:
The Executor Label for physical evidence whose Bearer Lineage never had a Machine Label.
_Avoid_: Unknown machine, hidden evidence

**Unassigned Work**:
Working Time without resolved project attribution. Missing or ambiguous mappings do not permit guesses from paths, repository metadata, or content.
_Avoid_: Unknown project, uncategorized event
