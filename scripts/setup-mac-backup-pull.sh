#!/bin/bash
set -euo pipefail
umask 077

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "${SCRIPT_DIRECTORY}/.." && pwd)"
if [[ "$(uname -s)" != 'Darwin' ]]; then
	echo 'ERROR: This setup script requires macOS.' >&2
	exit 1
fi

for command in launchctl plutil ssh rsync; do
	if ! command -v "${command}" >/dev/null 2>&1; then
		echo "ERROR: Required command not found: ${command}" >&2
		exit 1
	fi
done

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
PLIST_DIRECTORY="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIRECTORY}/dev.zainfathoni.cukup.backup-pull.plist"
LABEL="gui/$(id -u)/dev.zainfathoni.cukup.backup-pull"
MANAGED_MARKER='Managed by Cukup backup-pull setup.'
STAGING_DIRECTORY=''
PLIST_TEMP=''

cleanup() {
	if [[ -n "${STAGING_DIRECTORY}" ]]; then
		rm -rf -- "${STAGING_DIRECTORY}"
	fi
	if [[ -n "${PLIST_TEMP}" ]]; then
		rm -f -- "${PLIST_TEMP}"
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

if [[ -e "${PLIST_PATH}" || -L "${PLIST_PATH}" ]]; then
	if [[ ! -f "${PLIST_PATH}" || -L "${PLIST_PATH}" ]] ||
		! grep -Fq "<!-- ${MANAGED_MARKER} -->" "${PLIST_PATH}"; then
		echo "ERROR: Refusing to replace an unmanaged LaunchAgent plist: ${PLIST_PATH}" >&2
		exit 1
	fi
fi
if launchctl print "${LABEL}" >/dev/null 2>&1 &&
	{ [[ ! -f "${PLIST_PATH}" ]] || ! grep -Fq "<!-- ${MANAGED_MARKER} -->" "${PLIST_PATH}"; }; then
	echo "ERROR: Refusing to unload an unmanaged LaunchAgent: ${LABEL}" >&2
	exit 1
fi

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

mkdir -p "${LOG_DIRECTORY}" "${PLIST_DIRECTORY}"
chmod 700 "${LOG_DIRECTORY}"
touch "${OUTPUT_LOG}" "${ERROR_LOG}"
chmod 600 "${OUTPUT_LOG}" "${ERROR_LOG}"
PLIST_TEMP="$(mktemp "${PLIST_PATH}.XXXXXX")"

xml_escape() {
	printf '%s' "$1" | sed \
		-e 's/&/\&amp;/g' \
		-e 's/</\&lt;/g' \
		-e 's/>/\&gt;/g' \
		-e 's/"/\&quot;/g' \
		-e "s/'/\&apos;/g"
}

cat >"${PLIST_TEMP}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Managed by Cukup backup-pull setup. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.zainfathoni.cukup.backup-pull</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "${INSTALL_DIRECTORY}/run-backup-pull.sh")</string>
    <string>$(xml_escape "${BUN_BINARY}")</string>
    <string>$(xml_escape "${INSTALL_DIRECTORY}/pull-cukup-backups.js")</string>
    <string>$(xml_escape "${CONFIG_PATH}")</string>
    <string>$(xml_escape "${OUTPUT_LOG}")</string>
    <string>$(xml_escape "${ERROR_LOG}")</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>21600</integer>
</dict>
</plist>
EOF

chmod 600 "${PLIST_TEMP}"
plutil -lint "${PLIST_TEMP}" >/dev/null
if launchctl print "${LABEL}" >/dev/null 2>&1; then
	launchctl bootout "${LABEL}"
fi
mv -f -- "${PLIST_TEMP}" "${PLIST_PATH}"
PLIST_TEMP=''
launchctl enable "${LABEL}"
launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"

echo "Installed LaunchAgent: ${PLIST_PATH}"
echo "Logs: ${OUTPUT_LOG} and ${ERROR_LOG}"
