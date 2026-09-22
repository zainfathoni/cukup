# ADR 0003: Vikas holds off-site SQLite backups

- Status: Accepted
- Date: 2026-08-30

## Context

Cukup stores authoritative data in SQLite on `rumahberbagi`. A snapshot on the same VPS does not protect against loss of that host or disk. Zain does not use Backblaze B2 and did not want Cukup to introduce it.

## Decision

1. Cukup uses no B2 or other cloud object-storage dependency.
2. Create an online SQLite snapshot every six hours with `VACUUM INTO`. Verify its integrity and checksum metadata.
3. `rumahberbagi` retains verified database/metadata pairs for seven days.
4. `vikas-mac-mini` pulls the pairs over SSH each day. It verifies them locally and retains them for 30 days.
5. Use an RPO of 24 hours and an RTO of 4 hours. Report a missed daily pull as degraded backup protection.
6. Prove a clean restore from a Vikas-held copy before production and each quarter.

## Consequences

- Each backup is an ordinary SQLite file with value-free verification metadata.
- SSH and `rsync` are sufficient. No cloud storage credentials or tools are required.
- Vikas availability determines whether Cukup meets the off-site RPO. Local snapshots provide a catch-up window, not off-site protection.
- A future cloud provider requires a new decision and a proved restore path.
