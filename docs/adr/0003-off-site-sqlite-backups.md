# ADR 0003: Independent SQLite backups

- Status: Accepted
- Date: 2026-08-30

## Context

Cukup stores authoritative data in SQLite on `production-host`. A snapshot on the same VPS does not protect against loss of that host or disk. Zain does not use Backblaze B2 and did not want Cukup to introduce it.

## Decision

1. Cukup uses no B2 or other cloud object-storage dependency.
2. At the configured interval, create an online SQLite snapshot with `VACUUM INTO`. Verify its integrity and checksum metadata.
3. Retain verified database and metadata pairs on the source according to the configured retention policy.
4. An independent backup host pulls the pairs over SSH, verifies them, and applies its retention policy.
5. Set recovery objectives in the private operator runbook. Report a missed pull as degraded backup protection.
6. Prove a clean restore from an off-site copy before production and at the approved interval.

## Consequences

- Each backup is an ordinary SQLite file with value-free verification metadata.
- SSH and `rsync` are sufficient. No cloud storage credentials or tools are required.
- Backup host availability determines whether Cukup meets the off-site RPO. Local snapshots provide a catch-up window, not off-site protection.
- A future cloud provider requires a new decision and a proved restore path.
