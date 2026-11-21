# Cukup

Cukup helps its owner understand time spent on AI-assisted work without collecting prompts or source code. It is not a productivity score.

**Current scope: personal Amp use.** An Amp-first open-source release is in preparation. It is not available yet: the repository is private, and independent self-hosting is not verified. Other harnesses, a stable SDK, and multi-user support are paused indefinitely. Experimental code is not a support promise. See the [roadmap](ROADMAP.md).

## Who owns this project?

Zain Fathoni owns product, privacy, and production decisions. This repository is the development source. The Amp Global User Plugins repository is a publication target, not a second development source.

[Fleet](https://github.com/zainfathoni/fleet/issues/30) coordinates machine rollout and operations. Cukup issues own product work. See the [ownership decision](docs/adr/0001-repository-ownership.md).

The initial six plugin files came from an uncommitted `work-hours/` prototype in the Amp User Plugins checkout. Development moved here before publication.

## What must readers know beyond the code?

- [Product vision](docs/product/vision.md): purpose, limits, and intended users.
- [Domain language](CONTEXT.md): what the terms mean, not how code implements them.
- [Decisions](docs/adr/0007-generic-harness-evidence-boundary.md): why future measurements must stay separate from historical totals.
- [Contribution rules](CONTRIBUTING.md): review requirements and authority limits.
- [Self-hosting](docs/self-hosting.md): install Cukup for one owner from source.
- [Operations](docs/service-operations.md): release, backup, and recovery procedures.
- [Production deployment](docs/production-deployment.md): infrastructure and access requirements.

## What does local development not provide?

Local checks do not require production access or authorize deployment. Amp supplies the runtime for published plugins; a separate Bun installation is development tooling only.

Contributions use the [MIT License](LICENSE).
