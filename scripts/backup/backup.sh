#!/usr/bin/env bash
# Nightly and on-demand encrypted backup of Eve (docs/ops/backups.md, ADR 0004).
#
# Writes three or four age-encrypted files into BACKUP_DIR (default ~/eve-backups):
#   eve-db-<UTC>.dump.age          pg_dump -Fc of POSTGRES_DB as DB_BACKUP_ROLE, the read-only
#                                  role that bypasses row-level security (fix-backup-role)
#   eve-candidates-<UTC>.tar.age   tar of the per-Candidate file root (EPIC-0002 A2,
#                                  candidate-data volume), mounted read-only; only when
#                                  that volume exists (it does not before the A2 deploy)
#   eve-documents-<UTC>.tar.age    tar of the document-data volume, mounted read-only
#   eve-resumes-<UTC>.tar.age      tar of the resume-data volume, mounted read-only
# The flat document and resume volumes stay in every set: before storage:migrate
# they hold every file, after it only the files no database row names (usually none).
# The database is dumped first, then the volumes (B.3). Every stream goes
# straight into `age -r BACKUP_AGE_RECIPIENT`; plaintext never touches the disk.
# Each file is written as *.partial and renamed only after its pipeline succeeded.
# The log holds counts, sizes and durations only, never names, values or secrets.
#
# Usage: backup.sh [--nightly | --on-demand] [--env-file PATH]
# Exit: 0 ok, 1 a step failed, 2 configuration refused, 3 another run holds the lock.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

MODE="on-demand"
ENV_FILE="$REPO_ROOT/.env"
while (($#)); do
  case "$1" in
    --nightly) MODE="nightly" ;;
    --on-demand) MODE="on-demand" ;;
    --env-file) ENV_FILE="${2:?--env-file needs a path}"; shift ;;
    -h | --help) eve_print_help "$0"; exit 0 ;;
    *) echo "eve-backup: unknown argument (see --help)" >&2; exit 2 ;;
  esac
  shift
done

STARTED=$SECONDS
STEP="config"
LOG_FILE=""
LOCK_HELD=""
WORK=""
FINAL_LOGGED=0
RUN_PARTIALS=()
DIR_KEY=""

log() {
  local line
  line="$(eve_now_iso) eve-backup mode=$MODE $*"
  printf '%s\n' "$line"
  if [[ -n "$LOG_FILE" ]]; then printf '%s\n' "$line" >>"$LOG_FILE" 2>/dev/null || true; fi
}

fail() {
  local code="$1" reason="$2"
  FINAL_LOGGED=1
  log "status=failed step=$STEP reason=$reason seconds=$((SECONDS - STARTED))"
  exit "$code"
}

# Helper containers of this BACKUP_DIR (labelled per folder). Called under the lock only.
remove_helpers() {
  local ids
  ids="$(docker ps -aq --filter label=eve.backup.helper=1 --filter "label=eve.backup.dir=$DIR_KEY" 2>/dev/null || true)"
  # -v: also their anonymous volumes (F-QA-25).
  [[ -n "$ids" ]] && docker rm -fv $ids >/dev/null 2>&1
  return 0
}

