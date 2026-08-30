# ADR 0003: Vikas holds off-site SQLite backups

- Status: Accepted
- Date: 2026-08-30

## Context

Cukup's authoritative store is SQLite on `rumahberbagi`. A verified snapshot on the same VPS protects against application mistakes but not loss of that host or disk. Fleet mentioned Backblaze B2 only as a candidate whose existence and restore path had to be proven before it could become a dependency. Zain does not use B2 and does not want Cukup to introduce it.

## Decision

1. Cukup uses no B2 or other cloud object-storage dependency.
2. The service creates an online SQLite snapshot every six hours with `VACUUM INTO`, then verifies integrity and checksum metadata using Cukup's database tooling.
3. `rumahberbagi` retains verified database/metadata pairs for seven days.
4. `vikas-mac-mini` independently pulls the pairs over the existing SSH boundary once per day, verifies them locally, and retains them for 30 days.
5. The operational targets are RPO 24 hours and RTO 4 hours. A missed daily pull is a visible degraded-backup condition rather than a successful off-site backup.
6. A clean restore from a Vikas-held copy is required before production readiness and quarterly thereafter.

## Consequences

- Every authoritative database and backup remains an ordinary SQLite file paired with value-free verification metadata.
- Standard SSH and `rsync` are sufficient; no cloud account, bucket, application key, provider CLI, or `rclone` configuration is needed.
- Vikas availability determines whether the 24-hour off-site RPO is currently met. Seven days of local snapshots provide a catch-up window, not off-site protection.
- Adding a cloud provider later requires a new explicit decision and a proven credential, retention, retrieval, and clean-restore path.
