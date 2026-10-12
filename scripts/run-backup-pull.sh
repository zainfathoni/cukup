#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 5 ]; then
	printf '%s\n' 'Usage: run-backup-pull.sh <bun> <bundle> <config> <stdout-log> <stderr-log>' >&2
	exit 2
fi

bun_binary=$1
bundle=$2
config=$3
stdout_log=$4
stderr_log=$5
log_directory=$(dirname "$stdout_log")

mkdir -p "$log_directory"
chmod 700 "$log_directory"
touch "$stdout_log" "$stderr_log"
chmod 600 "$stdout_log" "$stderr_log"

exec "$bun_binary" "$bundle" --config "$config" >>"$stdout_log" 2>>"$stderr_log"
