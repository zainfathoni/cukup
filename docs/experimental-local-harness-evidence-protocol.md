# Experimental local Harness evidence boundary

**Local experiment; generalization paused.** This is not a deployed service, stable SDK, or official Harness support promise. Production remains Amp-only v1/v2.

[ADR 0007](adr/0007-generic-harness-evidence-boundary.md) owns the design decisions. The [roadmap](../ROADMAP.md#generic-harness-adapter-initiative) owns the conditions for further work.

## What must a collector establish outside the protocol?

Schema conformance cannot prove that a native signal means what the collector claims. Verify origin, occurrence time, precision, recovery, and loss limits against supported Harness APIs.

- A submission is not necessarily human-origin evidence.
- A process lifetime is not necessarily execution time.
- A missing endpoint does not justify an invented end.
- A missing observation does not establish zero human work.
- A matching project name does not establish shared project identity.

Installing a collector is a trust decision. Closed-schema validation does not contain malicious code or prevent hidden data in allowed values.

Run collection at the execution site. Cross-host collection requires a separate authentication and attribution design. Do not assign remote work to the collector's machine.

## How can an approved local experiment run?

Use isolated, owner-only state. Do not use production databases or credentials.

Start the receiver in the foreground:

```sh
bun experimental/local-harness-evidence-receiver-command.ts \
  --state-directory /absolute/owner-only/runtime-state
```

Use an absolute, normalized, non-root directory. Keep the endpoint and receiver token at one execution site.

Send `SIGHUP` to rotate the token. Rotation has no overlap period. Send `SIGINT` or `SIGTERM` for a clean stop.

Keep tokens out of URLs, bodies, logs, and command arguments. Use the runtime's protected token file and authenticated local transport.

The command does not install a service or schedule collector delivery. Use the [Amp collector procedure](experimental-amp-shadow-collector.md) for an isolated synthetic exercise.

## Where is the executable contract?

- [Schema and negotiation](../experimental/local-harness-evidence.ts).
- [Conformance fixtures](../experimental/fixtures/local-harness-evidence.json).
- [Durable receiver](../experimental/local-harness-evidence-receiver.ts).
- [Authenticated local transport](../experimental/local-harness-evidence-http-server.ts).
- [Collector spool and explicit delivery](../experimental/local-harness-evidence-client.ts).
- [State ownership and credential rotation](../experimental/local-harness-evidence-runtime.ts).
- [Foreground command](../experimental/local-harness-evidence-receiver-command.ts).

Read these sources for fields, limits, outcomes, retry timing, and storage behavior. Do not maintain duplicate schema tables here.

## What remains unproven?

The [corrected orb proof](incidents/2026-09-13-experimental-amp-proof.md) used temporary activation. It did not establish repeatable installation, physical-machine support, human engagement evidence, or authoritative accounting.

Cloud protocol, cloud storage, aggregation, migration, and dashboard changes need separate review. Stable compatibility requires three real Harness integrations plus limited-capability and recovery tests.

An accounting transition also requires shadow validation, dashboard readiness, and owner approval. Local protocol acceptance does not satisfy those requirements.