cleanup() {
  local rc=$? p
  trap - EXIT
  if ((rc != 0 && FINAL_LOGGED == 0)); then
    FINAL_LOGGED=1
    log "status=failed step=$STEP reason=unexpected seconds=$((SECONDS - STARTED))"
  fi
  # SEC-B-02: quoted array; a BACKUP_DIR with spaces or glob characters stays one path.
  for p in ${RUN_PARTIALS[@]+"${RUN_PARTIALS[@]}"}; do rm -f -- "$p"; done
  [[ -n "$DIR_KEY" ]] && remove_helpers
  [[ -n "$WORK" ]] && rm -rf -- "$WORK"
  [[ -n "${TAKEOVER_HELD:-}" ]] && rm -rf -- "$TAKEOVER_HELD"
  # Remove the lock only while it is still ours.
  if [[ -n "$LOCK_HELD" && "$(cat "$LOCK_HELD/pid" 2>/dev/null || true)" == "$$" ]]; then rm -rf -- "$LOCK_HELD"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

# --- config (nothing is written and nothing is contacted before this passes) ---
eve_load_env "$ENV_FILE"
# SEC-B-03: passwords stay shell variables, even if they came from the environment.
# The backup never uses the owner's password: since 0017 the owner is bound by RLS.
export -n DB_BACKUP_PASSWORD 2>/dev/null || true
unset DB_OWNER_PASSWORD
BACKUP_DIR="$(eve_expand_home "${BACKUP_DIR:-~/eve-backups}")"
[[ -z "${BACKUP_DIR// /}" ]] && BACKUP_DIR="$HOME/eve-backups"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
PROJECT="${BACKUP_COMPOSE_PROJECT:-eve}"
DOC_VOLUME="${BACKUP_DOCUMENT_VOLUME:-job-assistant_document-data}"
RES_VOLUME="${BACKUP_RESUME_VOLUME:-job-assistant_resume-data}"
CAND_VOLUME="${BACKUP_CANDIDATE_VOLUME:-job-assistant_candidate-data}"
HELPER_IMAGE="${BACKUP_HELPER_IMAGE:-postgres:17-alpine}"

# A failed config check logs to backup.log only when the folder already exists:
# a refused run creates nothing.
[[ -f "$BACKUP_DIR/backup.log" && -w "$BACKUP_DIR/backup.log" ]] && LOG_FILE="$BACKUP_DIR/backup.log"

[[ -n "${BACKUP_AGE_RECIPIENT:-}" ]] || fail 2 no-recipient
command -v age >/dev/null 2>&1 || fail 2 no-age
eve_check_recipient "$BACKUP_AGE_RECIPIENT" || fail 2 bad-recipient
[[ "$BACKUP_DIR" == /* ]] || fail 2 bad-backup-dir
# ADR 0004: backups are kept at most 30 days.
[[ "$RETENTION_DAYS" =~ ^[0-9]{1,3}$ ]] && ((10#$RETENTION_DAYS >= 1 && 10#$RETENTION_DAYS <= 30)) || fail 2 bad-retention
RETENTION_DAYS=$((10#$RETENTION_DAYS))
[[ -n "${POSTGRES_DB:-}" ]] || fail 2 no-database
if [[ -z "${DB_BACKUP_ROLE:-}" || -z "${DB_BACKUP_PASSWORD:-}" ]]; then
  # Names of the keys only, never a value.
  echo "eve-backup: set DB_BACKUP_ROLE and DB_BACKUP_PASSWORD in .env, then run provision-roles and migrate (docs/ops/backups.md, 'Backup role')" >&2
  [[ -z "${DB_BACKUP_ROLE:-}" ]] && fail 2 no-backup-role
  fail 2 no-backup-password
fi
[[ "$DB_BACKUP_ROLE" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail 2 bad-backup-role
command -v docker >/dev/null 2>&1 || fail 2 no-docker

# --- folder, log, lock ---
if [[ ! -d "$BACKUP_DIR" ]]; then
  mkdir -p -- "$BACKUP_DIR" || fail 2 cannot-create-dir
fi
chmod 700 "$BACKUP_DIR" || fail 2 cannot-chmod-dir
# SEC-B-06: never follow a planted link out of the folder.
[[ -L "$BACKUP_DIR/backup.log" ]] && fail 2 log-is-symlink
LOG_FILE="$BACKUP_DIR/backup.log"
[[ -e "$LOG_FILE" ]] || : >"$LOG_FILE"
chmod 600 "$LOG_FILE"

STEP="lock"
# SEC-B-05 / F-QA-B2-01: atomic lock without hard links, so it works on every
# filesystem, including ExFAT and FAT32 USB disks.
#  - The only way to take the lock is `mkdir .backup.lock`, which is atomic
#    everywhere. The holder then writes its pid to .backup.lock/pid.
#  - A holder is live while its pid runs backup.sh. A lock with no pid yet is
#    busy (a run is starting) unless it is more than 10 minutes old.
#  - Removing a stale lock happens only inside a second mkdir lock,
#    .backup.lock.takeover, so two runs never both remove and retake it. A
#    stale lock never becomes live again (its pid is written once), so the
#    check inside the takeover lock stays true until it is removed.
#  - The old file format (r1: a file holding the pid) is understood too.
LOCK_PATH="$BACKUP_DIR/.backup.lock"
TAKEOVER_PATH="$BACKUP_DIR/.backup.lock.takeover"
TAKEOVER_HELD=""
older_than_10min() { [[ -n "$(find "$1" -maxdepth 0 -mmin +10 2>/dev/null)" ]]; }
lock_is_live() { # lock_is_live PATH: 0 when its holder still runs (or may be starting)
  local f="$1" pid cmd
  [[ -e "$f" ]] || return 1
  if [[ -d "$f" ]]; then pid="$(cat "$f/pid" 2>/dev/null || true)"; else pid="$(cat "$f" 2>/dev/null || true)"; fi
  if [[ -z "$pid" ]]; then
    older_than_10min "$f" && return 1
    return 0
  fi
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$cmd" == *backup.sh* ]]
}
take_lock() {
  mkdir "$LOCK_PATH" 2>/dev/null || return 1
  LOCK_HELD="$LOCK_PATH"
  echo "$$" >"$LOCK_PATH/pid"
}
if ! take_lock; then
  [[ -L "$LOCK_PATH" || -L "$TAKEOVER_PATH" ]] && fail 2 lock-is-symlink
  lock_is_live "$LOCK_PATH" && fail 3 busy
  if ! mkdir "$TAKEOVER_PATH" 2>/dev/null; then
    # Another run is taking over right now. A takeover lock left by a run that
    # was killed in that short window is cleared after 10 minutes; this run
    # still stops, so two takers can never overlap.
    older_than_10min "$TAKEOVER_PATH" && rm -rf -- "$TAKEOVER_PATH"
    fail 3 busy
  fi
  TAKEOVER_HELD="$TAKEOVER_PATH"
  if lock_is_live "$LOCK_PATH"; then
    rm -rf -- "$TAKEOVER_PATH"; TAKEOVER_HELD=""
    fail 3 busy
  fi
  rm -rf -- "$LOCK_PATH"
  take_lock || { rm -rf -- "$TAKEOVER_PATH"; TAKEOVER_HELD=""; fail 3 busy; }
  rm -rf -- "$TAKEOVER_PATH"; TAKEOVER_HELD=""
fi
DIR_KEY="$(eve_dir_key "$BACKUP_DIR")"
# F-QA-B-02: under the lock, anything left by a dead run of this folder is garbage.
remove_helpers
# .backup.lock.takeover belongs to a run that may be taking over right now: leave it.
for d in "$BACKUP_DIR"/.work.* "$BACKUP_DIR"/.backup.lock.*; do
  [[ "$d" == "$TAKEOVER_PATH" ]] && continue
  [[ -e "$d" && ! -L "$d" ]] && rm -rf -- "$d"
done

WORK="$(mktemp -d "$BACKUP_DIR/.work.XXXXXX")"
TS="$(eve_now_ts)"
# Two runs in the same second would share names: wait for a fresh second instead of overwriting.
tries=0
while compgen -G "$BACKUP_DIR/eve-*-$TS.*" >/dev/null; do
  tries=$((tries + 1))
  ((tries <= 5)) || fail 1 set-exists
  sleep 1
  TS="$(eve_now_ts)"
done
NOW_EPOCH="$(eve_epoch_of_ts "$TS")"
log "step=start set=$TS"

# finish <partial> <final>: non-empty check, 0600, rename. Prints the byte size.
finish() {
  local partial="$1" final="$2" size
  [[ -s "$partial" ]] || return 1
  chmod 600 "$partial"
  mv -f -- "$partial" "$final"
  size="$(wc -c <"$final" | tr -d ' ')"
  echo "$size"
}

# --- 1. database ---
STEP="db"
t0=$SECONDS
PG="$(eve_pg_container "$PROJECT")" || fail 1 no-postgres
DB_FINAL="$BACKUP_DIR/eve-db-$TS.dump.age"
DB_PARTIAL="$DB_FINAL.partial"
RUN_PARTIALS+=("$DB_PARTIAL")
export EVE_DB_NAME="$POSTGRES_DB" EVE_DB_USER="$DB_BACKUP_ROLE" EVE_COUNT_SQL EVE_COUNT_SH
set +e
# SEC-B-03: PGPASSWORD is set for this docker exec only (not exported, so age never sees it).
PGPASSWORD="$DB_BACKUP_PASSWORD" docker exec -i -e PGPASSWORD -e EVE_DB_NAME -e EVE_DB_USER -e EVE_COUNT_SQL -e EVE_COUNT_SH "$PG" sh -c "$EVE_DUMP_SH" 2>"$WORK/db.err" |
  ( set -o noclobber; age -r "$BACKUP_AGE_RECIPIENT" >"$DB_PARTIAL" ) 2>"$WORK/age.err"
status=("${PIPESTATUS[@]}")
set -e
if ((status[0] != 0)); then
  # The role is bound by row-level security (not BYPASSRLS, or not the backup role).
  if grep -q 'row-level security' "$WORK/db.err"; then fail 1 rls-hides-rows; fi
  if grep -q '^EVEFAIL connect' "$WORK/db.err"; then fail 1 connect; fi
  if grep -q '^EVEFAIL count' "$WORK/db.err"; then fail 1 count; fi
  fail 1 pg_dump
fi
if ((status[1] != 0)); then STEP="encrypt"; fail 1 age; fi
counts="$(grep -m1 '^EVECOUNTS ' "$WORK/db.err" || true)"
[[ "$counts" =~ ^EVECOUNTS\ tables=([0-9]+)\ rows=([0-9]+)\ counts=([0-9a-f]{16})$ ]] || fail 1 count
TABLES="${BASH_REMATCH[1]}" ROWS="${BASH_REMATCH[2]}" DIGEST="${BASH_REMATCH[3]}"
DB_BYTES="$(finish "$DB_PARTIAL" "$DB_FINAL")" || fail 1 empty-output
log "step=db status=done seconds=$((SECONDS - t0)) bytes=$DB_BYTES tables=$TABLES rows=$ROWS counts=$DIGEST"

# --- 2./3. volumes, after the dump (B.3) ---
# F-QA-25: a tmpfs over every VOLUME path of the helper image, so no anonymous volume.
HELPER_TMPFS=()
while IFS= read -r a; do [[ -n "$a" ]] && HELPER_TMPFS+=("$a"); done < <(eve_tmpfs_args "$HELPER_IMAGE")
# archive <step> <volume> <kind>: prints "<bytes> <files>".
archive() {
  local step="$1" volume="$2" kind="$3" final partial out files bytes
  final="$BACKUP_DIR/eve-$kind-$TS.tar.age"
  partial="$final.partial"
  # `docker run -v name:` would silently create an empty volume: check first.
  docker volume inspect "$volume" >/dev/null 2>&1 || return 10
  set +e
  # SEC-B-01: --log-driver none. Its stdout is the plaintext tar; with any log driver the
  # daemon would copy it to the Docker host disk (json-file) or ship it (journald, syslog).
  docker run --rm -i --log-driver none --label eve.backup.helper=1 --label "eve.backup.dir=$DIR_KEY" \
    --network none --read-only --tmpfs /tmp ${HELPER_TMPFS[@]+"${HELPER_TMPFS[@]}"} --cap-drop ALL --cap-add DAC_READ_SEARCH \
    --security-opt no-new-privileges:true -v "$volume:/src:ro" --entrypoint sh "$HELPER_IMAGE" -c "$EVE_ARCHIVE_SH" \
    2>"$WORK/$kind.err" </dev/null | ( set -o noclobber; age -r "$BACKUP_AGE_RECIPIENT" >"$partial" ) 2>"$WORK/age.err"
  local st=("${PIPESTATUS[@]}")
  set -e
  ((st[0] == 0)) || return 11
  ((st[1] == 0)) || return 12
  out="$(grep -m1 '^EVEFILES ' "$WORK/$kind.err" || true)"
  [[ "$out" =~ ^EVEFILES\ files=([0-9]+)$ ]] || return 11
  files="${BASH_REMATCH[1]}"
  bytes="$(finish "$partial" "$final")" || return 13
  echo "$bytes $files"
}

run_archive() {
  local step="$1" volume="$2" kind="$3" t rc result
  STEP="$step"
  t=$SECONDS
  # Tracked here: archive() runs in a subshell, so its variables do not come back.
  RUN_PARTIALS+=("$BACKUP_DIR/eve-$kind-$TS.tar.age.partial")
  set +e
  result="$(archive "$step" "$volume" "$kind")"
  rc=$?
  set -e
  case "$rc" in
    0) ;;
    10) fail 1 no-volume ;;
    11) fail 1 tar ;;
    12) STEP="encrypt"; fail 1 age ;;
    *) fail 1 empty-output ;;
  esac
  log "step=$step status=done seconds=$((SECONDS - t)) bytes=${result% *} files=${result#* }"
  ARCHIVE_RESULT="$result"
}

# EPIC-0002 A2: the per-Candidate root, before the flat volumes so that a set with
# a resumes file always has its candidates file too (retention counts on that).
# Before the A2 deploy the volume does not exist and the step is skipped.
CAND_FIELDS=""
STEP="candidates"
if docker volume inspect "$CAND_VOLUME" >/dev/null 2>&1; then
  run_archive candidates "$CAND_VOLUME" candidates
  CAND_FIELDS=" candidates_bytes=${ARCHIVE_RESULT% *} candidates_files=${ARCHIVE_RESULT#* }"
else
  log "step=candidates status=skipped reason=no-volume"
fi
run_archive documents "$DOC_VOLUME" documents
DOC_BYTES="${ARCHIVE_RESULT% *}" DOC_FILES="${ARCHIVE_RESULT#* }"
run_archive resumes "$RES_VOLUME" resumes
RES_BYTES="${ARCHIVE_RESULT% *}" RES_FILES="${ARCHIVE_RESULT#* }"

# --- 4. retention, only after a complete set (B.7) ---
STEP="retention"
DELETED="$(eve_retention "$BACKUP_DIR" "$NOW_EPOCH" "$RETENTION_DAYS")" || fail 1 delete
[[ "$DELETED" =~ ^[0-9]+$ ]] || fail 1 delete

STEP="done"
FINAL_LOGGED=1
log "status=ok set=$TS db_bytes=$DB_BYTES documents_bytes=$DOC_BYTES resumes_bytes=$RES_BYTES documents_files=$DOC_FILES resumes_files=$RES_FILES tables=$TABLES rows=$ROWS counts=$DIGEST${CAND_FIELDS} deleted=$DELETED seconds=$((SECONDS - STARTED))"
