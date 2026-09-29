#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly project_root
readonly operator="$project_root/scripts/deploy-service"

root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT

release="$root/release"
fake_bin="$root/bin"
mkdir -p "$release/service" "$release/config" "$release/.kamal" "$fake_bin"
printf 'const DATABASE_VERSION = 4\n' > "$release/service/store.ts"
cp "$project_root/config/deploy.service.yml" "$release/config/deploy.service.yml"
git -C "$release" init -q
git -C "$release" config user.name test
git -C "$release" config user.email test@example.com
git -C "$release" config commit.gpgsign false
git -C "$release" add .
git -C "$release" commit -qm prior
prior="$(git -C "$release" rev-parse HEAD)"
printf '// candidate\n' >> "$release/service/store.ts"
git -C "$release" add .
git -C "$release" commit -qm candidate
candidate="$(git -C "$release" rev-parse HEAD)"

cat > "$fake_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
endpoint=""
for argument in "$@"; do
	if [[ "$argument" == repos/* ]]; then
		endpoint="$argument"
		break
	fi
done
case "$endpoint" in
	*/git/ref/heads/main)
		printf '%s\n' "$TEST_CANDIDATE"
		;;
	*/actions/workflows/publish-service.yml/runs)
		jq -n --arg sha "$TEST_CANDIDATE" '{
			workflow_runs: [{
				name: "Publish service image",
				path: ".github/workflows/publish-service.yml",
				event: "push",
				head_branch: "main",
				head_sha: $sha,
				status: "completed",
				conclusion: "success"
			}]
		}'
		;;
	*/commits/*)
		jq -n --arg sha "${endpoint##*/}" '{
			sha: $sha,
			commit: { verification: { verified: true, reason: "valid" } }
		}'
		;;
	*) exit 1 ;;
esac
EOF

cat > "$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == pull ]]; then
	exit 0
fi
if [[ "$1 $2" == "image inspect" ]]; then
	jq -n --arg sha "$TEST_CANDIDATE" '[{
		Os: "linux",
		Architecture: "amd64",
		Config: { Labels: {
			service: "cukup-service",
			"org.opencontainers.image.source": "https://github.com/zainfathoni/cukup",
			"org.opencontainers.image.revision": $sha
		} },
		RepoDigests: ["ghcr.io/zainfathoni/cukup@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
	}]'
	exit 0
fi
exit 1
EOF

cat > "$fake_bin/kamal" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_KAMAL_LOG"
if [[ "$*" == *"lock status"* ]]; then
	if [[ "${TEST_LOCKED:-0}" == 1 ]]; then
		printf 'Locked by: prior deployment\n'
	else
		printf 'There is no deploy lock\n'
	fi
fi
EOF

cat > "$fake_bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
command="${*: -1}"
printf '%s\n' "$command" >> "$TEST_SSH_LOG"
case "$command" in
	*"docker ps -q"*)
		printf '%s\t/%s\t%s\n' \
			"$(printf 'b%.0s' {1..64})" \
			"cukup-service-web-$TEST_PRIOR" \
			"ghcr.io/zainfathoni/cukup:$TEST_PRIOR"
		;;
	*"Config.Env"*) printf '%s\n' "$(printf '%s' "${TEST_RUNTIME_SECRET_VALUE:-test}" | sha256sum | cut -d' ' -f1)" ;;
	*"sha256sum"*) printf '%s\n' "$(printf 'c%.0s' {1..64})" ;;
	*"PRAGMA user_version"*) printf '4\nok\n' ;;
	*) exit 1 ;;
esac
EOF

cat > "$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output=""
headers=""
url=""
while (( $# )); do
	case "$1" in
		--output) output="$2"; shift 2 ;;
		--dump-header) headers="$2"; shift 2 ;;
		http*) url="$1"; shift ;;
		*) shift ;;
	esac
done
case "$url" in
	*/healthz|*/up)
		printf '{"ok":true}' > "$output"
		printf 200
		;;
	*/auth/github)
		: > "$output"
		printf 'location: https://github.com/login/oauth/authorize?client_id=test\r\nset-cookie: __Host-cukup_oauth=redacted\r\n' > "$headers"
		printf 303
		;;
	*/assets/*)
		printf asset > "$output"
		printf 200
		;;
	*/)
		printf '<a class="button" href="/auth/github">Sign in with GitHub</a>' > "$output"
		printf 200
		;;
	*) exit 1 ;;
