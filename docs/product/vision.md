# Cukup product vision

## Positioning

**Cukup is a privacy-first WakaTime for AI-assisted work.** It helps individual developers understand the time they spend collaborating with AI agents across projects, machines, and cloud sessions without collecting prompts or source code.

Short form: **Your AI-assisted work, measured automatically.**

WakaTime observes editor activity. AI billing dashboards report tokens and spend. Cukup's primary concern is the human time spent working with AI; full autonomous execution is a separate measurement.

## Audience

Cukup is personal-first software for individual AI-heavy developers. The current deployment is single-owner. The next product step is repeatable installation and safe Harness Adapter contribution for another individual, not team administration or organization surveillance.

## Metrics

### Working Time

Working Time answers: **How much collaboration time do my observed interactions with AI suggest?** It is an interaction-based estimate, not measured attention.

An explicit human interaction creates or renews a 15-minute Engagement Window. Prompt composition, submission, follow-up, approval, and takeover qualify when a Harness Adapter can observe them without retaining content. Agent process liveness, generated output, completion, and waiting for approval do not prove human presence.

Different Harnesses expose different evidence. Missing observations make Working Time a lower bound on the window metric obtainable with richer coverage, not on actual human effort. Adapters disclose their capabilities, and Cukup never backdates an unobserved window merely because a prompt was later submitted.

### Agent Runtime

Agent Runtime answers: **How long were my agents executing?**

It includes inference, tool execution, and scheduled or unattended execution, but excludes explicit waiting for human input. It is reported separately and is never compared with a human work target: six hours of execution while its user sleeps are not six hours of Working Time. A managed run's elapsed lifetime is not automatically evidence of execution throughout that interval.

Token usage and cost may later become separately named optional dimensions. They are not substitutes for either time metric.

Before new measurements become authoritative in the dashboard, it must distinguish target-bearing **Working Time · estimated**, targetless **Agent Runtime**, and historical **Legacy Working Time · turn-based** with its original totals. These overlapping metrics are never added together, including in charts, filters, and summaries. Initial Agent Runtime totals include only closed execution intervals with defensible endpoints; observable unfinished work is pending, not provisional duration. A third elapsed-run metric is deferred.

The dashboard distinguishes limited capability, known collection gaps, and unavailable data rather than substituting zero or implying complete measurement. Live-only collectors may contribute with explicit loss/recovery limitations. Layout and transition details remain under design; these are rollout requirements, not claims about the current dashboard.

## Product principles

1. **Meaning is shared; evidence is adapter-specific.** Amp and Tycho need not expose identical hooks, but every adapter preserves the same metric semantics.
2. **Local observation, minimal transmission.** High-frequency interaction signals are coalesced locally. Prompt content, drafts, keystrokes, paths, and native conversation identifiers never cross the shared boundary.
3. **No invented history.** Durable native occurrence timestamps with supported meaning may recover missed evidence. Otherwise measurement begins when observed; missing runtime endpoints remain unresolved rather than receiving fabricated ends. Historical v1/v2 crash-cap behavior remains unchanged.
4. **Global time is a union.** Concurrent Harnesses, projects, and Executors do not inflate overall time.
5. **Attribution fails closed.** Native identities require approved mappings to stable Cukup Projects; matching names alone never merge projects across Harnesses. Without a stable path-free native identity, the user may explicitly bind a launch or session to an existing project; absent or ambiguous binding stays Unassigned. Project identity survives renaming, and attribution is never guessed from paths, repository metadata, or prompt content.
6. **Historical evidence is immutable.** New metric semantics start prospectively at an explicit transition. Existing v1/v2 evidence keeps its original interpretation. Late evidence may update earlier totals based on when it occurred, without rewriting accepted records or treating upload time as work time.
7. **Personal before organizational.** Multi-user reporting, team controls, and organization trends remain later possibilities, not current requirements.
8. **Measurement must not obstruct work.** Collection failures are surfaced and replayed where supported; irrecoverable gaps are disclosed rather than blocking AI work indefinitely or inventing evidence.
9. **Keep routine changes automatic.** Pick up native project renames for future activity without a rename approval workflow or historical relabeling. Old and new labels may coexist during refresh; occasional attribution inconsistencies are acceptable, but privacy and metric semantics are not relaxed.

## Current product versus accepted direction

Production currently ingests Amp-derived event schemas v1/v2 and reports globally unioned turn intervals as Working Time using the historical 15-minute grace and crash-cap rules. The dashboard, project/executor attribution, exact-date targets, backups, and protected automatic deployment are live.

The accepted direction separates Engagement Window-based Working Time from Agent Runtime and introduces a generic evidence boundary with first-party reference collectors and independently maintained integrations. Its [experimental local message contract](../experimental-local-harness-evidence-protocol.md) and synthetic conformance fixtures exist, but no receiver, collector, new metric, or adapter support is deployed. [ADR 0007](../adr/0007-generic-harness-evidence-boundary.md) records decisions from the completed owner interview and supersedes [ADR 0006](../adr/0006-harness-adapter-ports.md). The [roadmap](../../ROADMAP.md) sequences independently reviewable slices; [Tycho collector guidance](../tycho-adapter.md) does not make the unmerged Tycho fork an accepted dependency.

## Non-goals for the next phase

- team productivity scoring or employee surveillance;
- inferring productivity from tokens, cost, output volume, or model choice;
- collecting prompt or source content;
- a stable adapter compatibility promise before three real harness integrations and weak-capability/recovery tests validate the experimental, version-negotiated local protocol;
- changing historical v1/v2 evidence to fit the new metric model.
