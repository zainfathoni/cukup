#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly project_root
readonly setup_script="${project_root}/scripts/setup-mac-backup-pull.sh"
root="$(mktemp -d)"
trap 'rm -rf -- "$root"' EXIT
fake_bin="${root}/bin"
mkdir -p "${fake_bin}"
real_bun="$(command -v bun)"

cat >"${fake_bin}/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == */pull-cukup-backups.js ]]; then
	printf '%s\n' "$1" >>"${TEST_PULL_LOG}"
	exit "${TEST_PULL_RESULT:-0}"
fi
exec "${TEST_REAL_BUN}" "$@"
EOF

cat >"${fake_bin}/uname" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' Darwin
EOF

cat >"${fake_bin}/launchctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${TEST_LAUNCHCTL_LOG}"
if [[ "${1:-}" == print ]]; then
	[[ "${TEST_JOB_LOADED:-0}" == 1 ]]
fi
EOF

for command in plutil ssh rsync; do
	cat >"${fake_bin}/${command}" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
done
chmod +x "${fake_bin}"/*

prepare_home() {
	local home="$1"
	mkdir -p "${home}/.config/cukup"
	cat >"${home}/.config/cukup/backup-pull.json" <<EOF
{
  "remoteHost": "production-host",
  "remoteDirectory": "/srv/example-cukup-backups",
  "localDirectory": "${home}/.local/state/cukup-backups/pairs",
  "sshBinary": "${fake_bin}/ssh",
  "rsyncBinary": "${fake_bin}/rsync"
}
EOF
	chmod 600 "${home}/.config/cukup/backup-pull.json"
}

run_setup() {
	local home="$1"
	local pull_result="$2"
	local loaded="$3"
	PATH="${fake_bin}:${PATH}" \
	HOME="${home}" \
	BUN_BIN="${fake_bin}/bun" \
	CUKUP_INSTALL_DIRECTORY="${home}/.local/lib/cukup" \
	TEST_REAL_BUN="${real_bun}" \
	TEST_PULL_LOG="${root}/pull.log" \
	TEST_PULL_RESULT="${pull_result}" \
	TEST_LAUNCHCTL_LOG="${root}/launchctl.log" \
	TEST_JOB_LOADED="${loaded}" \
		"${setup_script}"
}

assert_no_launchctl_mutation() {
	if grep -Eq '^(bootout|enable|bootstrap) ' "${root}/launchctl.log"; then
		printf 'setup changed the LaunchAgent before validation passed\n' >&2
		exit 1
	fi
}

# An unmanaged asset directory must remain untouched.
home="${root}/unmanaged-assets"
install_directory="${home}/.local/lib/cukup"
mkdir -p "${install_directory}"
printf 'unmanaged bundle\n' >"${install_directory}/pull-cukup-backups.js"
cp "${install_directory}/pull-cukup-backups.js" "${root}/unmanaged-bundle.before"
: >"${root}/pull.log"
: >"${root}/launchctl.log"
if run_setup "${home}" 0 0 2>"${root}/unmanaged-assets.stderr"; then
	printf 'setup unexpectedly replaced unmanaged backup-pull assets\n' >&2
	exit 1
fi
grep -Fq 'Refusing to replace an unmanaged backup-pull installation' "${root}/unmanaged-assets.stderr"
cmp "${root}/unmanaged-bundle.before" "${install_directory}/pull-cukup-backups.js"
[[ ! -s "${root}/pull.log" ]]
assert_no_launchctl_mutation

# An unmanaged plist must be rejected before build, pull, or agent unload.
home="${root}/unmanaged-plist"
install_directory="${home}/.local/lib/cukup"
plist="${home}/Library/LaunchAgents/dev.zainfathoni.cukup.backup-pull.plist"
prepare_home "${home}"
mkdir -p "${install_directory}" "$(dirname "${plist}")"
printf '%s\n' 'prior bundle' >"${install_directory}/pull-cukup-backups.js"
printf '%s\n' 'prior runner' >"${install_directory}/run-backup-pull.sh"
printf '%s\n' 'Managed by Cukup backup-pull setup.' >"${install_directory}/.backup-pull-managed"
printf '%s\n' '<plist><dict><key>Label</key></dict></plist>' >"${plist}"
cp "${install_directory}/pull-cukup-backups.js" "${root}/plist-bundle.before"
cp "${plist}" "${root}/plist.before"
: >"${root}/pull.log"
: >"${root}/launchctl.log"
if run_setup "${home}" 0 1 2>"${root}/unmanaged-plist.stderr"; then
	printf 'setup unexpectedly replaced an unmanaged LaunchAgent plist\n' >&2
	exit 1
fi
grep -Fq 'Refusing to replace an unmanaged LaunchAgent plist' "${root}/unmanaged-plist.stderr"
cmp "${root}/plist-bundle.before" "${install_directory}/pull-cukup-backups.js"
cmp "${root}/plist.before" "${plist}"
[[ ! -s "${root}/pull.log" ]]
assert_no_launchctl_mutation

# A failed candidate pull must leave a managed deployment and loaded agent intact.
home="${root}/failed-validation"
install_directory="${home}/.local/lib/cukup"
plist="${home}/Library/LaunchAgents/dev.zainfathoni.cukup.backup-pull.plist"
prepare_home "${home}"
mkdir -p "${install_directory}" "$(dirname "${plist}")"
printf '%s\n' 'prior bundle' >"${install_directory}/pull-cukup-backups.js"
printf '%s\n' 'prior runner' >"${install_directory}/run-backup-pull.sh"
printf '%s\n' 'Managed by Cukup backup-pull setup.' >"${install_directory}/.backup-pull-managed"
cat >"${plist}" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!-- Managed by Cukup backup-pull setup. -->
<plist version="1.0"><dict><key>Label</key><string>dev.zainfathoni.cukup.backup-pull</string></dict></plist>
EOF
cp "${install_directory}/pull-cukup-backups.js" "${root}/failed-bundle.before"
cp "${install_directory}/run-backup-pull.sh" "${root}/failed-runner.before"
cp "${plist}" "${root}/failed-plist.before"
: >"${root}/pull.log"
: >"${root}/launchctl.log"
if run_setup "${home}" 1 1 >"${root}/failed-validation.stdout" 2>"${root}/failed-validation.stderr"; then
	printf 'setup unexpectedly installed a candidate whose validation pull failed\n' >&2
	exit 1
fi
grep -Fq 'Running one noninteractive backup pull' "${root}/failed-validation.stdout"
cmp "${root}/failed-bundle.before" "${install_directory}/pull-cukup-backups.js"
cmp "${root}/failed-runner.before" "${install_directory}/run-backup-pull.sh"
cmp "${root}/failed-plist.before" "${plist}"
grep -Fq '.staging.' "${root}/pull.log"
assert_no_launchctl_mutation
if compgen -G "${home}/.local/lib/cukup.staging.*" >/dev/null; then
	printf 'failed candidate staging directory was not cleaned up\n' >&2
	exit 1
fi

printf 'backup-pull setup regression checks passed\n'
