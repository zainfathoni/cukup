#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly project_root
readonly operator="$project_root/scripts/deploy-service"

root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT

release="$root/release"
fake_bin="$root/bin"
real_git="$(command -v git)"
real_bun="$(command -v bun)"
mkdir -p "$release/service" "$release/config" "$release/scripts" "$release/.kamal" "$fake_bin"
printf 'const DATABASE_VERSION = 4\n' > "$release/service/store.ts"
cp "$project_root/config/deploy.service.yml" "$release/config/deploy.service.yml"
cp "$project_root/scripts/check-service-runtime.ts" "$release/scripts/check-service-runtime.ts"
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
if [[ "$1" == run ]]; then
	[[ "${TEST_BAD_CANDIDATE_RUNTIME:-0}" != 1 ]]
	exit
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
printf '%s %s\n' "${VERSION:-}" "$*" >> "$TEST_KAMAL_LOG"
if [[ "$*" == *"lock status"* ]]; then
	if [[ "${TEST_LOCKED:-0}" == 1 ]]; then
		printf 'Locked by: prior deployment\n'
	else
		printf 'There is no deploy lock\n'
	fi
fi
if [[ "$1" == redeploy ]]; then
	printf candidate > "$TEST_RUNNING_STATE"
	[[ "${TEST_DEPLOY_FAIL:-0}" != 1 ]]
elif [[ "$1 $2" == 'app start' ]]; then
	[[ "$VERSION" == '30f256bb6a00e1680c4af24b4b1f987013f34267-trust20261022' ]]
	[[ "${TEST_START_FAILURE:-0}" != 1 ]]
	if [[ "$(cat "$TEST_RUNNING_STATE")" == candidate ]]; then
		printf both > "$TEST_RUNNING_STATE"
	else
		printf prior > "$TEST_RUNNING_STATE"
	fi
	if [[ "${TEST_RECREATED_RECOVERY:-0}" == 1 ]]; then
		touch "$TEST_RUNNING_STATE.recreated"
	fi
fi
EOF

cat > "$fake_bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
command="${*: -1}"
printf '%s\n' "$command" >> "$TEST_SSH_LOG"
state="$(cat "$TEST_RUNNING_STATE" 2>/dev/null || printf prior)"
case "$command" in
	*"docker ps -q"*)
		[[ "$state" != both && "$state" != stopped ]]
		version="$TEST_PRIOR"
		image="ghcr.io/zainfathoni/cukup:$version"
		id="$(printf 'b%.0s' {1..64})"
		if [[ "$state" == candidate ]]; then
			version="$TEST_CANDIDATE"
			image="ghcr.io/zainfathoni/cukup:$version"
			id="$(printf 'd%.0s' {1..64})"
		elif [[ "${TEST_TRUST_BASELINE:-0}" == 1 ]]; then
			version='30f256bb6a00e1680c4af24b4b1f987013f34267-trust20261022'
			image='fleet/cukup:trust-20261022'
			id='653e80f21340afb10da18aa9c31126242684c1dfcf213aeb10a2998790819f0e'
			if [[ "${TEST_BAD_BASELINE_NAME:-0}" == 1 ]]; then version="$version-other"; fi
			if [[ "${TEST_BAD_BASELINE_IMAGE:-0}" == 1 ]]; then image='fleet/cukup:unknown'; fi
			if [[ "${TEST_BAD_BASELINE_CONTAINER_ID:-0}" == 1 ]]; then id="$(printf 'b%.0s' {1..64})"; fi
			if [[ -f "$TEST_RUNNING_STATE.recreated" ]]; then id="$(printf 'e%.0s' {1..64})"; fi
		fi
		printf '%s\t/%s\t%s\n' \
			"$id" "cukup-service-web-$version" "$image"
		;;
	*"--format '{{.Image}}'"*)
		if [[ "${TEST_BAD_BASELINE_ID:-0}" == 1 ]]; then printf 'sha256:wrong\n'
		else printf 'sha256:b54881133d3009f8050e41d21eaea707d46e0044faee41b7b40162997e215d44\n'; fi
		;;
	*"bun run -"*)
		[[ "${TEST_BAD_RUNTIME:-0}" != 1 ]]
		if [[ "$state" == candidate && "${TEST_POST_RUNTIME_FAILURE:-0}" == 1 ]]; then exit 1; fi
		;;
	*"Config.Env"*) printf '%s\n' "$(printf '%s' "${TEST_RUNTIME_SECRET_VALUE:-test}" | sha256sum | cut -d' ' -f1)" ;;
	*"sha256sum"*) printf '%s\n' "$(printf 'c%.0s' {1..64})" ;;
	*"ATTACH DATABASE"*) printf '4\nok\n0\n0\n0\n0\n' ;;
	*"PRAGMA user_version"*) printf '4\nok\n' ;;
	*"systemctl start cukup-backup.service"*) printf 'test-backup\n' ;;
	*"sudo -n cat"*) printf 'synthetic-backup\n' ;;
	*"docker image inspect"*) docker image inspect ignored ;;
	*"docker container inspect"*) ;;
	*"docker stop"*)
		[[ "$command" == "docker stop 'cukup-service-web-$TEST_CANDIDATE'" ]]
		[[ "${TEST_STOP_FAILURE:-0}" != 1 ]]
		printf stopped > "$TEST_RUNNING_STATE"
		;;
	*) exit 1 ;;
