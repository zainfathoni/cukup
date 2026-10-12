# Cukup off-site backup pulls

## Status

Verify each backup client before you treat it as protected.

The service runs on an operator-managed host. Keep its address, topology, schedules, and retention settings in private operator configuration. Confirm the source path, SSH access, and remote `sudo` rule before setup.

## Pull policy

- Pull every six hours. Run once at setup or login as well.
- Accept a run only when the newest locally verified snapshot is no more than 24 hours old. Reject future or invalid creation times.
- Keep local pair directories for 30 days. Preserve the newest verified pair, even when it is older than 30 days.
- Keep the existing off-site operator pull schedule and files unchanged.
- Treat the 24-hour age check as a target. A sleeping or offline host cannot pull on schedule. Alert on missed checks and verify the timestamp when the host runs again.

The local layout is:

```text
~/.local/state/cukup-backups/pairs/<backup-id>/<backup-id>.sqlite
~/.local/state/cukup-backups/pairs/<backup-id>/<backup-id>.json
```

The tool checks each database with Cukup's existing verifier. It checks the metadata, file size, SHA-256, SQLite integrity, and schema version. It also checks that the pair ID and creation time match the files.

The tool downloads new pairs into a private temporary directory on the same file system as the local backup directory. It verifies each pair before it renames the pair directory into place. The two source files on the server use separate renames. The pull tool therefore treats the JSON file as a completion marker, retries incomplete listings, and fails if a pair stays incomplete. It does not publish partial pairs.

When a backup ID already exists locally, the tool verifies the local pair and downloads the server's JSON file into a new private staging directory. It requires the JSON bytes to match the locally verified metadata. It also runs an rsync checksum dry-run on the database. This detects normal changes without downloading the full database again. The checksum algorithm in older rsync versions is not SHA-256, so this check is not a cryptographic proof of the server's database bytes. The tool trusts the existing publisher's SHA-256 metadata as the backup identity. It fails on a metadata mismatch or a reported database change. It does not overwrite a published pair.

The pull uses rsync for listing, transfer, and comparison. Each remote rsync command uses the current Cukup access pattern:

```text
rsync --archive --rsync-path='sudo -n rsync'
```

SSH runs in batch mode. SSH host-key checks stay on. The tool does not forward the agent, install a key, or change remote privileges. The user must have a working SSH alias and a non-interactive `sudo -n rsync` rule on `production-host`.

The tool does not encrypt backup files. Confirm FileVault or full-disk encryption on each host before rollout. File permissions alone do not protect a lost or stolen disk.

## Monitoring

Use a separate Healthchecks check and URL for each host. Do not reuse a URL across hosts. Store each URL in that host's private config file:

```text
~/.config/cukup/backup-pull.json
```

The config file must belong to the current user and must not allow group or other access. The setup script creates it with mode `0600`. Add the `healthchecksPingUrl` field with a trusted editor. Do not put the URL in a command, scheduler unit, log, issue, or source file.

When a URL is set, the tool sends a start ping, then a success or failure ping. A backup failure stays a backup failure even if the failure ping also fails. A monitoring failure does not undo a verified backup. It sets `monitoring` to `failure` in the result and returns a nonzero exit status.

When no URL is set, the tool still pulls and verifies backups. It reports `monitoring: disabled`. This is not a monitored deployment. Record monitoring as pending until the host has its own check and an alert test has passed. Set a missed-check grace period that is shorter than the 24-hour age limit. A two-hour grace period is a useful starting point for a six-hour schedule; confirm it against each host's sleep pattern.

## Install on a target host

First confirm the host OS and tools:

```bash
uname -s
command -v bun
command -v ssh
command -v rsync
```

Use Bun 1.3 or newer. Use the Linux setup only when `uname -s` reports `Linux`. Use the macOS setup only when it reports `Darwin`. These scripts do not install cron or enable systemd lingering.

Use a current Cukup checkout on the target. Install the locked dependencies, then create the private config:

```bash
bun install --frozen-lockfile
bun run scripts/initialize-backup-pull-config.ts \
  "$HOME/.config/cukup/backup-pull.json" \
  "$(command -v ssh)" \
  "$(command -v rsync)"
```

