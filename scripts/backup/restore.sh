#!/usr/bin/env bash
# Restore one Eve backup set (docs/ops/backups.md). Decrypts with an age
# identity file, pg_restores the dump into the postgres service of a target
# compose project, unpacks the documents and resumes archives (and, for sets
# taken after the EPIC-0002 A2 deploy, the per-Candidate candidates archive)
# into target volumes (or empty host directories), then checks the result:
#   - table count, total rows and the per-table count digest match backup.log;
#   - document, resume (and candidates) file counts match backup.log;
#   - every resume_upload / tailored_document row points at a restored file,
#     either flat (pre-A2) or at <candidate_id>/{resumes,documents}/<name> in the
#     candidates target (A2 layout).
#
# Usage:
#   restore.sh --identity FILE --target-project NAME [--target-db NAME] [--target-db-user NAME]
#              (--set UTC_TS [--backup-dir DIR] | --db F --documents F --resumes F [--backup-dir DIR])
#              (--documents-volume V | --documents-dir D) (--resumes-volume V | --resumes-dir D)
#              [--candidates-volume V | --candidates-dir D] [--candidates F]
#              [--env-file PATH] [--no-verify-log] [--replace-live-data]
#
# A candidates target is required when the set has a candidates archive
# (eve-candidates-<set>.tar.age, or --candidates F). For an older set without
# one, a given candidates target is left empty.
#
# The target database must exist and hold no tables; target volumes and
# directories must be empty. Restores use --no-owner --no-acl: objects belong
# to --target-db-user. BACKUP_DIR and the live names are read from .env
# (--env-file, default <repo>/.env). Refused unless --replace-live-data is given
# (documented only in the disaster runbook): any eve* or job-assistant* /
# job_assistant* project or volume in any letter case, and the configured
# BACKUP_COMPOSE_PROJECT, BACKUP_DOCUMENT_VOLUME, BACKUP_RESUME_VOLUME and
# BACKUP_CANDIDATE_VOLUME.
# The identity is read from FILE by age only: never copied, printed or logged.
# Output holds counts only, never file names or row values.
# Exit: 0 restored and verified, 1 a step or check failed, 2 refused (arguments or live target).
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
IDENTITY="" PROJECT="" TARGET_DB="" TARGET_USER="" SET_TS="" BACKUP_DIR_ARG=""
DB_FILE="" DOC_FILE="" RES_FILE="" DOC_VOLUME="" DOC_DIR="" RES_VOLUME="" RES_DIR=""
CAND_FILE="" CAND_VOLUME="" CAND_DIR=""
VERIFY_LOG=1 REPLACE_LIVE=0

say() { printf '%s eve-restore %s\n' "$(eve_now_iso)" "$*"; }
refuse() { say "status=refused reason=$1"; exit 2; }
STEP="args"
die() { say "status=failed step=$STEP reason=$1"; exit 1; }

need() { [[ $# -ge 2 && -n "$2" ]] || refuse "missing-value-$1"; }
while (($#)); do
  case "$1" in
    --identity) need "$@"; IDENTITY="$2"; shift ;;
    --target-project) need "$@"; PROJECT="$2"; shift ;;
    --target-db) need "$@"; TARGET_DB="$2"; shift ;;
    --target-db-user) need "$@"; TARGET_USER="$2"; shift ;;
    --set) need "$@"; SET_TS="$2"; shift ;;
    --backup-dir) need "$@"; BACKUP_DIR_ARG="$2"; shift ;;
    --db) need "$@"; DB_FILE="$2"; shift ;;
    --documents) need "$@"; DOC_FILE="$2"; shift ;;
    --resumes) need "$@"; RES_FILE="$2"; shift ;;
    --documents-volume) need "$@"; DOC_VOLUME="$2"; shift ;;
    --documents-dir) need "$@"; DOC_DIR="$2"; shift ;;
    --resumes-volume) need "$@"; RES_VOLUME="$2"; shift ;;
    --resumes-dir) need "$@"; RES_DIR="$2"; shift ;;
    --candidates) need "$@"; CAND_FILE="$2"; shift ;;
    --candidates-volume) need "$@"; CAND_VOLUME="$2"; shift ;;
    --candidates-dir) need "$@"; CAND_DIR="$2"; shift ;;
    --env-file) need "$@"; ENV_FILE="$2"; shift ;;
    --no-verify-log) VERIFY_LOG=0 ;;
    --replace-live-data) REPLACE_LIVE=1 ;;
    -h | --help) eve_print_help "$0"; exit 0 ;;
    *) refuse unknown-argument ;;
  esac
  shift
