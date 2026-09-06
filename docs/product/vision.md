# Cukup product vision

## Positioning

**Cukup is a privacy-first WakaTime for AI-assisted work.** It helps individual developers understand the time they spend collaborating with AI agents across projects, machines, and cloud sessions without collecting prompts or source code.

Short form: **Your AI-assisted work, measured automatically.**

WakaTime observes editor activity. AI billing dashboards report tokens and spend. Cukup's primary concern is the human time spent working with AI; full autonomous execution is a separate measurement.

## Audience

Cukup is personal-first software for individual AI-heavy developers. The current deployment is single-owner. The next product step is repeatable installation and safe Harness Adapter contribution for another individual, not team administration or organization surveillance.

## Metrics

### Working Time

Working Time answers: **How long was I actively collaborating with AI?**

An explicit human interaction creates or renews a 15-minute Engagement Window. Prompt composition, submission, follow-up, approval, and takeover qualify when a Harness Adapter can observe them without retaining content. Agent process liveness, generated output, completion, and waiting for approval do not prove human presence.

Different Harnesses expose different evidence. Adapters disclose their capabilities, and Cukup describes Working Time as a lower bound when composition cannot be observed. Cukup never backdates an unobserved window merely because a prompt was later submitted.

### Agent Runtime

Agent Runtime answers: **How long were my agents executing?**

It includes scheduled and unattended execution, is reported separately, and is never compared with a human work target. Runtime is useful context and may proxy human work, but the six hours an agent runs while its user sleeps are not six hours of Working Time.

Token usage and cost may later become separately named optional dimensions. They are not substitutes for either time metric.

## Product principles

1. **Meaning is shared; evidence is adapter-specific.** Amp and Tycho need not expose identical hooks, but every adapter preserves the same metric semantics.
2. **Local observation, minimal transmission.** High-frequency interaction signals are coalesced locally. Prompt content, drafts, keystrokes, paths, and native conversation identifiers never cross the shared boundary.
3. **No invented history.** Durable native timestamps may recover missed evidence. Otherwise measurement begins when observed; missing terminal facts remain crash-capped rather than receiving fabricated ends.
4. **Global time is a union.** Concurrent Harnesses, projects, and Executors do not inflate overall time.
5. **Attribution fails closed.** Exact normalized native project identities may map automatically; differences require explicit local aliases. Cukup never guesses from filesystem or repository metadata.
6. **Historical evidence is immutable.** New metric semantics start prospectively at an explicit transition. Existing v1/v2 evidence keeps its original interpretation.
7. **Personal before organizational.** Multi-user reporting, team controls, and organization trends remain later possibilities, not current requirements.

## Current product versus accepted direction

Production currently ingests Amp-derived event schemas v1/v2 and reports globally unioned turn intervals as Working Time using the historical 15-minute grace and crash-cap rules. The dashboard, project/executor attribution, exact-date targets, backups, and protected automatic deployment are live.

The accepted direction separates Engagement Window-based Working Time from Agent Runtime and introduces Harness Adapters, with Amp first and Tycho second. That future protocol and adapter implementation do not exist yet. See [ADR 0006](../adr/0006-harness-adapter-ports.md), the [Tycho contract](../tycho-adapter.md), and the [roadmap](../../ROADMAP.md).

## Non-goals for the next phase

- team productivity scoring or employee surveillance;
- inferring productivity from tokens, cost, output volume, or model choice;
- collecting prompt or source content;
- a public adapter SDK before a third Harness validates the internal port;
- changing historical v1/v2 evidence to fit the new metric model.