esac
EOF

chmod +x "$fake_bin"/*
key="$root/key"
printf key > "$key"
chmod 0600 "$key"

run_operator() {
	local summary="$1"
	PATH="$fake_bin:$PATH" \
		TEST_CANDIDATE="$candidate" \
		TEST_PRIOR="$prior" \
		TEST_KAMAL_LOG="$root/kamal.log" \
		TEST_SSH_LOG="$root/ssh.log" \
		CUKUP_REVISION="$candidate" \
		CUKUP_RELEASE_ROOT="$release" \
		CUKUP_IMAGE=zainfathoni/cukup \
		CUKUP_DEPLOY_HOST=example.test \
		CUKUP_SSH_USER=deployer \
		CUKUP_SSH_KEY="$key" \
		CUKUP_API_HOSTNAME=api.cukup.dev \
		CUKUP_DASHBOARD_HOSTNAME=cukup.dev \
		CUKUP_DATA_DIRECTORY=/srv/example-cukup-data \
		CUKUP_BACKUP_DIRECTORY=/srv/example-cukup-backups \
		KAMAL_REGISTRY_USERNAME=zainfathoni \
		GITHUB_TOKEN=test \
		CUKUP_OIDC_ALLOWED_USER_ID=test \
		CUKUP_FLEET_HOSTNAMES=test \
		CUKUP_GITHUB_OAUTH_CLIENT_ID=test \
		CUKUP_GITHUB_OAUTH_CLIENT_SECRET=test \
		CUKUP_GITHUB_ALLOWED_USER_ID=test \
		CUKUP_DASHBOARD_SESSION_KEYS=test \
		GITHUB_STEP_SUMMARY="$summary" \
		"$operator" preflight
}

assert_absent() {
	local pattern="$1"
	local path="$2"
	if grep -Eq "$pattern" "$path"; then
		printf 'unexpected pattern %s in %s\n' "$pattern" "$path" >&2
		exit 1
	fi
}

: > "$root/kamal.log"
: > "$root/ssh.log"
run_operator "$root/success-summary"
# shellcheck disable=SC2016 # Markdown backticks are literal.
grep -Fq '`preflight` `success-no-mutation`' "$root/success-summary"
assert_absent '(^| )(deploy|rollback)( |$)' "$root/kamal.log"
assert_absent 'systemctl start cukup-backup.service' "$root/ssh.log"

: > "$root/kamal.log"
: > "$root/ssh.log"
if TEST_LOCKED=1 run_operator "$root/locked-summary" 2> "$root/locked-stderr"; then
	printf 'held deployment lock unexpectedly passed preflight\n' >&2
	exit 1
fi
# shellcheck disable=SC2016 # Markdown backticks are literal.
grep -Fq '`preflight` `failed-before-deploy`' "$root/locked-summary"
# shellcheck disable=SC2016 # Markdown backticks are literal.
grep -Fq 'phase `remote-lock`' "$root/locked-summary"
grep -Fq 'deployment failed at phase: remote-lock' "$root/locked-stderr"
assert_absent '(^| )(deploy|rollback)( |$)' "$root/kamal.log"
assert_absent 'systemctl start cukup-backup.service' "$root/ssh.log"

: > "$root/kamal.log"
: > "$root/ssh.log"
if TEST_RUNTIME_SECRET_VALUE=wrong run_operator "$root/mismatch-summary" 2> "$root/mismatch-stderr"; then
	printf 'runtime secret mismatch unexpectedly passed preflight\n' >&2
	exit 1
fi
grep -Fq 'runtime secret does not match protected environment: CUKUP_OIDC_ALLOWED_USER_ID' "$root/mismatch-stderr"
grep -Fq 'deployment failed at phase: runtime-secrets' "$root/mismatch-stderr"
assert_absent '(^| )(deploy|rollback)( |$)' "$root/kamal.log"
assert_absent 'systemctl start cukup-backup.service' "$root/ssh.log"

printf 'deployment preflight regression checks passed\n'
