#!/usr/bin/env bash
# Prints the last backup result line and checks freshness (B.12).
# Usage: backup-status.sh [--backup-dir DIR] [--max-age-hours N] [--env-file PATH]
# Exit: 0 the last status=ok is younger than N hours (default 26),
#       1 stale, missing, or the newest result is a failure.
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

DIR_ARG="" MAX_HOURS=26 ENV_FILE="$REPO_ROOT/.env"
while (($#)); do
  case "$1" in
    --backup-dir) DIR_ARG="${2:-}"; shift ;;
    --max-age-hours) MAX_HOURS="${2:-}"; shift ;;
    --env-file) ENV_FILE="${2:-}"; shift ;;
    *) echo "usage: backup-status.sh [--backup-dir DIR] [--max-age-hours N]" >&2; exit 2 ;;
  esac
  shift
done
[[ "$MAX_HOURS" =~ ^[0-9]+$ ]] || { echo "bad --max-age-hours" >&2; exit 2; }
eve_load_env "$ENV_FILE"
LOG="$(eve_expand_home "${DIR_ARG:-${BACKUP_DIR:-~/eve-backups}}")/backup.log"
[[ -r "$LOG" ]] || { echo "eve-backup-status fresh=no reason=no-log"; exit 1; }

last="$(grep -E ' eve-backup .*status=(ok|failed) ' "$LOG" | tail -n 1 || true)"
[[ -n "$last" ]] || { echo "eve-backup-status fresh=no reason=no-result"; exit 1; }
printf '%s\n' "$last"
ok="$(grep -E ' eve-backup .* status=ok set=' "$LOG" | tail -n 1 || true)"
[[ -n "$ok" ]] || { echo "eve-backup-status fresh=no reason=never-ok"; exit 1; }
# The log line starts with its ISO time; compare as YYYYmmddTHHMMSSZ.
iso="${ok%% *}"
ts="$(printf '%s' "$iso" | tr -d ':-')"
then_epoch="$(eve_epoch_of_ts "$ts")" || { echo "eve-backup-status fresh=no reason=unreadable"; exit 1; }
now_epoch="$(eve_epoch_of_ts "$(eve_now_ts)")"
age_h=$(((now_epoch - then_epoch) / 3600))
if ((now_epoch - then_epoch > MAX_HOURS * 3600)); then
  echo "eve-backup-status fresh=no last_ok_hours=$age_h max_hours=$MAX_HOURS"
  exit 1
fi
case "$last" in *" status=failed "*)
  echo "eve-backup-status fresh=yes last_ok_hours=$age_h max_hours=$MAX_HOURS newest=failed"
  exit 1 ;;
esac
echo "eve-backup-status fresh=yes last_ok_hours=$age_h max_hours=$MAX_HOURS"
