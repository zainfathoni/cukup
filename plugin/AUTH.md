# Cukup plugin authentication boundary

`CUKUP_SERVICE_URL` is non-secret configuration. It must be HTTPS, except when the plugin talks to a loopback deployment proxy.

Authentication is selected from Amp's executor context:

- On an Amp-managed remote executor, the plugin mints one ephemeral workload token per sync cycle with `amp orb id-token --audience https://cukup.dev`. The default thread subject scope is intentional.
- On a local physical executor, `CUKUP_TOKEN_FILE` must point to an absolute, owner-owned regular file with no group or other permissions (mode `0600`). The machine secret owner provisions and rotates this file, for example through 1Password. The plugin rereads it for each sync cycle.
- An unknown executor fails closed.

The bearer value is held only in memory for the current sync cycle and sent only in the HTTPS `Authorization` header. It is never placed in command arguments, persisted in SQLite, included in event payloads, or logged. Do not put the bearer value itself in Amp configuration, shell profiles, workspace files, or ambient environment variables.
