# Plugin credential ownership

The machine's secret owner provisions and rotates physical-machine credentials, for example through 1Password. Do not put bearer values in Amp settings, shell profiles, workspace files, or environment variables.

Provision the token as an owner-owned file with mode `0600`. The default location is `~/.config/cukup/token`. Use `CUKUP_TOKEN_FILE` only for an absolute-path override.

Amp supplies workload identity for orbs. The default thread subject scope is intentional; do not broaden it to bypass an authorization failure.

See [auth.ts](auth.ts) for credential validation and [index.ts](index.ts) for executor selection. See [service operations](../docs/service-operations.md) for issuance, rotation, and recovery.
