# Self-host Cukup for one owner

Use a separate installation and an empty SQLite volume for each owner. Cukup supports Amp only. There is no public signup. Changing an allowed owner ID on a populated volume does not migrate data or revoke machine tokens. Do not reuse a populated volume for a different owner.

The service uses Asia/Jakarta for dates and Monday as the start of the week. These rules are not configurable. By default, new turns have no project attribution. They appear as Unassigned and count as Play. Use All to see time across all projects.

## 1. Set up the two hosts and owner accounts

Use a Linux `amd64` server with Docker Engine 28 or later, [Caddy](https://caddyserver.com/docs/install), `openssl`, and `jq`. Point two DNS names that you control at the server. The examples use `api.cukup.example.com` for sync and `cukup.example.com` for the dashboard. Replace these names in all commands and settings. Permit inbound TCP 80 and 443 for Caddy. Do not permit public access to port 3000.

Create a [GitHub OAuth App](https://github.com/settings/developers) in your own account. Use `https://cukup.example.com` as its homepage and `https://cukup.example.com/auth/github/callback` as its authorization callback URL. Generate a client secret. Use the `id` number from `https://api.github.com/users/YOUR-GITHUB-LOGIN` for `CUKUP_GITHUB_ALLOWED_USER_ID`, not the login name or the OAuth client ID.

Use your Amp account's `user_id` claim for `CUKUP_OIDC_ALLOWED_USER_ID`. To find it, run this in a fresh orb that belongs to your account, not in a shared thread. The command prints only the ID, not the token:

```sh
amp orb id-token --audience https://cukup.dev | python3 -c 'import base64,json,sys; p=sys.stdin.read().strip().split(".")[1]; print(json.loads(base64.urlsafe_b64decode(p+"="*(-len(p)%4)))["user_id"])'
```

Keep `https://cukup.dev` as the Amp token **audience**. The plugin and service use this same audience for all installations. It does not select an installation or set the plugin's network destination.

## 2. Build and start the service

Run these commands only for a fresh install, from a clean source checkout. Keep the real environment file outside the checkout. Replace the placeholders with your hostnames, IDs, OAuth credentials, and a session key. To generate a session key, run `openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'` in a private terminal. Do not share the result.

To record project attribution for new turns, set `CUKUP_NEW_TURN_EVENT_SCHEMA_VERSION=2` in the service environment file. If you use local Amp executors, also set `CUKUP_FLEET_HOSTNAMES` to a comma-separated list of their exact OS hostnames. The service rejects the executor profile of a local machine that is not on this list. This blocks sync for that machine.

Set `CUKUP_WORK_PROJECTS` in the same file to the exact Amp project slugs that count as Work, separated by commas. For example, use `CUKUP_WORK_PROJECTS=client-portal,documentation`. If unset or blank, no project counts as Work. All other projects and Unassigned count as Play. Recreate the container with the updated environment file to change the list. Reports apply the new list to past and future turns without rewriting stored data.

```sh
umask 077
mkdir -p "$HOME/.config/cukup-server"
install -m 600 .env.example "$HOME/.config/cukup-server/service.env"
${EDITOR:-vi} "$HOME/.config/cukup-server/service.env"

docker build --platform linux/amd64 -f Dockerfile.service -t cukup-service:self-host .
docker volume create cukup-data
docker run -d --name cukup --restart unless-stopped \
  --env-file "$HOME/.config/cukup-server/service.env" \
  --mount source=cukup-data,target=/var/lib/cukup \
  -p 127.0.0.1:3000:3000 cukup-service:self-host
```

Use a new volume name if `cukup-data` already exists. Keep the whole `/var/lib/cukup` directory on that volume, including SQLite sidecar files. Do not use the repository's production deployment script for a new install.

Configure both sites in your host's Caddyfile and reload Caddy. Caddy obtains and renews TLS certificates, preserves the request host, and sets `X-Forwarded-Proto`. Cukup trusts the proxy header, so keep its backend listener on loopback and give only trusted operators access to the server and Docker.

```caddyfile
api.cukup.example.com, cukup.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

From another machine, check that `https://api.cukup.example.com/healthz` returns 200, that the dashboard shows GitHub sign-in over HTTPS, and that port 3000 is not reachable on the server's public address. Sign in with the permitted GitHub account. Check that a different GitHub account cannot sign in. Use separate browser sessions to avoid reusing a valid dashboard cookie.

## 3. Build and configure the Amp plugin

On a machine with Bun installed, run `bun install --frozen-lockfile` and `bun run build:plugin` in the checkout. Install `dist/plugin.js` as `cukup.js` in one of the [Amp plugin locations](https://ampcode.com/docs/customize/plugins#plugin-locations-and-precedence). For a local install, use `~/.config/amp/plugins/cukup.js` (or `$XDG_CONFIG_HOME/amp/plugins/cukup.js` when set). For orbs, use your own personal plugin repository, or put the bundle in `.amp/plugins/cukup.js` in a project that the orb checks out. Do not install two copies in the same executor.

Set `CUKUP_SERVICE_URL=https://api.cukup.example.com` in the environment of **each** executor that uses the plugin. Export it before starting local Amp. For orbs add it to your [personal Amp environment variables](https://ampcode.com/docs/orbs/handling-secrets) and start a fresh orb. Use the API origin over HTTPS, without a path. An unset or blank value disables all Cukup delivery, not local turn tracking. New turns recorded in this state stay Unassigned and count as Play after sync. If you already use Cukup, set the destination before you replace the plugin.

For each local machine, issue a separate bearer token on the server. Redirect the output to a new protected file. Do not print the token or pass it on a command line.

```sh
umask 077
docker exec cukup bun /app/token-admin.js issue > machine-token.json
```

Use a secure transfer method to copy the JSON to that machine. Keep the nonsecret `token_id` for revocation. On the local machine, use `jq` to extract the `token` field alone:

```sh
umask 077
install -d -m 700 "$HOME/.config/cukup"
jq -er .token machine-token.json > "$HOME/.config/cukup/token"
chmod 600 "$HOME/.config/cukup/token"
```

Remove the JSON transfer copies after you confirm sync. For a different file location, set `CUKUP_TOKEN_FILE` to an absolute path. Never copy a machine token to an orb. The plugin mints an Amp workload identity token in the orb instead.

Restart local Amp or start a fresh orb after setup. Complete a turn in each executor, then run the Cukup **Status** command. Check for authoritative status and no pending or rejected events. Check the dashboard for the corresponding activity. A missing or bad bearer and an Amp token from a different account must not authorize API requests. To test the latter, send a token from a second account to the test API without enabling event sync for that account.

## 4. Verify restart and recovery

Restart with `docker restart cukup`. Check that existing totals remain and that a new turn syncs. For an online backup, use the SQLite backup command, not a copy of the running database:

```sh
umask 077
backup_dir=$(mktemp -d)
docker exec cukup bun /app/database-ops.js backup /var/lib/cukup/backups > "$backup_dir/result.json"
snapshot=$(jq -er .database_file "$backup_dir/result.json")
docker cp "cukup:/var/lib/cukup/backups/$snapshot" "$backup_dir/$snapshot"
docker cp "cukup:/var/lib/cukup/backups/${snapshot%.sqlite}.json" "$backup_dir/${snapshot%.sqlite}.json"
```

Keep the `.sqlite` file and its matching `.json` together in protected storage off the server. The copies in the service volume alone do not protect against volume loss. If you ran `docker cp` with `sudo`, make the protected copies readable by the operator who runs the restore. Restore only data for this same owner. Use a volume name that does not exist yet, for example `cukup-recovery`. Run the following commands in Bash:

```bash
set -o pipefail
docker volume create cukup-recovery
tar -C "$backup_dir" -cf - "$snapshot" "${snapshot%.sqlite}.json" |
  docker run --rm -i --network none --entrypoint sh \
    --mount source=cukup-recovery,target=/var/lib/cukup \
    cukup-service:self-host -ec '
      mkdir -m 700 /tmp/cukup-import
      tar -xf - -C /tmp/cukup-import
      bun /app/database-ops.js restore "/tmp/cukup-import/$1" /var/lib/cukup/cukup.sqlite
      bun /app/database-ops.js integrity /var/lib/cukup/cukup.sqlite
    ' sh "$snapshot"
```

Restore checks the backup metadata and checksum before it writes the new database. Do not use `--replace` for this test. Start an isolated container like in step 2 with `cukup-recovery`, the **same** private environment file, a different container name, and `-p 127.0.0.1:3001:3000` instead of port 3000. Check the restored API locally on the server by sending `Host: api.cukup.example.com` and `X-Forwarded-Proto: https` to that loopback port. Verify that the saved activity and existing machine token still work. For a complete recovery drill on a disposable install, switch Caddy to the restored container, verify dashboard totals, and sync a new turn. Do not point production traffic at a recovery drill. Keep the original volume until you confirm recovery.