done

# F-QA-B-03 / SEC-B-04: read BACKUP_DIR and the configured live names from .env.
eve_load_env "$ENV_FILE"
# Restore never needs a password from .env; a target that asks for one gets PGPASSWORD.
unset DB_OWNER_PASSWORD DB_BACKUP_PASSWORD
HELPER_IMAGE="${BACKUP_HELPER_IMAGE:-postgres:17-alpine}"
# F-QA-22, F-SEC-22: every helper container is labelled with the target project, so a
# caller (the drill's teardown) can find and remove one a signal left `created` or
# running. --init gives it a PID 1 that forwards signals, so TERM stops it promptly.
HELPER_LABELS=(--init --label eve.backup.restore-helper=1 --label "eve.backup.target-project=$PROJECT")
LIVE_PROJECT="${BACKUP_COMPOSE_PROJECT:-eve}"
# The configured live volumes (BACKUP_*_VOLUME) are checked in eve_is_live_target_volume.

# --- argument and live-target checks: nothing is contacted before these pass ---
[[ -n "$IDENTITY" ]] || refuse no-identity
[[ -f "$IDENTITY" && -r "$IDENTITY" ]] || refuse identity-not-readable
[[ -n "$PROJECT" ]] || refuse no-target-project
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || refuse bad-target-project
TARGET_DB="${TARGET_DB:-${POSTGRES_DB:-job_assistant}}"
TARGET_USER="${TARGET_USER:-${DB_OWNER_ROLE:-postgres}}"
[[ "$TARGET_DB" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || refuse bad-target-db
[[ "$TARGET_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || refuse bad-target-db-user
[[ -n "$DOC_VOLUME" || -n "$DOC_DIR" ]] || refuse no-documents-target
[[ -z "$DOC_VOLUME" || -z "$DOC_DIR" ]] || refuse two-documents-targets
[[ -n "$RES_VOLUME" || -n "$RES_DIR" ]] || refuse no-resumes-target
[[ -z "$RES_VOLUME" || -z "$RES_DIR" ]] || refuse two-resumes-targets
[[ -z "$CAND_VOLUME" || -z "$CAND_DIR" ]] || refuse two-candidates-targets
for v in "$DOC_VOLUME" "$RES_VOLUME" "$CAND_VOLUME"; do
  [[ -z "$v" || "$v" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || refuse bad-volume-name
done
[[ -z "$DOC_VOLUME" || "$DOC_VOLUME" != "$RES_VOLUME" ]] || refuse same-volume-twice
[[ -z "$CAND_VOLUME" || ( "$CAND_VOLUME" != "$DOC_VOLUME" && "$CAND_VOLUME" != "$RES_VOLUME" ) ]] || refuse same-volume-twice

live=""
is_live_volume() { eve_is_live_target_volume "$1"; }
{ eve_is_live_name "$PROJECT" || eve_is_live_project "$PROJECT" || [[ "$PROJECT" == "$LIVE_PROJECT" ]]; } && live="$live project"
[[ -n "$DOC_VOLUME" ]] && is_live_volume "$DOC_VOLUME" && live="$live documents-volume"
[[ -n "$RES_VOLUME" ]] && is_live_volume "$RES_VOLUME" && live="$live resumes-volume"
[[ -n "$CAND_VOLUME" ]] && is_live_volume "$CAND_VOLUME" && live="$live candidates-volume"
if [[ -n "$live" && "$REPLACE_LIVE" != 1 ]]; then
  refuse "live-target${live// /,}"
fi
[[ -n "$live" ]] && say "warning=live-target${live// /,} flag=replace-live-data"

BACKUP_DIR="$(eve_expand_home "${BACKUP_DIR_ARG:-${BACKUP_DIR:-~/eve-backups}}")"
if [[ -n "$SET_TS" ]]; then
  [[ -z "$DB_FILE$DOC_FILE$RES_FILE$CAND_FILE" ]] || refuse set-and-files
  eve_epoch_of_ts "$SET_TS" >/dev/null || refuse bad-set
  DB_FILE="$BACKUP_DIR/eve-db-$SET_TS.dump.age"
  DOC_FILE="$BACKUP_DIR/eve-documents-$SET_TS.tar.age"
  RES_FILE="$BACKUP_DIR/eve-resumes-$SET_TS.tar.age"
  # Sets taken before the EPIC-0002 A2 deploy have no candidates archive.
  [[ -e "$BACKUP_DIR/eve-candidates-$SET_TS.tar.age" ]] && CAND_FILE="$BACKUP_DIR/eve-candidates-$SET_TS.tar.age"
else
  [[ -n "$DB_FILE" && -n "$DOC_FILE" && -n "$RES_FILE" ]] || refuse no-backup-files
  re="$EVE_BACKUP_NAME_RE"
  [[ "${DB_FILE##*/}" =~ $re ]] && SET_TS="${BASH_REMATCH[2]}" || SET_TS=""
fi
for f in "$DB_FILE" "$DOC_FILE" "$RES_FILE" ${CAND_FILE:+"$CAND_FILE"}; do [[ -f "$f" && -r "$f" ]] || refuse backup-file-missing; done
[[ -z "$CAND_FILE" || -n "$CAND_VOLUME$CAND_DIR" ]] || refuse no-candidates-target
for d in "$DOC_DIR" "$RES_DIR" "$CAND_DIR"; do
  [[ -z "$d" ]] && continue
  [[ -d "$d" ]] || refuse target-dir-missing
  [[ -z "$(ls -A "$d")" ]] || refuse target-dir-not-empty
done
command -v age >/dev/null 2>&1 || refuse no-age
command -v docker >/dev/null 2>&1 || refuse no-docker

# Expected counts from the backup's own status=ok line (B.10, B.11).
EXP_TABLES="" EXP_ROWS="" EXP_DIGEST="" EXP_DOCS="" EXP_RES="" EXP_CAND=""
if ((VERIFY_LOG)); then
  [[ -n "$SET_TS" && -f "$BACKUP_DIR/backup.log" ]] || refuse no-backup-log-use-no-verify-log
  line="$(grep " status=ok set=$SET_TS " "$BACKUP_DIR/backup.log" | tail -n 1 || true)"
  [[ -n "$line" ]] || refuse set-not-in-backup-log
  [[ "$line" =~ \ documents_files=([0-9]+)\ resumes_files=([0-9]+)\ tables=([0-9]+)\ rows=([0-9]+)\ counts=([0-9a-f]{16})\  ]] || refuse unreadable-backup-log
  EXP_DOCS="${BASH_REMATCH[1]}" EXP_RES="${BASH_REMATCH[2]}" EXP_TABLES="${BASH_REMATCH[3]}" EXP_ROWS="${BASH_REMATCH[4]}" EXP_DIGEST="${BASH_REMATCH[5]}"
  # EPIC-0002 A2: a set whose log line counts candidates files must have that archive.
  if [[ "$line" =~ \ candidates_files=([0-9]+)\  ]]; then
    EXP_CAND="${BASH_REMATCH[1]}"
    [[ -n "$CAND_FILE" ]] || refuse backup-file-missing
  fi
fi

# F-SEC-31: the drill passes EVE_RESTORE_WORK_PARENT, its own 0700 directory, so it
# can remove this work dir (metadata of decrypted data) even if this shell is KILLed
# and never runs its trap. Any other value is refused.
if [[ -n "${EVE_RESTORE_WORK_PARENT:-}" ]]; then
  eve_private_dir "$EVE_RESTORE_WORK_PARENT" || refuse bad-work-parent
  WORK="$(mktemp -d "$EVE_RESTORE_WORK_PARENT/work.XXXXXX")"
else
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/eve-restore.XXXXXX")"
fi
trap 'rm -rf -- "$WORK"' EXIT
STARTED=$SECONDS
# F-QA-24: once a caller (the drill's teardown) creates the file named by
# EVE_RESTORE_STOP_FILE, no new helper container is started: each docker run is
# preceded by this check, and the restore stops with reason=stopped.
helper_guard() { [[ -z "${EVE_RESTORE_STOP_FILE:-}" || ! -e "$EVE_RESTORE_STOP_FILE" ]]; }
# F-SEC-26, F-SEC-28: helper_exec CMD... runs CMD and records it in
# EVE_RESTORE_PID_DIR while it runs: the file cli.<pid> holds "<pid> <start time>"
# (eve_proc_start, shared with the drill). The drill waits for (and KILLs) every recorded CLI, even after it
# has been reparented away from restore.sh, and only if the PID's start time still
# matches, so a reused PID is never signalled. The record is removed as soon as the
# CLI exits; the exit code is kept. CMD is started in the background (so its PID is
# known) with this shell's stdin passed on explicitly: a background job of a
# non-interactive shell would otherwise read /dev/null, and the unpack helper reads
# the decrypted tar on stdin.
helper_exec() {
  local pid rc=0 rec=""
  "$@" <&0 &
  pid=$!
  # F-SEC-33: only into a private directory (real dir, ours, 0700), and never through
  # an existing file or symlink (noclobber, in a subshell so it stays local).
  if [[ -n "${EVE_RESTORE_PID_DIR:-}" ]] && eve_private_dir "$EVE_RESTORE_PID_DIR"; then
    (set -C; printf '%s %s\n' "$pid" "$(eve_proc_start "$pid")" >"$EVE_RESTORE_PID_DIR/cli.$pid") 2>/dev/null && rec="$EVE_RESTORE_PID_DIR/cli.$pid"
  fi
  wait "$pid" || rc=$?
  # F-SEC-36: remove only the record this call wrote.
  [[ -z "$rec" ]] || rm -f -- "$rec" 2>/dev/null || true
  return "$rc"
}
# F-QA-25: the helper image declares VOLUME paths (postgres: /var/lib/postgresql/data),
# so each `docker run` would create an anonymous volume, which a removal without -v
# leaks. A tmpfs over every declared path means no anonymous volume is created.
HELPER_TMPFS=()
while IFS= read -r a; do [[ -n "$a" ]] && HELPER_TMPFS+=("$a"); done < <(eve_tmpfs_args "$HELPER_IMAGE")

# --- 1. database ---
STEP="db"
PG="$(eve_pg_container "$PROJECT")" || die no-postgres
export EVE_DB_NAME="$TARGET_DB" EVE_DB_USER="$TARGET_USER" EVE_COUNT_SQL EVE_COUNT_SH
# Only for a target that asks for a password on the socket; never printed.
export PGPASSWORD="${PGPASSWORD:-}"
EMPTY_SQL="select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_toast%'"
existing="$(docker exec -e PGPASSWORD -e EVE_DB_NAME -e EVE_DB_USER -e Q="$EMPTY_SQL" "$PG" sh -c 'psql -X -q -At -v ON_ERROR_STOP=1 -U "$EVE_DB_USER" -d "$EVE_DB_NAME" -c "$Q"' 2>"$WORK/db.err")" || die connect
[[ "$existing" == 0 ]] || die target-db-not-empty
set +e
age -d -i "$IDENTITY" "$DB_FILE" 2>"$WORK/age.err" |
  docker exec -i -e PGPASSWORD -e EVE_DB_NAME -e EVE_DB_USER "$PG" sh -c 'pg_restore --no-owner --no-acl --exit-on-error -U "$EVE_DB_USER" -d "$EVE_DB_NAME"' 2>"$WORK/db.err"
st=("${PIPESTATUS[@]}")
set -e
((st[0] == 0)) || { STEP="decrypt"; die age; }
((st[1] == 0)) || die pg_restore
if ! counts="$(docker exec -e PGPASSWORD -e EVE_DB_NAME -e EVE_DB_USER -e EVE_COUNT_SQL -e EVE_COUNT_SH "$PG" sh -c "$EVE_COUNT_SH" 2>"$WORK/db.err")"; then
  # The target user is bound by the restored FORCE ROW LEVEL SECURITY, so it cannot
  # see every row to check them. Restore as a superuser (see docs/ops/backups.md).
  grep -q 'row-level security' "$WORK/db.err" && die rls-hides-rows
  die count
fi
[[ "$counts" =~ ^EVECOUNTS\ tables=([0-9]+)\ rows=([0-9]+)\ counts=([0-9a-f]{16})$ ]] || die count
GOT_TABLES="${BASH_REMATCH[1]}" GOT_ROWS="${BASH_REMATCH[2]}" GOT_DIGEST="${BASH_REMATCH[3]}"
say "step=db status=done tables=$GOT_TABLES rows=$GOT_ROWS counts=$GOT_DIGEST"

# --- 2./3. volumes or directories ---
# unpack <file> <volume> <dir>: extracts into an empty target, prints the regular-file count.
COUNT_FILES_SH='find /dst -type f | wc -l | tr -d " "'
unpack() {
  local file="$1" volume="$2" dir="$3" st
  if [[ -n "$volume" ]]; then
    set +e
    helper_guard || return 15
    # shellcheck disable=SC2016 # the -c script runs in the container's sh
    age -d -i "$IDENTITY" "$file" 2>"$WORK/age.err" |
      ( helper_exec docker run --rm -i "${HELPER_LABELS[@]}" ${HELPER_TMPFS[@]+"${HELPER_TMPFS[@]}"} --log-driver none --network none --entrypoint sh -v "$volume:/dst" "$HELPER_IMAGE" -c \
        '[ -z "$(ls -A /dst)" ] || { echo EVEFAIL not-empty >&2; exit 9; }; exec tar -xf - -C /dst' ) 2>"$WORK/tar.err"
    st=("${PIPESTATUS[@]}")
    set -e
    ((st[0] == 0)) || return 12
    ((st[1] == 9)) && return 14
    ((st[1] == 0)) || return 11
    helper_guard || return 15
    ( helper_exec docker run --rm "${HELPER_LABELS[@]}" ${HELPER_TMPFS[@]+"${HELPER_TMPFS[@]}"} --log-driver none --network none --entrypoint sh -v "$volume:/dst:ro" "$HELPER_IMAGE" -c "$COUNT_FILES_SH" ) || return 11
  else
    set +e
    age -d -i "$IDENTITY" "$file" 2>"$WORK/age.err" | tar -xf - -C "$dir" 2>"$WORK/tar.err"
    st=("${PIPESTATUS[@]}")
    set -e
    ((st[0] == 0)) || return 12
    ((st[1] == 0)) || return 11
    find "$dir" -type f | wc -l | tr -d ' '
  fi
}

restore_archive() {
  local step="$1" file="$2" volume="$3" dir="$4" rc n
  STEP="$step"
  set +e
  n="$(unpack "$file" "$volume" "$dir")"
  rc=$?
  set -e
  case "$rc" in
    0) ;;
    12) STEP="decrypt"; die age ;;
    15) die stopped ;;
    14) die target-volume-not-empty ;;
    *) die tar ;;
  esac
  [[ "$n" =~ ^[0-9]+$ ]] || die count
  say "step=$step status=done files=$n"
  ARCHIVE_FILES="$n"
}
restore_archive documents "$DOC_FILE" "$DOC_VOLUME" "$DOC_DIR"
GOT_DOCS="$ARCHIVE_FILES"
restore_archive resumes "$RES_FILE" "$RES_VOLUME" "$RES_DIR"
GOT_RES="$ARCHIVE_FILES"
GOT_CAND=""
if [[ -n "$CAND_FILE" ]]; then
  restore_archive candidates "$CAND_FILE" "$CAND_VOLUME" "$CAND_DIR"
  GOT_CAND="$ARCHIVE_FILES"
else
  say "step=candidates status=skipped reason=no-archive"
fi

# --- 4. file references: every stored name in the database exists in its restored folder ---
STEP="references"
# Names stay in this process's temp dir (0700) and are never printed.
q_names() {
  local sql="$1"
  docker exec -e PGPASSWORD -e EVE_DB_NAME -e EVE_DB_USER -e Q="$sql" "$PG" sh -c 'psql -X -q -At -v ON_ERROR_STOP=1 -U "$EVE_DB_USER" -d "$EVE_DB_NAME" -c "$Q"' 2>"$WORK/db.err"
}
list_files() {
  local volume="$1" dir="$2"
  if [[ -n "$volume" ]]; then
    helper_guard || return 15
    ( helper_exec docker run --rm "${HELPER_LABELS[@]}" ${HELPER_TMPFS[@]+"${HELPER_TMPFS[@]}"} --log-driver none --network none --entrypoint sh -v "$volume:/dst:ro" "$HELPER_IMAGE" -c 'cd /dst && find . -type f | sed "s|^\./||"' )
  else
    (cd "$dir" && find . -type f | sed 's|^\./||')
  fi
}
# A2 layout: <candidate_id>/<area>/<name> in the candidates target. Tables
# without candidate_id (pre-EPIC-0002 schema) give an empty Candidate ID.
has_cid() { # has_cid TABLE: prints 1 when public.TABLE has candidate_id
  q_names "select count(*) from information_schema.columns where table_schema = 'public' and table_name = '$1' and column_name = 'candidate_id'"
}
cid_expr() { if [[ "$(has_cid "$1")" == 1 ]]; then echo "candidate_id::text"; else echo "''"; fi; }
RES_CID="$(cid_expr resume_upload)" || die count
DOC_CID="$(cid_expr tailored_document)" || die count
RES_SQL="select case when to_regclass('public.resume_upload') is null then '' else (select coalesce(string_agg($RES_CID || '|' || storage_name, E'\n'), '') from public.resume_upload) end"
DOC_SQL="select case when to_regclass('public.tailored_document') is null then '' else (select coalesce(string_agg(c || '|' || n, E'\n'), '') from (select $DOC_CID as c, pdf_storage_name as n from public.tailored_document union all select $DOC_CID, docx_storage_name from public.tailored_document) s) end"
q_names "$RES_SQL" | grep . | sort -u >"$WORK/res.refs" || true
q_names "$DOC_SQL" | grep . | sort -u >"$WORK/doc.refs" || true
helper_guard || die stopped
list_files "$RES_VOLUME" "$RES_DIR" | sort -u >"$WORK/res.files" || die list
list_files "$DOC_VOLUME" "$DOC_DIR" | sort -u >"$WORK/doc.files" || die list
: >"$WORK/cand.files"
if [[ -n "$CAND_FILE" ]]; then list_files "$CAND_VOLUME" "$CAND_DIR" | sort -u >"$WORK/cand.files" || die list; fi
# missing <refs> <flat files> <area>: a reference is found flat, or at its A2 path.
missing() {
  awk -F'|' -v area="$3" 'FILENAME == ARGV[1] { flat[$0] = 1; next }
    FILENAME == ARGV[2] { cand[$0] = 1; next }
    { name = substr($0, length($1) + 2); if (!(name in flat) && !($1 != "" && ($1 "/" area "/" name) in cand)) n++ }
    END { printf "%d", n }' "$2" "$WORK/cand.files" "$1"
}
RES_REFS="$(grep -c . "$WORK/res.refs" || true)"
DOC_REFS="$(grep -c . "$WORK/doc.refs" || true)"
RES_MISSING="$(missing "$WORK/res.refs" "$WORK/res.files" resumes)"
DOC_MISSING="$(missing "$WORK/doc.refs" "$WORK/doc.files" documents)"
say "step=references resume_refs=$RES_REFS resume_missing=$RES_MISSING document_refs=$DOC_REFS document_missing=$DOC_MISSING"

# --- 5. compare with backup.log ---
STEP="verify"
problems=""
((RES_MISSING == 0)) || problems="$problems,resume-files-missing"
((DOC_MISSING == 0)) || problems="$problems,document-files-missing"
if ((VERIFY_LOG)); then
  [[ "$GOT_TABLES" == "$EXP_TABLES" ]] || problems="$problems,tables"
  [[ "$GOT_ROWS" == "$EXP_ROWS" ]] || problems="$problems,rows"
  [[ "$GOT_DIGEST" == "$EXP_DIGEST" ]] || problems="$problems,per-table-counts"
  [[ "$GOT_DOCS" == "$EXP_DOCS" ]] || problems="$problems,documents-files"
  [[ "$GOT_RES" == "$EXP_RES" ]] || problems="$problems,resumes-files"
  [[ "$GOT_CAND" == "$EXP_CAND" ]] || problems="$problems,candidates-files"
  verified="backup-log"
else
  verified="references-only"
fi
if [[ -n "$problems" ]]; then
  say "status=failed step=verify reason=mismatch${problems} expected_tables=${EXP_TABLES:-?} tables=$GOT_TABLES expected_rows=${EXP_ROWS:-?} rows=$GOT_ROWS expected_documents=${EXP_DOCS:-?} documents=$GOT_DOCS expected_resumes=${EXP_RES:-?} resumes=$GOT_RES expected_candidates=${EXP_CAND:-none} candidates=${GOT_CAND:-none}"
  exit 1
fi
say "status=ok set=${SET_TS:-files} verified=$verified tables=$GOT_TABLES rows=$GOT_ROWS documents_files=$GOT_DOCS resumes_files=$GOT_RES${GOT_CAND:+ candidates_files=$GOT_CAND} resume_missing=0 document_missing=0 seconds=$((SECONDS - STARTED))"