The config starts with the `production-host` SSH alias and `/srv/example-cukup-backups`. Edit the file if the target uses another verified SSH alias. Confirm the host identity through a trusted channel before you accept a host key. Do not disable `StrictHostKeyChecking` to make setup pass.

Run a non-interactive SSH check as the normal user. The host key must already be trusted:

```bash
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes production-host true
```

Then run the platform setup. It builds a candidate Bun bundle in a private staging directory and runs a real manual pull with that candidate. Only a successful pull allows the setup to publish each installed asset and scheduler file through a same-filesystem atomic rename. A failed validation leaves existing managed assets and scheduler definitions unchanged. The setup refuses to replace an install directory or scheduler file without its Cukup ownership marker:

```bash
# macOS
bash scripts/setup-mac-backup-pull.sh

# Linux with a live systemd user manager
bash scripts/setup-linux-backup-pull.sh
```

Both scripts keep the SSH host key check on. They do not copy private keys or request root access. They keep the Healthchecks URL out of the scheduler. Each setup runs as the current user. The macOS setup also checks the LaunchAgent plist marker before it unloads an existing job.

The macOS LaunchAgent runs at load and every 21,600 seconds. The Linux systemd user timer runs at 00:15, 06:15, 12:15, and 18:15 local time. `Persistent=true` starts a missed Linux run when the user manager starts again. The Linux user manager stops when its session ends unless an administrator enables lingering. Do not enable lingering without approval. A laptop can still sleep through a schedule.

## Check the result

The pull command writes a JSON result with the newest backup ID and creation time. It does not write the ping URL. Logs stay under:

```text
~/.local/state/cukup-backups/logs/pull.log
~/.local/state/cukup-backups/logs/pull.err.log
```

The setup creates the log directory with mode `0700` and log files with mode `0600`.

Check the scheduler and logs:

```bash
# macOS
launchctl print "gui/$(id -u)/dev.zainfathoni.cukup.backup-pull"
tail -n 40 "$HOME/.local/state/cukup-backups/logs/pull.log"

# Linux
systemctl --user list-timers cukup-backup-pull.timer
systemctl --user start cukup-backup-pull.service
tail -n 40 "$HOME/.local/state/cukup-backups/logs/pull.log"
```

The Linux `start` command runs a real pull. Do not run it during a restore or while another pull is active. The local lock prevents two pulls from running at once.

Verify one retrieved pair with the existing command:

```bash
BACKUP_ID='replace-with-a-verified-id'
bun run service:db verify \
  "$HOME/.local/state/cukup-backups/pairs/$BACKUP_ID/$BACKUP_ID.sqlite" \
  "$HOME/.local/state/cukup-backups/pairs/$BACKUP_ID/$BACKUP_ID.json"
```

Perform a clean restore drill before you claim recovery readiness. Follow the steps in [the service operations runbook](service-operations.md). A successful pull is not a restore drill.

## Lock recovery

The tool does not take over a lock based on its age. After a forced kill, inspect the owner file and confirm that its process is not running before you remove the lock:

```text
~/.local/state/cukup-backups/pairs/.pull.lock/owner
```

Remove only `.pull.lock` after that check. The next run removes old `.pull-staging-*` directories after it acquires the lock. Do not remove a lock while a pull is active.

## Uninstall

Uninstall the scheduler first. Keep the config and backup files unless you have a separate approved deletion plan.

On macOS:

```bash
launchctl bootout "gui/$(id -u)/dev.zainfathoni.cukup.backup-pull"
rm "$HOME/Library/LaunchAgents/dev.zainfathoni.cukup.backup-pull.plist"
```

On Linux:

```bash
systemctl --user disable --now cukup-backup-pull.timer
rm "$HOME/.config/systemd/user/cukup-backup-pull.service"
rm "$HOME/.config/systemd/user/cukup-backup-pull.timer"
systemctl --user daemon-reload
```

## Host status

Do not use old machine notes as proof of current OS or access. Confirm each value on the host before installation.

| Host | OS | SSH and source access | Pull and schedule | Monitoring and restore |
| --- | --- | --- | --- | --- |

Never bypass host-key checks or copy private keys to work around these blockers. Verify the host identity and set up safe SSH access on each target before running its setup script.
