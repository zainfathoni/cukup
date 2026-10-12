#!/bin/bash
set -euo pipefail
umask 077

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "${SCRIPT_DIRECTORY}/.." && pwd)"
if [[ "$(uname -s)" != 'Linux' ]]; then
	echo 'ERROR: This setup script requires Linux.' >&2
	exit 1
fi

for command in systemctl ssh rsync; do
	if ! command -v "${command}" >/dev/null 2>&1; then
		echo "ERROR: Required command not found: ${command}" >&2
		exit 1
	fi
done
if ! systemctl --user show-environment >/dev/null 2>&1; then
	echo 'ERROR: The systemd user manager is not available. No cron fallback is installed.' >&2
	exit 1
fi

BUN_BINARY="${BUN_BIN:-$(command -v bun || true)}"
SSH_BINARY="$(command -v ssh)"
RSYNC_BINARY="$(command -v rsync)"
if [[ -z "${BUN_BINARY}" || "${BUN_BINARY}" != /* || ! -x "${BUN_BINARY}" ]]; then
	echo 'ERROR: Set BUN_BIN to an executable absolute path.' >&2
	exit 1
fi
if [[ "${SSH_BINARY}" != /* || "${RSYNC_BINARY}" != /* ]]; then
	echo 'ERROR: ssh and rsync must resolve to absolute executable paths.' >&2
	exit 1
fi

INSTALL_DIRECTORY="${CUKUP_INSTALL_DIRECTORY:-${HOME}/.local/lib/cukup}"
CONFIG_PATH="${HOME}/.config/cukup/backup-pull.json"
STATE_DIRECTORY="${HOME}/.local/state/cukup-backups"
LOG_DIRECTORY="${STATE_DIRECTORY}/logs"
OUTPUT_LOG="${LOG_DIRECTORY}/pull.log"
ERROR_LOG="${LOG_DIRECTORY}/pull.err.log"
UNIT_DIRECTORY="${HOME}/.config/systemd/user"
UNIT_NAME='cukup-backup-pull'
SERVICE_PATH="${UNIT_DIRECTORY}/${UNIT_NAME}.service"
TIMER_PATH="${UNIT_DIRECTORY}/${UNIT_NAME}.timer"
MANAGED_MARKER='Managed by Cukup backup-pull setup.'
STAGING_DIRECTORY=''
SERVICE_TEMP=''
TIMER_TEMP=''

cleanup() {
	if [[ -n "${STAGING_DIRECTORY}" ]]; then
		rm -rf -- "${STAGING_DIRECTORY}"
	fi
	if [[ -n "${SERVICE_TEMP}" ]]; then
		rm -f -- "${SERVICE_TEMP}"
	fi
	if [[ -n "${TIMER_TEMP}" ]]; then
		rm -f -- "${TIMER_TEMP}"
	fi
}
trap cleanup EXIT

if [[ -e "${INSTALL_DIRECTORY}" || -L "${INSTALL_DIRECTORY}" ]]; then
	if [[ ! -d "${INSTALL_DIRECTORY}" || -L "${INSTALL_DIRECTORY}" ||
		! -f "${INSTALL_DIRECTORY}/.backup-pull-managed" ||
		-L "${INSTALL_DIRECTORY}/.backup-pull-managed" ]] ||
		! grep -Fxq "${MANAGED_MARKER}" "${INSTALL_DIRECTORY}/.backup-pull-managed"; then
		echo "ERROR: Refusing to replace an unmanaged backup-pull installation: ${INSTALL_DIRECTORY}" >&2
		exit 1
	fi
	for asset in pull-cukup-backups.js run-backup-pull.sh; do
		if [[ -e "${INSTALL_DIRECTORY}/${asset}" || -L "${INSTALL_DIRECTORY}/${asset}" ]]; then
			if [[ ! -f "${INSTALL_DIRECTORY}/${asset}" || -L "${INSTALL_DIRECTORY}/${asset}" ]]; then
				echo "ERROR: Refusing to replace a non-file backup-pull asset: ${INSTALL_DIRECTORY}/${asset}" >&2
				exit 1
			fi
		fi
	done
fi

for path in "${SERVICE_PATH}" "${TIMER_PATH}"; do
	if [[ -e "${path}" || -L "${path}" ]] &&
		{ [[ ! -f "${path}" ]] || [[ -L "${path}" ]] || ! grep -Fq "# ${MANAGED_MARKER}" "${path}"; }; then
		echo "ERROR: Refusing to replace an unmanaged systemd unit: ${path}" >&2
		exit 1
	fi
done

mkdir -p "$(dirname "${INSTALL_DIRECTORY}")"
STAGING_DIRECTORY="$(mktemp -d "${INSTALL_DIRECTORY}.staging.XXXXXX")"
BUN_BIN="${BUN_BINARY}" CUKUP_INSTALL_DIRECTORY="${STAGING_DIRECTORY}" \
	"${SCRIPT_DIRECTORY}/install-backup-pull-assets.sh" >/dev/null
"${BUN_BINARY}" run --cwd "${REPOSITORY_ROOT}" scripts/initialize-backup-pull-config.ts \
	"${CONFIG_PATH}" "${SSH_BINARY}" "${RSYNC_BINARY}"

echo 'Running one noninteractive backup pull before scheduler installation.'
"${BUN_BINARY}" "${STAGING_DIRECTORY}/pull-cukup-backups.js" --config "${CONFIG_PATH}"

mkdir -p "${INSTALL_DIRECTORY}"
chmod 700 "${INSTALL_DIRECTORY}"
for asset in pull-cukup-backups.js run-backup-pull.sh; do
	mv -f -- "${STAGING_DIRECTORY}/${asset}" "${INSTALL_DIRECTORY}/${asset}"
done
if [[ ! -f "${INSTALL_DIRECTORY}/.backup-pull-managed" ]]; then
	mv -f -- "${STAGING_DIRECTORY}/.backup-pull-managed" "${INSTALL_DIRECTORY}/.backup-pull-managed"
fi
chmod 600 "${INSTALL_DIRECTORY}/.backup-pull-managed"

mkdir -p "${LOG_DIRECTORY}" "${UNIT_DIRECTORY}"
chmod 700 "${LOG_DIRECTORY}"
touch "${OUTPUT_LOG}" "${ERROR_LOG}"
chmod 600 "${OUTPUT_LOG}" "${ERROR_LOG}"

systemd_quote() {
	local value="$1"
	value="${value//\\/\\\\}"
	value="${value//\"/\\\"}"
	value="${value//\$/\$\$}"
	value="${value//%/%%}"
	printf '"%s"' "${value}"
}

SERVICE_TEMP="$(mktemp "${SERVICE_PATH}.XXXXXX")"
TIMER_TEMP="$(mktemp "${TIMER_PATH}.XXXXXX")"

cat >"${SERVICE_TEMP}" <<EOF
# Managed by Cukup backup-pull setup.
[Unit]
Description=Pull and verify Cukup off-site backups

[Service]
Type=oneshot
UMask=0077
ExecStart=$(systemd_quote "${INSTALL_DIRECTORY}/run-backup-pull.sh") $(systemd_quote "${BUN_BINARY}") $(systemd_quote "${INSTALL_DIRECTORY}/pull-cukup-backups.js") $(systemd_quote "${CONFIG_PATH}") $(systemd_quote "${OUTPUT_LOG}") $(systemd_quote "${ERROR_LOG}")
EOF

cat >"${TIMER_TEMP}" <<EOF
# Managed by Cukup backup-pull setup.
[Unit]
Description=Run the Cukup backup pull every six hours

[Timer]
OnCalendar=*-*-* 00,06,12,18:15:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

chmod 600 "${SERVICE_TEMP}" "${TIMER_TEMP}"
mv "${SERVICE_TEMP}" "${SERVICE_PATH}"
mv "${TIMER_TEMP}" "${TIMER_PATH}"
systemctl --user daemon-reload
systemctl --user enable --now "${UNIT_NAME}.timer"

echo "Installed systemd user timer: ${UNIT_NAME}.timer (six-hour schedule, Persistent)"
echo "Status: systemctl --user list-timers ${UNIT_NAME}.timer"
echo "Run:    systemctl --user start ${UNIT_NAME}.service"
echo "Logs:   ${OUTPUT_LOG} and ${ERROR_LOG}"
echo 'This timer stops when the user manager stops. Do not enable lingering without owner approval.'