esac
EOF

cat > "$fake_bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
if [[ "${TEST_TRUST_BASELINE:-0}" == 1 ]]; then
	for index in "${!args[@]}"; do
		args[index]="${args[index]//30f256bb6a00e1680c4af24b4b1f987013f34267/$TEST_PRIOR}"
	done
fi
exec "$TEST_REAL_GIT" "${args[@]}"
EOF

cat > "$fake_bin/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *'database-ops.ts verify'* ]]; then
	printf '{"integrity_check":"ok","sqlite_user_version":4,"database_file":"test-backup.sqlite"}\n'
else
	exec "$TEST_REAL_BUN" "$@"
fi
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
		TEST_REAL_GIT="$real_git" \
		TEST_REAL_BUN="$real_bun" \
		TEST_RUNNING_STATE="$root/running-state" \
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
		"$operator" "${2:-preflight}"
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

: > "$root/kamal.log"
: > "$root/ssh.log"
TEST_TRUST_BASELINE=1 run_operator "$root/trust-summary"
grep -Fq 'success-no-mutation' "$root/trust-summary"
grep -Fq -- '--legacy-trust-baseline' "$root/ssh.log"
assert_absent '(^| )(deploy|redeploy|rollback|app start)( |$)' "$root/kamal.log"
assert_absent 'systemctl start cukup-backup.service' "$root/ssh.log"

for control in TEST_BAD_BASELINE_NAME TEST_BAD_BASELINE_IMAGE TEST_BAD_BASELINE_ID TEST_BAD_BASELINE_CONTAINER_ID TEST_BAD_RUNTIME TEST_BAD_CANDIDATE_RUNTIME; do
	: > "$root/kamal.log"
	: > "$root/ssh.log"
	if (export "$control=1"; TEST_TRUST_BASELINE=1 run_operator "$root/negative-$control") 2> "$root/negative-stderr"; then
		printf 'unsafe trust baseline or candidate unexpectedly passed: %s\n' "$control" >&2
		exit 1
	fi
	grep -Fq 'failed-before-deploy' "$root/negative-$control"
	assert_absent '(^| )(deploy|redeploy|rollback|app start)( |$)' "$root/kamal.log"
	assert_absent 'systemctl start cukup-backup.service' "$root/ssh.log"
done

for failure in TEST_DEPLOY_FAIL TEST_POST_RUNTIME_FAILURE; do
	: > "$root/kamal.log"
	: > "$root/ssh.log"
	rm -f "$root/running-state" "$root/running-state.recreated"
	if (export "$failure=1"; TEST_TRUST_BASELINE=1 run_operator "$root/recovery-$failure" deploy) 2> "$root/recovery-stderr"; then
		printf 'failed deployment unexpectedly returned success\n' >&2
		exit 1
	fi
	grep -Fq 'failed-and-rolled-back' "$root/recovery-$failure"
	grep -Fq 'rollback verified' "$root/recovery-stderr"
	grep -Fq '30f256bb6a00e1680c4af24b4b1f987013f34267-trust20261022 app start' "$root/kamal.log"
	test "$(cat "$root/running-state")" = prior
	assert_absent '(^| )(deploy|rollback|prune|proxy)( |$)' "$root/kamal.log"
done

for failure in TEST_STOP_FAILURE TEST_START_FAILURE TEST_RECREATED_RECOVERY; do
	rm -f "$root/running-state" "$root/running-state.recreated"
	if (export "$failure=1"; TEST_TRUST_BASELINE=1 TEST_POST_RUNTIME_FAILURE=1 \
		run_operator "$root/recovery-$failure" deploy) 2> "$root/recovery-stderr"; then
		printf 'failed recovery unexpectedly passed\n' >&2
		exit 1
	fi
	grep -Fq 'failed-rollback-unverified' "$root/recovery-$failure"
	assert_absent 'rollback verified' "$root/recovery-stderr"
done

rm -f "$root/running-state" "$root/running-state.recreated"
: > "$root/kamal.log"
TEST_TRUST_BASELINE=1 run_operator "$root/deployed-summary" deploy
grep -Fq '`deploy` `success`' "$root/deployed-summary"
test "$(cat "$root/running-state")" = candidate
grep -Fq 'redeploy --skip-push' "$root/kamal.log"
assert_absent '(^| )(deploy|rollback|prune|proxy)( |$)' "$root/kamal.log"

printf 'deployment preflight regression checks passed\n'
