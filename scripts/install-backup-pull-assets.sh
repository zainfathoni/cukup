#!/bin/bash
set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "${SCRIPT_DIRECTORY}/.." && pwd)"
BUN_BINARY="${BUN_BIN:-$(command -v bun || true)}"
INSTALL_DIRECTORY="${CUKUP_INSTALL_DIRECTORY:-${HOME}/.local/lib/cukup}"

if [[ -z "${BUN_BINARY}" || "${BUN_BINARY}" != /* || ! -x "${BUN_BINARY}" ]]; then
	echo 'ERROR: Set BUN_BIN to an executable absolute path.' >&2
	exit 1
fi
if [[ "${INSTALL_DIRECTORY}" != /* ]]; then
	echo 'ERROR: CUKUP_INSTALL_DIRECTORY must be an absolute path.' >&2
	exit 1
fi

"${BUN_BINARY}" run --cwd "${REPOSITORY_ROOT}" build:backup-pull >&2
mkdir -p "${INSTALL_DIRECTORY}"
chmod 700 "${INSTALL_DIRECTORY}"
install -m 600 "${REPOSITORY_ROOT}/dist/service/pull-cukup-backups.js" \
	"${INSTALL_DIRECTORY}/pull-cukup-backups.js"
install -m 700 "${SCRIPT_DIRECTORY}/run-backup-pull.sh" \
	"${INSTALL_DIRECTORY}/run-backup-pull.sh"
printf '%s\n' 'Managed by Cukup backup-pull setup.' >"${INSTALL_DIRECTORY}/.backup-pull-managed"
chmod 600 "${INSTALL_DIRECTORY}/.backup-pull-managed"
printf '%s\n' "${INSTALL_DIRECTORY}"
