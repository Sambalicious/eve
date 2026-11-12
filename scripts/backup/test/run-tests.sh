#!/usr/bin/env bash
# Tests for scripts/backup (docs/ops/backups.md). TAP-style output, plain bash
# like docker/test/*.sh (the repo has no bats). Uses ONLY throwaway resources:
#   - compose project ja-ops-backup-test (source Postgres, fake data),
#   - volumes ja-ops-backup-test_documents / _resumes / _candidates (fake files),
#   - compose project ja-ops-backup-test-drill (restore target),
#   - an age key pair generated in a temp dir and deleted at the end.
# It never touches the eve / job-assistant projects or their volumes, and
# never prints the private key.
#
# Usage: [BACKUP_TEST_PROJECT=name] scripts/backup/test/run-tests.sh [--unit-only]
# Needs bash, docker with Compose v2 and age/age-keygen on PATH (or AGE_BIN_DIR).
set -Euo pipefail
umask 077

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "$TEST_DIR/.." && pwd)"
UNIT_ONLY=0
[[ "${1:-}" == "--unit-only" ]] && UNIT_ONLY=1
[[ -n "${AGE_BIN_DIR:-}" ]] && PATH="$AGE_BIN_DIR:$PATH"
export PATH
command -v age >/dev/null && command -v age-keygen >/dev/null || { echo "Bail out! age and age-keygen are required"; exit 1; }

# BACKUP_TEST_PROJECT lets parallel runs use their own throwaway names (must start with ja-).
PROJECT="${BACKUP_TEST_PROJECT:-ja-ops-backup-test}"
[[ "$PROJECT" =~ ^ja-[a-z0-9-]+$ ]] || { echo "Bail out! BACKUP_TEST_PROJECT must match ja-[a-z0-9-]+"; exit 1; }
DRILL_PROJECT="${PROJECT}-drill"
DOC_VOL="${PROJECT}_documents"
RES_VOL="${PROJECT}_resumes"
# EPIC-0002 A2 per-Candidate root. Absent until the A2 section at the end, so every
# earlier test runs the pre-A2 (flat volumes only) path.
CAND_VOL="${PROJECT}_candidates"
A2_DOC_VOL="${PROJECT}_a2documents" A2_RES_VOL="${PROJECT}_a2resumes"
for name in "$PROJECT" "$DRILL_PROJECT" "$DOC_VOL" "$RES_VOL" "$CAND_VOL" "$A2_DOC_VOL" "$A2_RES_VOL"; do
  case "$name" in eve | eve_* | eve-* | job-assistant*) echo "Bail out! refusing live name"; exit 1 ;; esac
done

T="$(mktemp -d "${TMPDIR:-/tmp}/eve-backup-test.XXXXXX")"
export TMPDIR="$T/tmp"
mkdir -p "$TMPDIR"
# Guard HOME for every script run (run a2g safety): its eve-backups is a plain file,
# so a call that fell back to the default ~/eve-backups fails instead of writing the
# owner's real backups. Docker keeps its real config (contexts, compose plugin).
TEST_HOME="$T/guard-home"
mkdir -p "$TEST_HOME" && : >"$TEST_HOME/eve-backups"
DOCKER_CFG="${DOCKER_CONFIG:-$HOME/.docker}"
KEY="$T/keys/identity.txt"
mkdir -p "$T/keys"
age-keygen -o "$KEY" 2>/dev/null
RECIPIENT="$(age-keygen -y "$KEY")"
OTHER_KEY="$T/keys/other.txt"
age-keygen -o "$OTHER_KEY" 2>/dev/null
# A different, valid recipient, used to prove the log never shows the configured one.
export BOOTSTRAP_PW="tb$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
# Marker strings (B.11). None of them may appear in any backup or restore output.
MARK_PW="MarkerOwnerPw$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
# fix-backup-role: the backup role's password. backup.sh logs in with this one, never the owner's.
MARK_BACKUP_PW="MarkerBackupPw$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
MARK_PROFILE="MarkerProfileText-Ada-Lovelace-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
MARK_DOCNAME="MarkerSecretCoverLetter-Acme.pdf"
MARK_RESNAME="MarkerResumeOriginal-Ada.pdf"
MARK_URL="postgres://ja_owner:${MARK_PW}@postgres:5432/job_assistant"

PASS=0 FAIL=0 N=0
MNTS=()
ok() { N=$((N + 1)); PASS=$((PASS + 1)); echo "ok $N - $1"; }
not_ok() { N=$((N + 1)); FAIL=$((FAIL + 1)); echo "not ok $N - $1${2:+ # $2}"; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else not_ok "$name"; fi; }

COMPOSE=(docker compose -p "$PROJECT" -f "$TEST_DIR/compose.test.yml")
DRILL_COMPOSE=(docker compose -p "$DRILL_PROJECT" -f "$SCRIPTS/drill.compose.yml")
# Harness exit (run a2i, devops-3): every script this suite starts runs against stubs
# in $T. A script still running when $T is removed would find its stub directory gone
# and fall through to the real docker CLI (this left the unlabelled volume
# ja-a2h-f26_documents behind when a run was killed). So, before anything is removed,
# stop_suite_procs ends every process of this run: the harness's descendants and any
# process whose command line names $T (helpers reparented away from the harness),
# TERM first, so the drills tear down against their stubs, then KILL after 20 s.
# Then remove_suite_volumes removes the unit cases' fixed-name volumes that did not
# exist when the run started. A kill -9 of the harness itself cannot run any of this
# and can still leave such a volume: remove it by hand (docs/ops/backups.md).
suite_procs() { # suite_procs ROOT TAG: PIDs of this run: ROOT's descendants and processes naming TAG
  # One snapshot; the subtree of this lookup itself (its subshell, ps, awk) is left
  # out, and TAG is passed in the environment so it is not in awk's own command line.
  # (bash 3.2 on macOS has no BASHPID: the PPID of an exec'd sh is this shell.)
  local self snap
  self="$(exec sh -c 'echo "$PPID"')"
  snap="$(ps -A -o pid= -o ppid= -o args= 2>/dev/null)" || return 0
  t="$2" awk -v root="$1" -v self="$self" '
    function under(p, a,   n) { n = 0; while (p + 0 > 1 && n++ < 4096) { if (p == a) return 1; p = pp[p] } return 0 }
    { pid[NR] = $1; pp[$1] = $2; line[$1] = $0 }
    END { for (i = 1; i <= NR; i++) { p = pid[i]
      if (p != root && !under(p, self) && (under(p, root) || index(line[p], ENVIRON["t"]))) print p } }' <<<"$snap"
}
SUITE_STOP_BOUND=20
stop_suite_procs() { # stop_suite_procs ROOT TAG
  local p left start=$SECONDS
  for p in $(suite_procs "$1" "$2"); do kill -TERM "$p" 2>/dev/null || true; done
  while left="$(suite_procs "$1" "$2")"; [[ -n "$left" ]] && ((SECONDS - start < SUITE_STOP_BOUND)); do sleep 0.25; done
  for p in $left; do kill -KILL "$p" 2>/dev/null || true; done
  return 0
}
# The fixed throwaway projects of the unit cases (never used outside this suite).
SUITE_UNIT_PROJECTS="ja-a2f-drill19 ja-a2g-drill18 ja-a2g-drill20 ja-a2g-helper ja-a2g-keepup ja-a2g-nofile ja-a2g-race ja-a2h-f26 ja-a2h-f30 ja-a2h-f31 ja-a2h-late ja-a2h-flag ja-a2i-q27 ja-ops-drill-f6"
SUITE_VOLS0="$(docker volume ls -q 2>/dev/null | sort || true)"
remove_suite_volumes() { # removes new volumes named <unit project>_* (in-use ones are refused by Docker)
  local v p rm=()
  while IFS= read -r v; do
    [[ -n "$v" ]] || continue
    grep -qxF -- "$v" <<<"$SUITE_VOLS0" && continue
    for p in $SUITE_UNIT_PROJECTS; do [[ "$v" == "${p}_"* ]] && rm+=("$v"); done
  done < <(docker volume ls -q 2>/dev/null)
  ((${#rm[@]} == 0)) || docker volume rm "${rm[@]}" >/dev/null 2>&1 || true
}
cleanup() {
  trap '' HUP INT TERM # a second signal must not cut the cleanup short
  stop_suite_procs "$$" "$T"
  remove_suite_volumes
  for m in ${MNTS[@]+"${MNTS[@]}"}; do hdiutil detach "$m" -force >/dev/null 2>&1; done
  if ((UNIT_ONLY == 0)); then
    "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
    "${DRILL_COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
    docker rm -fv "${PROJECT}-deadhelper" "${PROJECT}-otherhelper" "${PROJECT}-probe-default" "${PROJECT}-probe-none" >/dev/null 2>&1 || true
    docker volume rm -f "$DOC_VOL" "$RES_VOL" "$CAND_VOL" "$A2_DOC_VOL" "$A2_RES_VOL" "${DRILL_PROJECT}_documents" "${DRILL_PROJECT}_resumes" "${DRILL_PROJECT}_candidates" "${DRILL_PROJECT}_w1" "${DRILL_PROJECT}_w2" ${PROJECT}-foreign_documents >/dev/null 2>&1 || true
  fi
  if [[ -n "${BACKUP_TEST_KEEP_OUTPUT:-}" ]]; then
    # Debug aid: keep outputs, but never the keys.
    rm -rf -- "$T/keys"
    echo "# kept outputs in $T (keys deleted)"
  else
    rm -rf -- "$T"
  fi
}
trap cleanup EXIT
# TERM and HUP end bash at once and run the EXIT trap. A non-interactive bash would
# wait for the foreground command on INT, so INT exits explicitly.
trap 'exit 130' INT

# F-QA-26: the suite uses the same portable mode check as the scripts.
mode_of() { (. "$SCRIPTS/lib.sh" && eve_mode "$1"); }
# Fails if any marker or secret shows up in the given files.
no_markers() {
  local f
  for f in "$@"; do
    [[ -f "$f" ]] || continue
    if grep -F -q -e "$MARK_PW" -e "$MARK_BACKUP_PW" -e "$MARK_PROFILE" -e "$MARK_DOCNAME" -e "$MARK_RESNAME" -e "$MARK_URL" -e "$RECIPIENT" -e "AGE-SECRET-KEY" -e "$KEY" -e "$BOOTSTRAP_PW" "$f"; then
      return 1
    fi
  done
}
env_file() { # env_file PATH RECIPIENT DIR [backup_pw]
  cat >"$1" <<EOF
# test env, fake values only
POSTGRES_DB=job_assistant
DB_OWNER_ROLE=ja_owner
DB_OWNER_PASSWORD=$MARK_PW
DB_BACKUP_ROLE=ja_backup
DB_BACKUP_PASSWORD=${4-$MARK_BACKUP_PW}
MIGRATION_DATABASE_URL=$MARK_URL
BACKUP_AGE_RECIPIENT=$2
BACKUP_DIR=$3
BACKUP_COMPOSE_PROJECT=$PROJECT
BACKUP_DOCUMENT_VOLUME=$DOC_VOL
BACKUP_RESUME_VOLUME=$RES_VOL
BACKUP_CANDIDATE_VOLUME=$CAND_VOL
EOF
}

# Safety (run a2g): no invocation in this suite may resolve BACKUP_DIR to the owner's
# real ~/eve-backups. Every run of a backup script goes through `env -i` with HOME set
# to a guard directory whose eve-backups is a plain file (any default write fails), and
# the real folder's listing must be unchanged at the end.
REAL_EVE_BACKUPS="$HOME/eve-backups"
# Portable (GNU and BSD): names, sizes and mtimes via find + the shared stat flavour.
real_backups_state() {
  [[ -d "$REAL_EVE_BACKUPS" ]] || { echo absent; return 0; }
  if stat --version >/dev/null 2>&1; then
    find "$REAL_EVE_BACKUPS" -mindepth 1 -exec stat -c '%n %s %Y %a' {} + 2>/dev/null | sort | cksum
  else
    find "$REAL_EVE_BACKUPS" -mindepth 1 -exec stat -f '%N %z %m %Lp' {} + 2>/dev/null | sort | cksum
  fi
}
REAL_BACKUPS_BEFORE="$(real_backups_state)"
script_calls_use_guard_home() { # every line that runs a backup script (not --help) uses env -i and a non-real HOME
  local bad
  bad="$(grep -nE '(backup|restore|restore-drill|backup-status)\.sh"' "$1" | grep -E 'bash "[^"]*/(backup|restore|restore-drill|backup-status)\.sh"' | grep -v -- '--help' | grep -vE '^[0-9]+:[[:space:]]*(awk|cp|grep|sed) ' | grep -vE 'env -i .*HOME="\$(TEST_HOME|HOMET|T(/[a-z-]+)?)"' || true)"
  [[ -z "$bad" ]] || { printf '# unguarded: %s\n' "$bad" >&2; return 1; }
}
check "safety: every backup-script call in this suite uses env -i with a guard HOME, never the real one" script_calls_use_guard_home "$TEST_DIR/run-tests.sh"
check "safety: the guard HOME's eve-backups is a plain file, so a default BACKUP_DIR cannot be written" bash -c '[[ -n ${2:-} && $2 != "$1" && -f $2/eve-backups && ! -d $2/eve-backups ]]' _ "$HOME" "${TEST_HOME:-}"

# ---------------------------------------------------------------- unit tests
echo "# unit"
# shellcheck source=../lib.sh
. "$SCRIPTS/lib.sh"

epoch_ok=1
for ts in 19700101T000000Z 20000229T120000Z 20261023T010000Z 20261231T235959Z 21000301T000000Z; do
  want="$(TZ=UTC date -j -f '%Y%m%dT%H%M%SZ' "$ts" +%s 2>/dev/null || TZ=UTC date -d "$(echo "$ts" | sed -E 's/(....)(..)(..)T(..)(..)(..)Z/\1-\2-\3 \4:\5:\6/')" +%s)"
  [[ "$(eve_epoch_of_ts "$ts")" == "$want" ]] || epoch_ok=0
done
check "filename timestamps convert to epoch seconds like date(1)" test "$epoch_ok" = 1
check "malformed timestamps are rejected" bash -c '. "$1"; ! eve_epoch_of_ts 2026-10-23 && ! eve_epoch_of_ts 20261323T000000Z' _ "$SCRIPTS/lib.sh"

check "a real age recipient is accepted" eve_check_recipient "$RECIPIENT"
eve_check_recipient ""; rc=$?
check "an empty recipient is reported as missing (1)" test "$rc" = 1
bad_ok=1
bad_checksum="${RECIPIENT%?}$([[ "${RECIPIENT: -1}" == q ]] && echo p || echo q)"
for bad in "age1" "AGE1${RECIPIENT#age1}" "$bad_checksum" "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample" "${RECIPIENT} extra" "age1notakey" "age1$(printf 'b%.0s' {1..58})"; do
  eve_check_recipient "$bad"; rc=$?
  [[ "$rc" == 2 ]] || bad_ok=0
done
check "malformed recipients (bad checksum, wrong prefix, ssh key, trailing text, bad charset) are rejected (2)" test "$bad_ok" = 1

# Retention fixtures: names only, no docker.
R="$T/retention"
mkdir -p "$R"
now="$(eve_epoch_of_ts 20261123T010000Z)"
mkset() { local ts="$1"; for k in db:dump documents:tar resumes:tar; do echo x >"$R/eve-${k%%:*}-$ts.${k#*:}.age"; done; }
mkset 20261123T010000Z            # today
mkset 20261024T010001Z            # 29d 23h59m59s old: kept
mkset 20261024T005959Z            # 30 days + 1s: deleted
mkset 20260901T010000Z            # old: deleted
echo x >"$R/eve-db-20260801T010000Z.dump.age.partial"
echo x >"$R/notes.txt"
echo x >"$R/eve-db-20260101T010000Z.tar.age" # wrong extension for its kind: not ours, kept
echo x >"$R/eve-db-2026.dump.age"
echo x >"$R/backup.log"
touch -t 202611230100 "$R/eve-db-20260901T010000Z.dump.age" # a fresh mtime must not save an old name
del="$(eve_retention "$R" "$now" 30)"
left="$(cd "$R" && ls | sort | tr '\n' ' ')"
want_left="backup.log eve-db-2026.dump.age eve-db-20260101T010000Z.tar.age eve-db-20261024T010001Z.dump.age eve-db-20261123T010000Z.dump.age eve-documents-20261024T010001Z.tar.age eve-documents-20261123T010000Z.tar.age eve-resumes-20261024T010001Z.tar.age eve-resumes-20261123T010000Z.tar.age notes.txt "
check "retention deletes by file name only: 30d+1s and older go, 29d23h kept, others untouched" test "$left" = "$want_left"
check "retention reports the number deleted (6 old files + 1 leftover partial)" test "$del" = 7

R2="$T/retention2"
mkdir -p "$R2"
R="$R2"
mkset 20260101T010000Z
mkset 20260201T010000Z
echo x >"$R/eve-db-20260301T010000Z.dump.age"          # incomplete newer set (db only)
echo x >"$R/eve-documents-20260301T010000Z.tar.age"
del="$(eve_retention "$R2" "$now" 30)"
left="$(cd "$R2" && ls | sort | tr '\n' ' ')"
check "retention never deletes the newest complete set, even when it is older than 30 days" test "$left" = "eve-db-20260201T010000Z.dump.age eve-documents-20260201T010000Z.tar.age eve-resumes-20260201T010000Z.tar.age "
check "older and incomplete sets past 30 days are deleted around it" test "$del" = 5

# EPIC-0002 A2: sets with a fourth (candidates) file.
R3="$T/retention3"
mkdir -p "$R3"
R="$R3"
mkset 20261120T010000Z && echo x >"$R/eve-candidates-20261120T010000Z.tar.age"   # A2 set, fresh
mkset 20261001T010000Z && echo x >"$R/eve-candidates-20261001T010000Z.tar.age"   # A2 set, old
mkset 20260901T010000Z                                                           # pre-A2 set, old
echo x >"$R/eve-candidates-20260801T010000Z.tar.age.partial"
del="$(eve_retention "$R3" "$now" 30)"
left="$(cd "$R3" && ls | sort | tr '\n' ' ')"
check "A2: retention treats a set with a candidates file as complete and deletes old candidates files with their set" \
  test "$left" = "eve-candidates-20261120T010000Z.tar.age eve-db-20261120T010000Z.dump.age eve-documents-20261120T010000Z.tar.age eve-resumes-20261120T010000Z.tar.age "
check "A2: retention count includes the old candidates file and its partial (4 + 3 + 1)" test "$del" = 8
R4="$T/retention4"
mkdir -p "$R4"
R="$R4"
mkset 20260101T010000Z && echo x >"$R/eve-candidates-20260101T010000Z.tar.age"
del="$(eve_retention "$R4" "$now" 30)"
check "A2: the newest complete set keeps its candidates file even when older than 30 days" test "$del" = 0 -a -f "$R4/eve-candidates-20260101T010000Z.tar.age"

# Env parsing: whitelisted keys only, never sourced.
cat >"$T/parse.env" <<'EOF'
BACKUP_DIR="/tmp/quoted dir"
BACKUP_AGE_RECIPIENT=$(touch /tmp/eve-backup-test-should-not-exist)
EVIL=$(touch /tmp/eve-backup-test-should-not-exist)
export POSTGRES_DB=job_assistant
EOF
parsed="$(env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash -c '. "$1"; eve_load_env "$2"; printf "%s|%s|%s|%s" "$BACKUP_DIR" "$BACKUP_AGE_RECIPIENT" "${EVIL-unset}" "$POSTGRES_DB"' _ "$SCRIPTS/lib.sh" "$T/parse.env")"
check "env file is parsed, not sourced: quotes stripped, no command substitution, unknown keys ignored" \
  test "$parsed" = '/tmp/quoted dir|$(touch /tmp/eve-backup-test-should-not-exist)|unset|job_assistant'
check "no command in the env file ran" test ! -e /tmp/eve-backup-test-should-not-exist

# Refusals: a fake docker records any call; none may happen.
FAKE="$T/fakebin"
mkdir -p "$FAKE"
printf '#!/bin/sh\necho "$@" >>"%s/docker.calls"\nexit 1\n' "$T" >"$FAKE/docker"
chmod 755 "$FAKE/docker"
refusal() { # refusal NAME RECIPIENT EXPECTED_REASON
  local d="$T/refuse-$1" out rc
  rm -f "$T/docker.calls"
  env_file "$T/refuse.env" "$2" "$d"
  out="$(env -i PATH="$FAKE:$PATH" HOME="$TEST_HOME" bash "$SCRIPTS/backup.sh" --nightly --env-file "$T/refuse.env" 2>&1)"
  rc=$?
  printf '%s\n' "$out" >"$T/refuse-$1.out"
  [[ "$rc" == 2 ]] && [[ "$out" == *"status=failed step=config reason=$3"* ]] && [[ ! -e "$d" ]] && [[ ! -e "$T/docker.calls" ]]
}
check "no recipient: exit 2, reason=no-recipient, nothing written, docker never called" refusal unset "" no-recipient
check "malformed recipient: exit 2, reason=bad-recipient, nothing written, docker never called" refusal bad "age1notavalidkey" bad-recipient
check "bad checksum recipient: exit 2, reason=bad-recipient" refusal checksum "$bad_checksum" bad-recipient
check "refusal output never echoes the bad recipient value" bash -c '! grep -q -e age1notavalidkey -e "$1" "$2"/refuse-*.out' _ "$bad_checksum" "$T"
# fix-backup-role: the dump needs the backup role (0017 forces RLS; no other role can read every row).
role_refusal() { # role_refusal NAME SED EXPECTED_REASON
  local d="$T/refuse-$1" out rc
  rm -f "$T/docker.calls"
  env_file "$T/refuse.env" "$RECIPIENT" "$d"
  sed -i.bak "$2" "$T/refuse.env" && rm -f "$T/refuse.env.bak"
  out="$(env -i PATH="$FAKE:$PATH" HOME="$TEST_HOME" bash "$SCRIPTS/backup.sh" --env-file "$T/refuse.env" 2>&1)"
  rc=$?
  printf '%s\n' "$out" >"$T/refuse-$1.out"
  [[ "$rc" == 2 && "$out" == *"status=failed step=config reason=$3"* && "$out" == *"DB_BACKUP_ROLE and DB_BACKUP_PASSWORD"* && ! -e "$d" && ! -e "$T/docker.calls" ]]
}
check "no DB_BACKUP_ROLE: exit 2, reason=no-backup-role, says which keys to set, nothing written, docker never called" role_refusal norole '/^DB_BACKUP_ROLE=/d' no-backup-role
check "empty DB_BACKUP_PASSWORD: exit 2, reason=no-backup-password, nothing written, docker never called" role_refusal nopw 's/^DB_BACKUP_PASSWORD=.*/DB_BACKUP_PASSWORD=/' no-backup-password
check "the owner password is not a fallback: owner keys set, backup password missing still refuses" role_refusal ownerpw '/^DB_BACKUP_PASSWORD=/d' no-backup-password
check "role refusals never print a password" no_markers "$T"/refuse-norole.out "$T"/refuse-nopw.out "$T"/refuse-ownerpw.out
env_file "$T/refuse.env" "$RECIPIENT" "$T/refuse-ret" && echo "BACKUP_RETENTION_DAYS=45" >>"$T/refuse.env"
out="$(env -i PATH="$FAKE:$PATH" HOME="$TEST_HOME" bash "$SCRIPTS/backup.sh" --env-file "$T/refuse.env" 2>&1)"; rc=$?
check "retention above ADR 0004's 30 days is refused (exit 2, reason=bad-retention)" bash -c '[[ $1 == 2 && $2 == *"reason=bad-retention"* ]] && [[ ! -e $3 ]]' _ "$rc" "$out" "$T/refuse-ret"
mkdir -p "$T/refuse-existing" && chmod 700 "$T/refuse-existing" && : >"$T/refuse-existing/backup.log"
env_file "$T/refuse.env" "" "$T/refuse-existing"
env -i PATH="$FAKE:$PATH" HOME="$TEST_HOME" bash "$SCRIPTS/backup.sh" --env-file "$T/refuse.env" >/dev/null 2>&1
check "with an existing backup.log, a refused run logs its status=failed line there" grep -q "status=failed step=config reason=no-recipient" "$T/refuse-existing/backup.log"

# restore.sh refuses live targets before contacting docker.
mkdir -p "$T/fakeset"
for k in db:dump documents:tar resumes:tar; do echo x >"$T/fakeset/eve-${k%%:*}-20261023T010000Z.${k#*:}.age"; done
live_refusal() {
  rm -f "$T/docker.calls"
  local out rc
  out="$(env -i PATH="$FAKE:$PATH" HOME="$TEST_HOME" bash "$SCRIPTS/restore.sh" --identity "$KEY" --set 20261023T010000Z --backup-dir "$T/fakeset" --no-verify-log "$@" 2>&1)"
  rc=$?
  [[ "$rc" == 2 && "$out" == *"status=refused reason=live-target"* && ! -e "$T/docker.calls" ]]
}
check "restore refuses target project eve" live_refusal --target-project eve --documents-dir "$T" --resumes-dir "$T"
check "restore refuses target project job-assistant" live_refusal --target-project job-assistant --documents-dir "$T" --resumes-dir "$T"
check "restore refuses volume job-assistant_document-data" live_refusal --target-project scratch --documents-volume job-assistant_document-data --resumes-volume scratch_r
check "restore refuses volume job-assistant_resume-data" live_refusal --target-project scratch --documents-volume scratch_d --resumes-volume job-assistant_resume-data
check "restore refuses any eve_* volume" live_refusal --target-project scratch --documents-volume eve_documents --resumes-volume scratch_r
check "A2: restore refuses volume job-assistant_candidate-data" live_refusal --target-project scratch --documents-volume scratch_d --resumes-volume scratch_r --candidates-volume job-assistant_candidate-data
mkdir -p "$T/fakeset4"
for k in db:dump documents:tar resumes:tar candidates:tar; do echo x >"$T/fakeset4/eve-${k%%:*}-20261023T010000Z.${k#*:}.age"; done
mkdir -p "$T/c4d" "$T/c4r"
rm -f "$T/docker.calls"
out="$(env -i PATH="$FAKE:$PATH" HOME="$TEST_HOME" bash "$SCRIPTS/restore.sh" --env-file /dev/null --identity "$KEY" --set 20261023T010000Z --backup-dir "$T/fakeset4" --no-verify-log --target-project scratch --documents-dir "$T/c4d" --resumes-dir "$T/c4r" 2>&1)"
check "A2: restore of a set with a candidates archive refuses without a candidates target (no docker call)" bash -c '[[ $1 == *"reason=no-candidates-target"* && ! -e $2 ]]' _ "$out" "$T/docker.calls"
out="$(env -i PATH="$FAKE:$PATH" HOME="$TEST_HOME" bash "$SCRIPTS/restore.sh" --env-file /dev/null --identity "$KEY" --target-project scratch --set 20261023T010000Z --backup-dir "$T/fakeset4" --no-verify-log --documents-dir "$T/c4d" --resumes-dir "$T/c4r" --candidates-volume scratch_c --candidates-dir "$T/c4d" 2>&1)"
check "A2: restore refuses two candidates targets" test "$out" != "${out/reason=two-candidates-targets/}"
out="$(env -i PATH="$FAKE:$PATH" HOME="$TEST_HOME" bash "$SCRIPTS/restore.sh" --env-file /dev/null --identity "$KEY" --target-project scratch --set 20261023T010000Z --backup-dir "$T/fakeset4" --no-verify-log --documents-volume scratch_d --resumes-volume scratch_r --candidates-volume scratch_d 2>&1)"
check "A2: restore refuses the same volume for candidates and documents" test "$out" != "${out/reason=same-volume-twice/}"
printf 'BACKUP_CANDIDATE_VOLUME=live_cand\n' >"$T/livecand.env"
check "A2: restore refuses the configured BACKUP_CANDIDATE_VOLUME" live_refusal --env-file "$T/livecand.env" --target-project scratch --documents-volume scratch_d --resumes-volume scratch_r --candidates-volume live_cand
out="$(env -i PATH="$FAKE:$PATH" HOME="$TEST_HOME" bash "$SCRIPTS/restore.sh" --target-project scratch --set 20261023T010000Z --backup-dir "$T/fakeset" --documents-dir "$T" --resumes-dir "$T" 2>&1)"
check "restore refuses without an identity file" test "$out" != "${out/reason=no-identity/}"
mkdir -p "$T/notempty" && echo x >"$T/notempty/f"
out="$(env -i PATH="$FAKE:$PATH" HOME="$TEST_HOME" bash "$SCRIPTS/restore.sh" --identity "$KEY" --target-project scratch --set 20261023T010000Z --backup-dir "$T/fakeset" --no-verify-log --documents-dir "$T/notempty" --resumes-volume scratch_r 2>&1)"
check "restore refuses a non-empty target directory" test "$out" != "${out/reason=target-dir-not-empty/}"
out="$(env -i PATH="$FAKE:$PATH" HOME="$TEST_HOME" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --project eve --backup-dir "$T/fakeset" --set 20261023T010000Z 2>&1)"
check "restore drill refuses the eve project name" test "$out" != "${out/reason=live-project/}"
check "refusal outputs never contain the identity contents" bash -c '! grep -rq AGE-SECRET-KEY "$1"/refuse-*.out' _ "$T"

# ------------------------------------------------ repair wave 1 (unit, red first)
echo "# unit: repair wave 1"
# F-QA-B-01: inline comments and trailing spaces in .env.
cat >"$T/inline.env" <<EOF
BACKUP_AGE_RECIPIENT=$RECIPIENT      # the public key only
BACKUP_DIR=                       # empty means ~/eve-backups
POSTGRES_DB=job_assistant   
DB_OWNER_PASSWORD=pa#ss word#x
DB_OWNER_ROLE="ja owner # quoted"   # trailing comment after quotes
BACKUP_RESUME_VOLUME=  vol_r	
EOF
parsed="$(env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash -c '. "$1"; eve_load_env "$2"; printf "[%s][%s][%s][%s][%s][%s]" "$BACKUP_AGE_RECIPIENT" "$BACKUP_DIR" "$POSTGRES_DB" "$DB_OWNER_PASSWORD" "$DB_OWNER_ROLE" "$BACKUP_RESUME_VOLUME"' _ "$SCRIPTS/lib.sh" "$T/inline.env")"
check "env parser strips unquoted ' # comment' and surrounding spaces/tabs, keeps '#' inside a value and inside quotes" \
  test "$parsed" = "[$RECIPIENT][][job_assistant][pa#ss word#x][ja owner # quoted][vol_r]"
# The exact Install snippet from the docs must give a run that passes config (fake docker stops it at the db step).
snippet="$(awk '/^## Install/{i=1} i && /^   ```sh$/{c++; next} i && c==2 && /^   ```$/{exit} i && c==2 {sub(/^   /,""); print}' "$SCRIPTS/../../docs/ops/backups.md")"
check "the docs' Install .env snippet has no inline comments" bash -c '[[ -n $1 ]] && ! printf "%s\n" "$1" | grep -E "^[A-Z_]+=.*[[:space:]]#"' _ "$snippet"
{ printf '%s\n' "$snippet" | sed "s|^BACKUP_AGE_RECIPIENT=.*|BACKUP_AGE_RECIPIENT=$RECIPIENT|"; echo POSTGRES_DB=job_assistant; echo DB_OWNER_ROLE=ja_owner; } >"$T/snippet.env"
check "the docs' Install snippet sets DB_BACKUP_ROLE and DB_BACKUP_PASSWORD" bash -c 'grep -q "^DB_BACKUP_ROLE=" "$1" && grep -q "^DB_BACKUP_PASSWORD=" "$1"' _ "$T/snippet.env"
sed -i.bak "s|^DB_BACKUP_ROLE=.*|DB_BACKUP_ROLE=ja_backup|;s|^DB_BACKUP_PASSWORD=.*|DB_BACKUP_PASSWORD=$MARK_BACKUP_PW|" "$T/snippet.env" && rm -f "$T/snippet.env.bak"
out="$(env -i PATH="$FAKE:$PATH" HOME="$T/snippet-home" bash "$SCRIPTS/backup.sh" --env-file "$T/snippet.env" 2>&1)"; rc=$?
check "a run configured from the docs snippet passes config (fails later at step=db with fake docker, not step=config)" bash -c '[[ $1 == 1 && $2 == *"step=db reason=no-postgres"* ]]' _ "$rc" "$out"
cp "$T/inline.env" "$T/inline2.env" && sed -i.bak '/^DB_OWNER_ROLE=/d;/^BACKUP_RESUME_VOLUME=/d' "$T/inline2.env" && printf 'DB_OWNER_ROLE=ja_owner\nDB_BACKUP_ROLE=ja_backup   # inline comment\nDB_BACKUP_PASSWORD="%s"\n' "$MARK_BACKUP_PW" >>"$T/inline2.env"
out="$(env -i PATH="$FAKE:$PATH" HOME="$T/inline-home" bash "$SCRIPTS/backup.sh" --env-file "$T/inline2.env" 2>&1)"; rc=$?
check "a run whose .env has inline comments and trailing spaces passes config (step=db)" bash -c '[[ $1 == 1 && $2 == *"step=db reason=no-postgres"* ]]' _ "$rc" "$out"

# SEC-B-04 / F-QA-B-04: live names by pattern (case-insensitive) and configured names.
live_ok=1
for n in eve EVE Eve eve-prod eve_ eve2 evening-x job-assistant job_assistant JOB-ASSISTANT Job_Assistant_x job-assistant_document-data eve_documents; do
  eve_is_live_name "$n" || { live_ok=0; echo "# not live: $n"; }
done
for n in scratch ja-ops-backup-test steve my-eve ja_assistant jobassistant job.assistant; do
  eve_is_live_name "$n" && { live_ok=0; echo "# wrongly live: $n"; }
done
check "eve_is_live_name: any eve* / job[-_]assistant* name in any case is live; others are not" test "$live_ok" = 1
check "restore refuses project eve-prod" live_refusal --target-project eve-prod --documents-dir "$T" --resumes-dir "$T"
check "restore refuses project job_assistant" live_refusal --target-project job_assistant --documents-dir "$T" --resumes-dir "$T"
check "restore refuses upper-case volume EVE_Documents" live_refusal --target-project scratch --documents-volume EVE_Documents --resumes-volume scratch_r
check "restore refuses volume Job_Assistant_x" live_refusal --target-project scratch --documents-volume scratch_d --resumes-volume Job_Assistant_x
printf 'BACKUP_COMPOSE_PROJECT=ja-live\nBACKUP_DOCUMENT_VOLUME=live_docs\nBACKUP_RESUME_VOLUME=live_res\n' >"$T/live.env"
check "restore refuses the configured BACKUP_COMPOSE_PROJECT (ja-live from --env-file)" live_refusal --env-file "$T/live.env" --target-project ja-live --documents-dir "$T" --resumes-dir "$T"
check "restore refuses the configured BACKUP_DOCUMENT_VOLUME" live_refusal --env-file "$T/live.env" --target-project scratch --documents-volume live_docs --resumes-volume scratch_r
check "restore refuses the configured BACKUP_RESUME_VOLUME" live_refusal --env-file "$T/live.env" --target-project scratch --documents-volume scratch_d --resumes-volume live_res
drill_refusal() { rm -f "$T/docker.calls"; local out rc; out="$(env -i PATH="$FAKE:$PATH" HOME="$TEST_HOME" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$T/fakeset" --set 20261023T010000Z "$@" 2>&1)"; rc=$?; [[ $rc == 2 && $out == *"reason=live-project"* && ! -e $T/docker.calls ]]; }
check "drill refuses project job_assistant (no docker call)" drill_refusal --project job_assistant --env-file /dev/null
check "drill refuses project eve-prod (no docker call)" drill_refusal --project eve-prod --env-file /dev/null
check "drill refuses the configured BACKUP_COMPOSE_PROJECT" drill_refusal --project ja-live --env-file "$T/live.env"

# F-QA-B-03: restore reads BACKUP_DIR from .env.
printf 'BACKUP_DIR=%s\n' "$T/fakeset" >"$T/restore-dir.env"
mkdir -p "$T/rd0" "$T/rr0"
rm -f "$T/docker.calls"
out="$(env -i PATH="$FAKE:$PATH" HOME="$TEST_HOME" bash "$SCRIPTS/restore.sh" --env-file "$T/restore-dir.env" --identity "$KEY" --set 20261023T010000Z --no-verify-log --target-project scratch --documents-dir "$T/rd0" --resumes-dir "$T/rr0" 2>&1)"
check "restore finds the set in BACKUP_DIR from --env-file (no backup-file-missing; reaches docker)" bash -c '[[ $1 != *backup-file-missing* && $1 == *"step=db reason=no-postgres"* ]]' _ "$out"

# SEC-B-05: lock semantics (portable link lock), checked without docker.
lockcase() { # lockcase NAME SETUP EXPECTED_RC
  local d="$T/lock-$1"; mkdir -p "$d"; chmod 700 "$d"; : >"$d/backup.log"; chmod 600 "$d/backup.log"
  eval "$2"
  env_file "$T/lock.env" "$RECIPIENT" "$d"
  env -i PATH="$FAKE:$PATH" HOME="$TEST_HOME" bash "$SCRIPTS/backup.sh" --env-file "$T/lock.env" >"$T/lock-$1.out" 2>&1
  [[ $? == "$3" ]]
}
sleep 300 & SLEEPER=$!
check "r1 lock file format: a lock held by a live backup.sh process refuses the run (exit 3)" lockcase live 'bash -c "exec -a backup.sh sleep 30" & echo $! >"$d/.backup.lock"; sleep 0.2' 3
check "a lock whose pid is a live process that is not backup.sh is taken over (pid reuse)" lockcase reuse 'echo $SLEEPER >"$d/.backup.lock"' 1
check "a lock whose pid is dead is taken over" lockcase dead 'echo 999999 >"$d/.backup.lock"' 1
check "an empty lock file younger than 10 minutes counts as busy (exit 3)" lockcase emptyfresh ': >"$d/.backup.lock"' 3
check "an empty lock file older than 10 minutes is taken over" lockcase emptyold ': >"$d/.backup.lock"; touch -t 202001010000 "$d/.backup.lock"' 1
check "a legacy lock directory with a dead pid is taken over" lockcase legacy 'mkdir "$d/.backup.lock"; echo 999999 >"$d/.backup.lock/pid"' 1
check "a takeover leaves no lock behind after the run ends" bash -c '! ls -A "$1"/lock-dead "$1"/lock-reuse | grep -q "backup.lock"' _ "$T"
kill "$SLEEPER" 2>/dev/null; wait "$SLEEPER" 2>/dev/null
pkill -f "exec -a backup.sh sleep 30" 2>/dev/null || true

# ------------------------------------------------ repair wave 2 (unit, red first)
echo "# unit: repair wave 2"
# F-QA-B2-01: the lock must work without hard links. Throwaway ExFAT and FAT32
# disk images (macOS hdiutil; skipped elsewhere), fake docker, throwaway key.
FD="$T/fakedock"; mkdir -p "$FD"; cp "$TEST_DIR/fakedocker.sh" "$FD/docker"; chmod 755 "$FD/docker"
MNTS=()
detach_all() { local m; for m in ${MNTS[@]+"${MNTS[@]}"}; do hdiutil detach "$m" -force >/dev/null 2>&1; done; MNTS=(); }
fsrun() { # fsrun MOUNT TAG: runs backup.sh with BACKUP_DIR on MOUNT, prints rc
  printf '%s\n' "BACKUP_AGE_RECIPIENT=$RECIPIENT" "BACKUP_DIR=$1/eve-backups" POSTGRES_DB=x DB_OWNER_ROLE=y DB_BACKUP_ROLE=z DB_BACKUP_PASSWORD=fake-backup-password-0 \
    BACKUP_COMPOSE_PROJECT=${PROJECT}-fake BACKUP_DOCUMENT_VOLUME=${PROJECT}-fake_docs BACKUP_RESUME_VOLUME=${PROJECT}-fake_res BACKUP_CANDIDATE_VOLUME=${PROJECT}-fake_cand >"$T/fs.env"
  env -i PATH="$FD:$PATH" HOME="$T" FAKE_DB="${FAKE_DB:-ok}" bash "$SCRIPTS/backup.sh" --env-file "$T/fs.env" >"$T/fs-$2.out" 2>&1
  echo $?
}
if command -v hdiutil >/dev/null 2>&1; then
  for fs in ExFAT MS-DOS; do
    img="$T/$fs.dmg" m="$T/mnt-$fs"
    if ! hdiutil create -quiet -size 32m -fs "$fs" -volname JAOPS "$img" || ! mkdir -p "$m" || ! hdiutil attach -quiet -nobrowse -mountpoint "$m" "$img"; then
      not_ok "$fs image could be created and mounted"; continue
    fi
    MNTS+=("$m")
    touch "$m/a"; ln "$m/a" "$m/b" 2>/dev/null && hl=yes || hl=no; rm -f "$m/a" "$m/b"
    check "$fs image has no hard links (the case under test)" test "$hl" = no
    rc1="$(fsrun "$m" "$fs-1")"; rc2="$(fsrun "$m" "$fs-2")"
    check "F-QA-B2-01: on $fs two runs in a row both exit 0 and write a set each (4 files: the fake docker reports a candidates volume)" \
      bash -c '[[ $1 == 0 && $2 == 0 ]] && [[ $(ls "$3" | grep -c "\.age$") == 8 ]]' _ "$rc1" "$rc2" "$m/eve-backups"
    check "F-QA-B2-01: on $fs no lock or takeover dir is left behind" bash -c '! ls -A "$1" | grep -q "^\.backup\.lock"' _ "$m/eve-backups"
    mkdir "$m/eve-backups/.backup.lock" && echo 999999 >"$m/eve-backups/.backup.lock/pid"
    check "F-QA-B2-01: on $fs a stale lock (dead pid) is taken over (exit 0)" test "$(fsrun "$m" "$fs-stale")" = 0
    bash -c 'exec -a backup.sh sleep 30' & H=$!
    sleep 0.2
    mkdir "$m/eve-backups/.backup.lock" && echo "$H" >"$m/eve-backups/.backup.lock/pid"
    check "F-QA-B2-01: on $fs a lock held by a live backup.sh refuses (exit 3, reason=busy)" \
      bash -c '[[ $1 == 3 ]] && grep -q "step=lock reason=busy" "$2"' _ "$(fsrun "$m" "$fs-live")" "$T/fs-$fs-live.out"
    kill "$H" 2>/dev/null; wait "$H" 2>/dev/null
    rm -rf "$m/eve-backups/.backup.lock"
  done
  detach_all
else
  # Linux: no hdiutil; FAT/ExFAT need a loop mount (root). Reported as TAP skips.
  for fs in ExFAT MS-DOS; do ok "F-QA-B2-01: $fs lock cases (5) # SKIP hdiutil not available on $(uname -s)"; done
fi

# F-QA-B2-03: the documented parse rules, including the two cases where compose differs.
rules="$(bash -c '. "$1"; for v in "   # note" "x	# tab comment" "pa#ss" "\"a # b\" # c" "'"'"'q'"'"' tail" " v  "; do printf "[%s]" "$(eve_env_value "$v")"; done' _ "$SCRIPTS/lib.sh")"
check "F-QA-B2-03: comment-only value is empty, tab+# ends the value, inner # kept, quotes kept exactly, spaces trimmed" test "$rules" = "[][x][pa#ss][a # b][q][v]"
check "F-QA-B2-03: the docs state those rules and no longer claim to parse exactly like compose" \
  bash -c 'grep -q "A value that is only a comment" "$1" && grep -q "reads the same file a little differently" "$1" && ! grep -q "as \`docker compose\` does" "$1"' _ "$SCRIPTS/../../docs/ops/backups.md"
check "F-QA-B2-02: the docs say a killed run's partials are removed by the next successful run only" \
  bash -c 'grep -q "stay until the next \*\*successful\*\* run" "$1" && ! grep -q "its leftover \`\*.partial\` files, and its helper" "$1"' _ "$SCRIPTS/../../docs/ops/backups.md"

# SEC-B-05 with the directory lock (r2 format), on the local filesystem.
check "a lock directory held by a live backup.sh refuses (exit 3)" lockcase dlive 'bash -c "exec -a backup.sh sleep 30" & mkdir "$d/.backup.lock"; echo $! >"$d/.backup.lock/pid"; sleep 0.2' 3
check "a lock directory without a pid, younger than 10 minutes, is busy (a run is starting)" lockcase dempty 'mkdir "$d/.backup.lock"' 3
check "a lock directory without a pid, older than 10 minutes, is taken over" lockcase dold 'mkdir "$d/.backup.lock"; touch -t 202001010000 "$d/.backup.lock"' 1
check "a run that finds another run's takeover in progress refuses (exit 3) and leaves both dirs" \
  lockcase takeover 'mkdir "$d/.backup.lock" "$d/.backup.lock.takeover"; echo 999999 >"$d/.backup.lock/pid"' 3
check "... and the in-progress takeover dir and the stale lock are untouched" test -d "$T/lock-takeover/.backup.lock.takeover" -a -d "$T/lock-takeover/.backup.lock"
check "a takeover dir left over 10 minutes ago is cleared, and that run still refuses" \
  lockcase takeoverold 'mkdir "$d/.backup.lock" "$d/.backup.lock.takeover"; echo 999999 >"$d/.backup.lock/pid"; touch -t 202001010000 "$d/.backup.lock.takeover"' 3
check "... so the next run takes over the stale lock" bash -c '[[ ! -e "$1/.backup.lock.takeover" ]]' _ "$T/lock-takeoverold"
# Race: 8 runs start at once against one stale lock; exactly one may win (the others exit 3).
RD="$T/race"; mkdir -p "$RD"; chmod 700 "$RD"; mkdir "$RD/.backup.lock"; echo 999999 >"$RD/.backup.lock/pid"
env_file "$T/race.env" "$RECIPIENT" "$RD"
for i in 1 2 3 4 5 6 7 8; do
  ( env -i PATH="$FD:$PATH" HOME="$TEST_HOME" FAKE_DB=slow bash "$SCRIPTS/backup.sh" --env-file "$T/race.env" >"$T/race-$i.out" 2>&1; echo $? >"$T/race-$i.rc" ) &
done
wait
wins="$(cat "$T"/race-*.rc | grep -c '^0$')"; busy="$(cat "$T"/race-*.rc | grep -c '^3$')"
check "SEC-B-05: 8 simultaneous runs over a stale lock: exactly 1 succeeds, 7 refuse busy" test "$wins $busy" = "1 7"
check "SEC-B-05: the race leaves no lock or takeover dir" bash -c '! ls -A "$1" | grep -q "^\.backup\.lock"' _ "$RD"

# F-CR-09: --help prints the whole header comment, including Usage and Exit, for each script.
for s in backup.sh restore.sh restore-drill.sh; do
  help="$(bash "$SCRIPTS/$s" --help 2>&1)"; rc=$?
  check "F-CR-09: $s --help exits 0 and shows Usage and Exit" bash -c '[[ $1 == 0 && $2 == *"# Usage:"* && $2 == *"# Exit:"* ]]' _ "$rc" "$help"
  check "F-CR-09: $s --help stops at the end of the header comment" bash -c '[[ $1 != *"set -Eeuo pipefail"* && $(printf "%s\n" "$1" | grep -vc "^#") == 0 ]]' _ "$help"
done
# Stub `docker compose -p NAME ... config --format json`: Compose's pretty JSON with the
# drill's resolved volume and network names (F-SEC-19). Inserted into the drill stubs.
cat >"$T/stubcfg.sh" <<'CFG'
printf '{\n  "name": "%s",\n  "networks": {\n    "drill": {\n      "name": "%s_drill"\n    }\n  },\n  "volumes": {\n    "pgdata": {\n      "name": "%s_pgdata"\n    }\n  }\n}\n' "$1" "$1" "$1"
CFG
add_cfg_stub() { # add_cfg_stub STUB: answers compose config from stubcfg.sh before anything else
  local tmp="$1.tmp"
  { head -n 1 "$1"; printf '[[ "$1 $2" == "compose -p" && "$*" == *" config --format json"* ]] && exec bash "%s" "$3"\n' "$T/stubcfg.sh"; tail -n +2 "$1"; } >"$tmp" && mv "$tmp" "$1" && chmod +x "$1"
}
# Stub state (F-QA-22): once the drill has removed things (`volume rm` in the call log),
# `ps -aq`, `volume ls` and `network ls` report nothing, as real Docker would, so the
# teardown's leftover check passes. Inserted after the config answer.
add_removed_stub() { # add_removed_stub STUB
  local tmp="$1.tmp"
  { head -n 2 "$1"; printf '%s\n' 'case "$*" in "ps -aq"* | "volume ls"* | "network ls"*) grep -qE "^(volume rm|rm -fv)" "$STUB_LOG" 2>/dev/null && { echo "$*" >>"$STUB_LOG"; exit 0; } ;; esac'; tail -n +3 "$1"; } >"$tmp" && mv "$tmp" "$1" && chmod +x "$1"
}
# F-CR-06: the drill exits 1 with no exit=N line when its database does not start, and the docs say so.
FD6="$T/fakedocker-up-fails"; mkdir -p "$FD6" "$T/drill6"
printf '#!/usr/bin/env bash\ncase "$*" in "volume inspect"* | *" up -d --wait"*) exit 1 ;; esac\nexit 0\n' >"$FD6/docker"; chmod +x "$FD6/docker"; add_cfg_stub "$FD6/docker"
out="$(env -i PATH="$FD6:$PATH" HOME="$TEST_HOME" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$T/drill6" --set 20261023T010000Z --project ja-ops-drill-f6 --env-file /dev/null 2>&1)"; rc=$?
check "F-CR-06: a drill whose database does not start exits 1, ends with step=start reason=compose-up and prints no exit= line" \
  bash -c '[[ $1 == 1 && $(printf "%s\n" "$2" | tail -n 1) == *"status=failed step=start reason=compose-up" && $2 != *"exit="* ]]' _ "$rc" "$out"
check "F-CR-06: backups.md says no exit=N line follows a start failure" grep -q "no \`exit=N\` line follows" "$SCRIPTS/../../docs/ops/backups.md"

# F-QA-19: teardown never removes anything unless the ownership check finished and
# found the project to be the drill's. A stub docker logs every call; modes:
#   psfail (docker ps fails), inspectfail, volfail (docker volume ls fails),
#   foreign (a container without the drill label), clean (all labelled; compose up then fails).
FD19="$T/fakedocker-f19"; mkdir -p "$FD19" "$T/drill19"
cat >"$FD19/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
case "$STUB_MODE:$*" in
  psfail:ps\ *) exit 1 ;;
  inspectfail:ps\ *) echo c0000001 ;;
  inspectfail:inspect\ *) exit 1 ;;
  volfail:volume\ ls*) exit 1 ;;
  foreign:ps\ *) echo c0000002 ;;
  foreign:inspect\ *) echo ;;
  clean:ps\ *) echo c0000003 ;;
  clean:inspect\ *) echo 1 ;;
  clean:volume\ ls*) printf '%s\n' ja-a2f-drill19_documents ja-a2f-drill19_resumes ja-a2f-drill19_candidates ;;
  clean:volume\ inspect\ -f*) echo 1 ;;
  *:volume\ inspect*) exit 1 ;;
  *"up -d --wait"*) exit 1 ;;
esac
exit 0
STUB
chmod +x "$FD19/docker"; add_cfg_stub "$FD19/docker"; add_removed_stub "$FD19/docker"
drill19() { # drill19 MODE [--keep]; sets out, rc, calls
  : >"$T/f19.calls"
  out="$(env -i PATH="$FD19:$PATH" HOME="$TEST_HOME" STUB_MODE="$1" STUB_LOG="$T/f19.calls" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$T/drill19" --set 20261023T010000Z --project ja-a2f-drill19 --env-file /dev/null "${@:2}" 2>&1)"; rc=$?
  calls="$(cat "$T/f19.calls")"
}
removes() { [[ $1 == *"down --volumes"* || $1 == *"volume rm"* ]]; }
for keep in "" --keep; do
  for mode in psfail inspectfail volfail; do
    drill19 "$mode" $keep
    check "F-QA-19: $mode during the ownership check ${keep:-(no --keep)}: refuses docker-unavailable, exit 2, removes nothing, no kept line" \
      bash -c '[[ $1 == 2 && $(printf "%s\n" "$2" | tail -n 1) == *"status=refused reason=docker-unavailable" && $2 != *"kept project"* && $2 != *"step=start"* ]] && ! { [[ $3 == *"down --volumes"* || $3 == *"volume rm"* ]]; }' _ "$rc" "$out" "$calls"
  done
  drill19 foreign $keep
  check "F-QA-19: a foreign container ${keep:-(no --keep)}: refuses foreign-project (last line), exit 2, removes nothing, no kept line" \
    bash -c '[[ $1 == 2 && $(printf "%s\n" "$2" | tail -n 1) == *"status=refused reason=foreign-project" && $2 != *"kept project"* && $2 != *"step=start"* ]] && ! { [[ $3 == *"down --volumes"* || $3 == *"volume rm"* ]]; }' _ "$rc" "$out" "$calls"
done
drill19 clean
check "F-QA-19: a clean drill project whose start fails is torn down (down --volumes and all three volumes after up), exit 1" \
  bash -c '[[ $1 == 1 && $(printf "%s\n" "$2" | tail -n 1) == *"status=failed step=start reason=compose-up" ]] && printf "%s\n" "$3" | sed -n "/up -d --wait/,\$p" | grep -q "down --volumes" && printf "%s\n" "$3" | sed -n "/up -d --wait/,\$p" | grep -q "volume rm -f ja-a2f-drill19_documents ja-a2f-drill19_resumes ja-a2f-drill19_candidates"' _ "$rc" "$out" "$calls"
drill19 clean --keep
check "F-QA-19: a clean drill project with --keep: exit 1, last line kept project=, nothing removed after up" \
  bash -c '[[ $1 == 1 && $(printf "%s\n" "$2" | tail -n 1) == *"kept project=ja-a2f-drill19" ]] && ! printf "%s\n" "$3" | sed -n "/up -d --wait/,\$p" | grep -q -e "down --volumes" -e "volume rm"' _ "$rc" "$out" "$calls"

# F-SEC-18, F-SEC-19: the ownership check covers every volume and network the teardown
# can remove. The names come at runtime from `docker compose config --format json`
# (.volumes[].name, .networks[].name), so name overrides and the implicit _default
# network are covered; if that fails or yields no volume, the drill refuses.
check "F-SEC-18: drill.compose.yml labels pgdata and the drill network eve.backup.drill" \
  bash -c 'awk "/^volumes:/{s=1} /^networks:/{s=2} /^services:/{s=0} s && /eve.backup.drill: \"1\"/{n[s]++} END{exit !(n[1]>=1 && n[2]>=1)}" "$1"' _ "$SCRIPTS/drill.compose.yml"
check "F-SEC-19: the drill no longer parses drill.compose.yml itself" bash -c '! grep -q eve_compose_keys "$1/restore-drill.sh" "$1/lib.sh"' _ "$SCRIPTS"
if docker compose version >/dev/null 2>&1; then
  check "F-SEC-19: eve_compose_names reads pgdata and drill names from real docker compose config" \
    bash -c '. "$1"; [[ $(eve_compose_names ja-a2g-parse "$2" volumes) == ja-a2g-parse_pgdata && $(eve_compose_names ja-a2g-parse "$2" networks) == ja-a2g-parse_drill ]]' _ "$SCRIPTS/lib.sh" "$SCRIPTS/drill.compose.yml"
  mkdir -p "$T/cc19"
  printf 'services:\n  p:\n    image: x\n    volumes:\n      - vol:/d\nvolumes:  # comment\n  "vol":\n    name: custom-v-a2g\n' >"$T/cc19/c.yml"
  check "F-SEC-19: a name: override, a quoted key, a header comment and the implicit default network are read as Compose resolves them" \
    bash -c '. "$1"; [[ $(eve_compose_names ja-a2g-cc "$2" volumes) == custom-v-a2g && $(eve_compose_names ja-a2g-cc "$2" networks) == ja-a2g-cc_default ]]' _ "$SCRIPTS/lib.sh" "$T/cc19/c.yml"
else
  ok "F-SEC-19: eve_compose_names reads real docker compose config # SKIP no docker compose"
  ok "F-SEC-19: name override and default network # SKIP no docker compose"
fi
FD18="$T/fakedocker-f18"; mkdir -p "$FD18"
cat >"$FD18/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
P=ja-a2g-drill18
if [[ "$*" == *" config --format json"* ]]; then
  case "$STUB_MODE" in
    cfgfail) exit 1 ;;
    cfgempty) echo '{"name":"x","services":{}}'; exit 0 ;;
    cfgnovol) printf '{\n  "networks": {\n    "drill": {\n      "name": "%s_drill"\n    }\n  }\n}\n' "$P"; exit 0 ;;
    cfggarbage) echo 'not json'; exit 0 ;;
    extra) printf '{\n  "networks": {\n    "drill": {\n      "name": "%s_drill"\n    }\n  },\n  "volumes": {\n    "pgdata": {\n      "name": "%s_pgdata"\n    },\n    "extra": {\n      "name": "renamed-extra"\n    }\n  }\n}\n' "$P" "$P"; exit 0 ;;
    *) printf '{\n  "name": "%s",\n  "networks": {\n    "drill": {\n      "name": "%s_drill",\n      "labels": {\n        "eve.backup.drill": "1"\n      }\n    }\n  },\n  "services": {\n    "postgres": {\n      "volumes": [\n        {\n          "source": "pgdata"\n        }\n      ]\n    }\n  },\n  "volumes": {\n    "pgdata": {\n      "name": "%s_pgdata",\n      "labels": {\n        "eve.backup.drill": "1"\n      }\n    }\n  }\n}\n' "$P" "$P" "$P"; exit 0 ;;
  esac
fi
case "$STUB_MODE:$*" in
  pgforeign:volume\ ls*) echo "${P}_pgdata" ;;
  pgforeign:volume\ inspect\ -f*) echo ;;
  netforeign:network\ ls*) echo "${P}_drill" ;;
  netforeign:network\ inspect\ -f*) echo ;;
  netfail:network\ ls*) exit 1 ;;
  netinspectfail:network\ ls*) echo "${P}_drill" ;;
  netinspectfail:network\ inspect*) exit 1 ;;
  extra:volume\ ls*) echo renamed-extra ;;
  extra:volume\ inspect\ -f*) echo ;;
  ownleft:ps\ -aq*) echo c0000018 ;;
  ownleft:inspect\ *) echo 1 ;;
  ownleft:volume\ ls*) printf '%s\n' "${P}_documents" "${P}_resumes" "${P}_candidates" "${P}_pgdata" ;;
  ownleft:volume\ inspect\ -f*) echo 1 ;;
  ownleft:network\ ls*) printf '%s\n' bridge "${P}_drill" "${P}_drillx" ;;
  ownleft:network\ inspect\ -f*) echo 1 ;;
  *:volume\ inspect*) exit 1 ;;
  *"up -d --wait"*) exit 1 ;;
esac
exit 0
STUB
chmod +x "$FD18/docker"; add_removed_stub "$FD18/docker"
drill18() { # drill18 MODE [SCRIPTS_DIR] [--keep]; sets out, rc, calls
  : >"$T/f18.calls"
  out="$(env -i PATH="$FD18:$PATH" HOME="$TEST_HOME" STUB_MODE="$1" STUB_LOG="$T/f18.calls" bash "${2:-$SCRIPTS}/restore-drill.sh" --identity "$KEY" --backup-dir "$T/drill19" --set 20261023T010000Z --project ja-a2g-drill18 --env-file /dev/null "${@:3}" 2>&1)"; rc=$?
  calls="$(cat "$T/f18.calls")"
}
refused_nothing_removed() { # rc out calls reason
  [[ $1 == 2 && $(printf "%s\n" "$2" | tail -n 1) == *"status=refused reason=$4" && $2 != *"kept project"* && $2 != *"step=start"* && $3 != *"down --volumes"* && $3 != *"volume rm"* && $3 != *"network rm"* ]]
}
for keep in "" --keep; do
  drill18 pgforeign "" $keep
  check "F-SEC-18: an unlabelled \${PROJECT}_pgdata volume ${keep:-(no --keep)}: refuses foreign-project, exit 2, removes nothing" refused_nothing_removed "$rc" "$out" "$calls" foreign-project
  drill18 netforeign "" $keep
  check "F-SEC-18: an unlabelled \${PROJECT}_drill network ${keep:-(no --keep)}: refuses foreign-project, exit 2, removes nothing" refused_nothing_removed "$rc" "$out" "$calls" foreign-project
done
drill18 netfail
check "F-SEC-18: docker network ls fails: refuses docker-unavailable, removes nothing" refused_nothing_removed "$rc" "$out" "$calls" docker-unavailable
drill18 netinspectfail
check "F-SEC-18: docker network inspect fails: refuses docker-unavailable, removes nothing" refused_nothing_removed "$rc" "$out" "$calls" docker-unavailable
drill18 ownleft
check "F-SEC-18: the drill's own labelled leftovers (container, 4 volumes, network) are accepted: checked each, starts, tears down, exit 1 on up failure" \
  bash -c '[[ $1 == 1 && $2 == *"step=start project=ja-a2g-drill18"* && $(printf "%s\n" "$2" | tail -n 1) == *"reason=compose-up" ]] && for n in documents resumes candidates pgdata; do grep -q "^volume inspect -f .* ja-a2g-drill18_$n\$" <<<"$3" || exit 1; done && grep -q "^network inspect -f .* ja-a2g-drill18_drill\$" <<<"$3" && ! grep -q "network inspect -f .* ja-a2g-drill18_drillx" <<<"$3"' _ "$rc" "$out" "$calls"
drill18 absent
check "F-SEC-18: normal path, nothing exists: accepted without any inspect, starts and tears down" \
  bash -c '[[ $1 == 1 && $2 == *"step=start project=ja-a2g-drill18"* && $3 != *"inspect -f"* ]] && sed -n "/up -d --wait/,\$p" <<<"$3" | grep -q "down --volumes"' _ "$rc" "$out" "$calls"
for m in cfgfail cfgempty cfgnovol cfggarbage; do
  drill18 "$m"
  check "F-SEC-19: docker compose config $m: refuses compose-config, exit 2, removes nothing" refused_nothing_removed "$rc" "$out" "$calls" compose-config
done
drill18 cfgfail "" --keep
check "F-SEC-19: docker compose config fails with --keep: refuses compose-config, no kept line, removes nothing" refused_nothing_removed "$rc" "$out" "$calls" compose-config
if docker compose version >/dev/null 2>&1; then
mkdir -p "$T/scripts19"; cp "$SCRIPTS"/*.sh "$T/scripts19/"
: >"$T/f18.calls"
out="$(env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$T/scripts19/restore-drill.sh" --identity "$KEY" --backup-dir "$T/drill19" --set 20261023T010000Z --project ja-a2g-nofile --env-file /dev/null 2>&1)"; rc=$?
check "F-SEC-19: drill.compose.yml missing (real docker compose): refuses compose-config, exit 2, prints no step=start" \
  bash -c '[[ $1 == 2 && $(printf "%s\n" "$2" | tail -n 1) == *"status=refused reason=compose-config" && $2 != *"step=start"* ]]' _ "$rc" "$out"
else
  ok "F-SEC-19: drill.compose.yml missing # SKIP no docker compose"
fi
# A volume Compose resolves under another name (name: override) is checked by that name.
drill18 extra
check "F-SEC-19: a compose volume with a name: override is checked under its real name (unlabelled one refused)" refused_nothing_removed "$rc" "$out" "$calls" foreign-project

# F-QA-20: a plain kill of the drill's PID stops the running step at once. The stub
# blocks in restore.sh's first docker exec; TERM must end it and its children, tear
# down, exit 143, and not let the restore finish.
FD20="$T/fakedocker-f20"; mkdir -p "$FD20" "$T/drill20"
for k in db:dump documents:tar resumes:tar; do echo x >"$T/drill20/eve-${k%%:*}-20261023T010000Z.${k#*:}.age"; done
echo "2026-10-23T01:00:00Z eve-backup status=ok set=20261023T010000Z documents_files=0 resumes_files=0 tables=1 rows=1 counts=0123456789abcdef db_bytes=1 " >"$T/drill20/backup.log"
cat >"$FD20/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
case "$*" in
  "ps -aq"*) exit 0 ;;
  ps\ *) echo fakepg0020 ;;
  "volume ls"* | "network ls"*) exit 0 ;;
  "volume inspect"*) exit 1 ;;
  exec*"select 1"*) exit 0 ;;
  exec*) echo "$$" >"$STUB_LOG.blocked"; sleep 20; echo "exec-finished" >>"$STUB_LOG"; exit 0 ;;
esac
exit 0
STUB
chmod +x "$FD20/docker"; add_cfg_stub "$FD20/docker"
: >"$T/f20.calls"; rm -f "$T/f20.calls.blocked"
env -i PATH="$FD20:$PATH" HOME="$TEST_HOME" STUB_LOG="$T/f20.calls" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$T/drill20" --set 20261023T010000Z --project ja-a2g-drill20 --env-file /dev/null >"$T/f20.out" 2>&1 &
spid=$!
for _ in $(seq 200); do [[ -s "$T/f20.calls.blocked" ]] && break; sleep 0.05; done
t0=$SECONDS; kill -TERM "$spid"; wait "$spid"; rc=$?; dt=$((SECONDS - t0))
sleep 0.5
bpid="$(cat "$T/f20.calls.blocked" 2>/dev/null)"
check "F-QA-20: kill PID during the restore step exits 143 (no hang: within 30 s), kills the running step, tears down, and the restore never finishes" \
  bash -c '[[ $1 == 143 && $2 -le 30 && -n $5 ]] && ! kill -0 "$5" 2>/dev/null && ! grep -q exec-finished "$3" && sed -n "/^exec/,\$p" "$3" | grep -q "down --volumes" && ! grep -q "eve-restore status=ok" "$4" && ! grep -q "eve-drill status=" "$4"' _ "$rc" "$dt" "$T/f20.calls" "$T/f20.out" "$bpid"

# F-SEC-21: every terminating signal (HUP, INT, TERM, QUIT) stops the running step,
# waits for it, then tears down (or keeps), with exit 128+signal. A plain kill reaches
# only the drill. A background job of this non-interactive suite starts with INT and
# QUIT ignored (and bash cannot trap a signal ignored on entry), so the drill is
# started through perl, which restores their default disposition first, as at a
# terminal.
sig_during_restore() { # SIG [--keep]: runs the FD20 drill, sends SIG while restore.sh blocks; sets rc dt bpid
  : >"$T/f20.calls"; rm -f "$T/f20.calls.blocked"
  env -i PATH="$FD20:$PATH" HOME="$TEST_HOME" STUB_LOG="$T/f20.calls" perl -e '$SIG{INT} = $SIG{QUIT} = "DEFAULT"; exec @ARGV' bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$T/drill20" --set 20261023T010000Z --project ja-a2g-drill20 --env-file /dev/null "${@:2}" >"$T/f20.out" 2>&1 &
  spid=$!
  for _ in $(seq 200); do [[ -s "$T/f20.calls.blocked" ]] && break; sleep 0.05; done
  t0=$SECONDS; kill -"$1" "$spid"; wait "$spid"; rc=$?; dt=$((SECONDS - t0))
  sleep 0.5
  bpid="$(cat "$T/f20.calls.blocked" 2>/dev/null)"
  return 0
}
reap_stub() { [[ -n ${bpid:-} ]] && kill "$bpid" 2>/dev/null; return 0; } # after the check: no stray stub
# F-QA-27: no idle-host wall-time bound. The step must be stopped (gone, never
# finished) and teardown must follow; time only guards against a hang (the drill's own
# bound is 10 s; 30 s allows for heavy load). On failure, print why.
stopped_and_torn_down() { # rc want dt bpid calls out
  local why=""
  [[ $1 == "$2" ]] || why="$why rc=$1(want $2)"
  [[ $3 -le 30 ]] || why="$why dt=$3"
  [[ -n $4 ]] || why="$why no-step-pid"
  [[ -n $4 ]] && kill -0 "$4" 2>/dev/null && why="$why step-alive"
  grep -q exec-finished "$5" && why="$why step-finished"
  sed -n "/^exec/,\$p" "$5" | grep -q "down --volumes" || why="$why no-teardown"
  grep -q "eve-drill status=" "$6" && why="$why result-line"
  [[ -z $why ]] || { echo "# stopped_and_torn_down:$why" >&2; return 1; }
}
for sc in HUP:129 INT:130 QUIT:131 TERM:143; do
  sig_during_restore "${sc%:*}"
  check "F-SEC-21: SIG${sc%:*} during the restore step stops the step, tears down and exits ${sc#*:}" \
    stopped_and_torn_down "$rc" "${sc#*:}" "$dt" "$bpid" "$T/f20.calls" "$T/f20.out"
  reap_stub
done
sig_during_restore HUP --keep
check "F-SEC-21: SIGHUP with --keep stops the step, removes nothing after it, exits 129, last line kept project=" \
  bash -c '[[ $1 == 129 && -n $2 ]] && ! kill -0 "$2" 2>/dev/null && ! grep -q exec-finished "$3" && ! sed -n "/^exec/,\$p" "$3" | grep -q -e "down --volumes" -e "volume rm" && [[ $(tail -n 1 "$4") == *"kept project=ja-a2g-drill20" ]]' _ "$rc" "$bpid" "$T/f20.calls" "$T/f20.out"
reap_stub
check "F-SEC-21: one handler: the drill traps HUP, INT, QUIT and TERM with codes 129, 130, 131, 143" \
  bash -c 'for p in "on_signal 129\x27 HUP" "on_signal 130\x27 INT" "on_signal 131\x27 QUIT" "on_signal 143\x27 TERM" "PENDING=129\x27 HUP" "PENDING=131\x27 QUIT"; do grep -qF "$(printf "$p")" "$1" || exit 1; done' _ "$SCRIPTS/restore-drill.sh"

# F-SEC-20: a signal that lands after the step is forked but before the drill records
# its PID must not orphan the step. That window cannot be hit from outside, so a copy
# of the drill sends itself TERM exactly there (inserted after `"$@" &` in run_step).
# The stub's `compose up` would run 20 s; the drill must stop it, tear down, exit 143.
FDR="$T/fakedocker-f20race"; mkdir -p "$FDR" "$T/scripts20"
cat >"$FDR/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
case "$*" in
  *" up -d --wait"*) echo "$$" >"$STUB_LOG.up"; sleep 20; echo up-finished >>"$STUB_LOG"; exit 0 ;;
  "volume inspect"*) exit 1 ;;
esac
exit 0
STUB
chmod +x "$FDR/docker"; add_cfg_stub "$FDR/docker"
for sc in TERM:143 HUP:129; do
cp "$SCRIPTS"/*.sh "$SCRIPTS/drill.compose.yml" "$T/scripts20/"
awk -v sig="${sc%:*}" '{ print } /^run_step\(\)/ { r = 1 } r && /^  "\$@" &$/ { print "  kill -" sig " $$; sleep 0.5"; r = 0 }' "$SCRIPTS/restore-drill.sh" >"$T/scripts20/restore-drill.sh"
check "F-SEC-20: the instrumented copy really signals itself (SIG${sc%:*}) between fork and CHILD=\$!" grep -q "^  kill -${sc%:*} \$\$; sleep 0.5$" "$T/scripts20/restore-drill.sh"
: >"$T/f20r.calls"; rm -f "$T/f20r.calls.up"
t0=$SECONDS
env -i PATH="$FDR:$PATH" HOME="$TEST_HOME" STUB_LOG="$T/f20r.calls" bash "$T/scripts20/restore-drill.sh" --identity "$KEY" --backup-dir "$T/drill19" --set 20261023T010000Z --project ja-a2g-race --env-file /dev/null >"$T/f20r.out" 2>&1; rc=$?
dt=$((SECONDS - t0)); sleep 0.5
upid="$(cat "$T/f20r.calls.up" 2>/dev/null)"
check "F-SEC-20/21: SIG${sc%:*} between starting the step and recording its PID stops the step (no orphan), tears down and exits ${sc#*:}" \
  bash -c '[[ $1 == $5 && $2 -le 30 && -n $3 ]] && ! kill -0 "$3" 2>/dev/null && ! grep -q up-finished "$4" && sed -n "/up -d --wait/,\$p" "$4" | grep -q "down --volumes"' _ "$rc" "$dt" "$upid" "$T/f20r.calls" "${sc#*:}"
[[ -n $upid ]] && kill "$upid" 2>/dev/null
done

# F-QA-22, F-SEC-22: restore.sh's file-volume helpers are not compose containers. A
# signal can leave one `created` (never ran, so --rm never fires) or still running,
# holding a drill volume. Teardown must remove every such container first, then the
# volumes, then check that nothing is left, and report a leftover instead of hiding it.
check "F-QA-22: every restore.sh helper is labelled eve.backup.restore-helper=1 and eve.backup.target-project, and runs under --init" \
  bash -c 'n=$(grep -c "docker run --rm" "$1"); [[ $n -ge 3 && $(grep "docker run --rm" "$1" | grep -cF -- "\"\${HELPER_LABELS[@]}\"") == "$n" ]] && grep -q "^HELPER_LABELS=(--init --label eve.backup.restore-helper=1 --label \"eve.backup.target-project=\$PROJECT\")" "$1"' _ "$SCRIPTS/restore.sh"
check "F-SEC-22: the unpack helper execs tar, so TERM reaches it directly" grep -q "exec tar -xf - -C /dst" "$SCRIPTS/restore.sh"
FDH="$T/fakedocker-helper"; mkdir -p "$FDH"
cat >"$FDH/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
P=ja-a2g-helper
started() { grep -q "up -d --wait" "$STUB_LOG"; }
helper_gone() { grep -q "^rm -f.* h0000001" "$STUB_LOG"; }
vol_gone() { [[ $STUB_MODE != volrmfail ]] && helper_gone && grep -q "^volume rm -f.* ${P}_documents" "$STUB_LOG"; }
case "$*" in
  "ps -aq --filter label=eve.backup.target-project=$P"*) started && ! helper_gone && echo h0000001; exit 0 ;;
  "ps -aq"*) exit 0 ;;
  "inspect -f"*Mounts*h0000001*) echo "${P}_documents anon0000001 other-named eve_fakeanon job-assistant_document-data prod-docs-vol "; exit 0 ;;
  "volume ls -q --filter label=com.docker.volume.anonymous"*) [[ $STUB_MODE == anonfail ]] && exit 1; printf '%s\n' anon0000001 anon-unrelated eve_fakeanon job-assistant_document-data prod-docs-vol; exit 0 ;;
  "rm -f"*) exit 0 ;;
  "volume ls"*) started && ! vol_gone && echo "${P}_documents"; [[ $STUB_MODE == anonleft ]] && started && echo anon0000001; exit 0 ;;
  "volume rm"*) vol_gone || exit 1; exit 0 ;;
  "network ls"*) exit 0 ;;
  "volume inspect -f"*) started && echo 1; started || exit 1; exit 0 ;;
  "volume inspect"*) exit 1 ;;
  *" up -d --wait"*) exit 1 ;;
esac
exit 0
STUB
chmod +x "$FDH/docker"; add_cfg_stub "$FDH/docker"
drillh() { # drillh MODE [--keep]; sets out rc calls
  : >"$T/fh.calls"
  out="$(env -i PATH="$FDH:$PATH" HOME="$TEST_HOME" STUB_MODE="$1" STUB_LOG="$T/fh.calls" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$T/drill19" --set 20261023T010000Z --project ja-a2g-helper --env-file /dev/null "${@:2}" 2>&1)"; rc=$?
  calls="$(cat "$T/fh.calls")"
}
for mode in created running; do
  drillh "$mode"
  check "F-QA-22: a $mode restore helper holding a drill volume is removed before the volumes; teardown leaves nothing and reports no leftover" \
    bash -c 'post=$(sed -n "/up -d --wait/,\$p" <<<"$3"); [[ $1 == 1 && $(tail -n 1 <<<"$2") == *"reason=compose-up" && $2 != *"step=teardown"* ]] && grep -n "^rm -f" <<<"$post" | grep -q h0000001 && (( $(grep -n "^rm -f" <<<"$post" | head -1 | cut -d: -f1) < $(grep -n "^volume rm" <<<"$post" | head -1 | cut -d: -f1) ))' _ "$rc" "$out" "$calls"
done
# F-QA-25: helpers are removed with -v, and an anonymous volume of a removed helper
# that still exists is a reported leftover (identified from the helper's mounts).
drillh created
check "F-QA-25: teardown removes restore helpers with -v (their anonymous volumes go too)" \
  bash -c 'sed -n "/up -d --wait/,\$p" <<<"$1" | grep -E "^rm " | grep -q -- "-fv.*h0000001\|-v.*h0000001"' _ "$calls"
drillh anonleft
check "F-QA-25: an anonymous volume of a removed helper that is still there is reported as a leftover" \
  bash -c '[[ $1 != 0 && $(tail -n 1 <<<"$2") == *"reason=leftover"*"volume:anon0000001"* && $(tail -n 1 <<<"$2") != *"ja-a2g-helper_documents"* ]]' _ "$rc" "$out"
check "F-QA-25: every restore.sh helper mounts a tmpfs over the image's VOLUME paths (no anonymous volume)" \
  bash -c 'n=$(grep -c "docker run --rm" "$1"); [[ $(grep "docker run --rm" "$1" | grep -cF -- "\"\${HELPER_TMPFS[@]}\"") == "$n" ]] && grep -q "eve_tmpfs_args \"\$HELPER_IMAGE\"" "$1" && grep -q "Config.Volumes" "$2"' _ "$SCRIPTS/restore.sh" "$SCRIPTS/lib.sh"
check "F-QA-25: backup.sh helpers mount the same tmpfs and its helper cleanup removes with -v" \
  bash -c 'grep -q "eve_tmpfs_args \"\$HELPER_IMAGE\"" "$1" && grep "docker run --rm -i" -A2 "$1" | grep -qF "\${HELPER_TMPFS[@]+" && grep -q "docker rm -fv \$ids" "$1"' _ "$SCRIPTS/backup.sh"
# F-SEC-27: only the drill's own volumes and anonymous volumes of its helpers are
# removed. A labelled container that mounts some other named volume must not make the
# drill (or --cleanup) delete that volume.
drillh created
check "F-SEC-27: teardown never removes a named volume the drill does not own (other-named), but does remove the helper's anonymous volume" \
  bash -c 'rmv=$(grep "^volume rm" <<<"$1"); ! grep -qw other-named <<<"$rmv" && grep -qw anon0000001 <<<"$rmv" && ! grep -qw anon-unrelated <<<"$rmv"' _ "$calls"
: >"$T/fc.calls"; echo "seed: up -d --wait" >"$T/fc.calls"
out="$(env -i PATH="$FDH:$PATH" HOME="$TEST_HOME" STUB_MODE=created STUB_LOG="$T/fc.calls" bash "$SCRIPTS/restore-drill.sh" --cleanup ja-a2g-helper --env-file /dev/null 2>&1)"; rc=$?
check "F-SEC-27: --cleanup never removes a named volume the drill does not own, but removes the helper's anonymous volume" \
  bash -c 'rmv=$(grep "^volume rm" "$1"); [[ $2 == 0 ]] && ! grep -qw other-named <<<"$rmv" && grep -qw anon0000001 <<<"$rmv"' _ "$T/fc.calls" "$rc"
# F-SEC-29: the anonymous label can be set by anyone with Docker access. A volume
# whose name matches the live-name guards is never removed, even when so labelled.
drillh created
check "F-SEC-29: teardown never removes a live-named volume even if it carries the anonymous label" \
  bash -c 'rmv=$(grep "^volume rm" <<<"$1"); ! grep -qw eve_fakeanon <<<"$rmv" && ! grep -qw job-assistant_document-data <<<"$rmv" && grep -qw anon0000001 <<<"$rmv"' _ "$calls"
: >"$T/fc.calls"; echo "seed: up -d --wait" >"$T/fc.calls"
out="$(env -i PATH="$FDH:$PATH" HOME="$TEST_HOME" STUB_MODE=created STUB_LOG="$T/fc.calls" bash "$SCRIPTS/restore-drill.sh" --cleanup ja-a2g-helper --env-file /dev/null 2>&1)"; rc=$?
check "F-SEC-29: --cleanup never removes a live-named volume even if it carries the anonymous label" \
  bash -c 'rmv=$(grep "^volume rm" "$1"); ! grep -qw eve_fakeanon <<<"$rmv" && ! grep -qw job-assistant_document-data <<<"$rmv"' _ "$T/fc.calls"
# F-SEC-29 (a): the live-volume exclusion also covers the volumes configured in .env
# (BACKUP_DOCUMENT_VOLUME, BACKUP_RESUME_VOLUME, BACKUP_CANDIDATE_VOLUME).
printf 'BACKUP_DOCUMENT_VOLUME=prod-docs-vol\n' >"$T/f29.env"
: >"$T/fh.calls"
out="$(env -i PATH="$FDH:$PATH" HOME="$TEST_HOME" STUB_MODE=created STUB_LOG="$T/fh.calls" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$T/drill19" --set 20261023T010000Z --project ja-a2g-helper --env-file "$T/f29.env" 2>&1)"
check "F-SEC-29a: a volume configured as live in .env (BACKUP_DOCUMENT_VOLUME) is never removed, even labelled anonymous" \
  bash -c 'rmv=$(grep "^volume rm" "$1"); ! grep -qw prod-docs-vol <<<"$rmv" && grep -qw anon0000001 <<<"$rmv"' _ "$T/fh.calls"
check "F-SEC-29a: restore.sh and the drill share one live-volume check (eve_is_live_target_volume in lib.sh)" \
  bash -c 'grep -q "^eve_is_live_target_volume()" "$1" && grep -q "eve_is_live_target_volume" "$2" && grep -q "eve_is_live_target_volume" "$3"' _ "$SCRIPTS/lib.sh" "$SCRIPTS/restore.sh" "$SCRIPTS/restore-drill.sh"
# F-SEC-29 (b): a failed anonymous-volume listing is reported, not silently skipped.
drillh anonfail
check "F-SEC-29b: if Docker cannot list anonymous volumes, teardown reports it (leftover ... unverified), exit non-zero" \
  bash -c '[[ $1 != 0 && $(tail -n 1 <<<"$2") == *"reason=leftover"*"unverified"* ]]' _ "$rc" "$out"
drillh volrmfail
check "F-SEC-22: a drill volume that cannot be removed is reported (status=failed step=teardown reason=leftover names it, last line), exit non-zero" \
  bash -c '[[ $1 != 0 && $(tail -n 1 <<<"$2") == *"eve-drill status=failed step=teardown reason=leftover"*"ja-a2g-helper_documents"* ]]' _ "$rc" "$out"
drillh volrmfail --keep
check "F-SEC-22: with --keep nothing is removed or checked: last line kept project=" \
  bash -c '[[ $(tail -n 1 <<<"$2") == *"kept project=ja-a2g-helper" && $2 != *"step=teardown"* ]] && ! sed -n "/up -d --wait/,\$p" <<<"$3" | grep -q -e "^rm -f" -e "^volume rm" -e "down --volumes"' _ "$rc" "$out" "$calls"

# Exit-path table: SIGTERM after the ownership check tears down and exits 143. (A background job
# ignores SIGINT, so INT, exit 130, uses the same trap but is not driven here.)
FDS="$T/fakedocker-sig"; mkdir -p "$FDS"
printf '#!/usr/bin/env bash\necho "$*" >>"$STUB_LOG"\ncase "$*" in "volume ls"*) exit 0 ;; "volume inspect"*) exit 1 ;; *" up -d --wait"*) sleep 5 ;; esac\nexit 0\n' >"$FDS/docker"; chmod +x "$FDS/docker"; add_cfg_stub "$FDS/docker"
for sig in TERM:143; do
  : >"$T/sig.calls"
  env -i PATH="$FDS:$PATH" HOME="$TEST_HOME" STUB_LOG="$T/sig.calls" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$T/drill19" --set 20261023T010000Z --project ja-a2f-drill19 --env-file /dev/null >"$T/sig.out" 2>&1 &
  spid=$!
  for _ in $(seq 100); do grep -q "up -d --wait" "$T/sig.calls" && break; sleep 0.05; done
  kill -"${sig%:*}" "$spid"; wait "$spid"; rc=$?
  check "drill interrupted by SIG${sig%:*} after step=start exits ${sig#*:} and tears down" \
    bash -c '[[ $1 == $2 ]] && sed -n "/up -d --wait/,\$p" "$3" | grep -q "down --volumes"' _ "$rc" "${sig#*:}" "$T/sig.calls"
done

# F-QA-24: a helper the daemon creates after the teardown's first removal pass (a
# killed `docker run` whose create request was already sent) must still be removed:
# teardown keeps removing labelled containers until none has appeared for a settle
# period, and only then removes the volumes. The stub makes a second helper appear
# 0.5 s after the first one is removed.
FDL="$T/fakedocker-late"; mkdir -p "$FDL"
cat >"$FDL/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
P=ja-a2h-late
now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
started() { grep -q "up -d --wait" "$STUB_LOG"; }
rm1() { grep -m1 " rm -fv h0000001" "$STUB_LOG.t" 2>/dev/null | cut -d" " -f1; }
case "$*" in
  "ps -aq --filter label=eve.backup.target-project=$P"*)
    started || exit 0
    grep -q "^rm -fv.* h0000001" "$STUB_LOG" || { echo h0000001; exit 0; }
    t=$(rm1); [[ -n $t ]] && perl -e 'exit !($ARGV[0] - $ARGV[1] >= 0.5)' "$(now)" "$t" && ! grep -q "^rm -fv.* h0000002" "$STUB_LOG" && echo h0000002
    exit 0 ;;
  "ps -aq"*) exit 0 ;;
  "rm -fv"*) for a in "$@"; do [[ $a == h* ]] && echo "$(now) rm -fv $a" >>"$STUB_LOG.t"; done; exit 0 ;;
  "inspect -f"*) exit 0 ;;
  "volume ls"*) started && ! [[ -e $STUB_LOG.volgone ]] && echo "${P}_documents"; exit 0 ;;
  "volume rm"*) grep -q "^rm -fv.* h0000002" "$STUB_LOG" || { echo "volume is in use" >&2; exit 1; }; : >"$STUB_LOG.volgone"; exit 0 ;;
  "network ls"*) exit 0 ;;
  "volume inspect -f"*) started && echo 1; started || exit 1; exit 0 ;;
  "volume inspect"*) exit 1 ;;
  *" up -d --wait"*) exit 1 ;;
esac
exit 0
STUB
chmod +x "$FDL/docker"; add_cfg_stub "$FDL/docker"
: >"$T/fl.calls"; rm -f "$T/fl.calls.t" "$T/fl.calls.volgone"
out="$(env -i PATH="$FDL:$PATH" HOME="$TEST_HOME" STUB_LOG="$T/fl.calls" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$T/drill19" --set 20261023T010000Z --project ja-a2h-late --env-file /dev/null 2>&1)"; rc=$?
check "F-QA-24: a helper created after the first removal pass is removed too, before the volumes; no leftover" \
  bash -c 'post=$(sed -n "/up -d --wait/,\$p" "$3"); [[ $1 == 1 && $2 != *"step=teardown"* ]] && grep -q "^rm -fv.* h0000002" <<<"$post" && (( $(grep -n "^rm -fv.* h0000002" <<<"$post" | head -1 | cut -d: -f1) < $(grep -n "^volume rm" <<<"$post" | tail -1 | cut -d: -f1) ))' _ "$rc" "$out" "$T/fl.calls"

# F-QA-24: restore.sh refuses to start a helper once the drill has asked it to stop
# (stop-flag file named by EVE_RESTORE_STOP_FILE, checked right before each docker run).
FDF="$T/fakedocker-flag"; mkdir -p "$FDF"
cat >"$FDF/docker" <<'STUB'
#!/usr/bin/env bash
echo "$1 $2" >>"$FAKE_LOG"
case "$*" in
  ps\ *) echo fakepg0024 ;;
  exec*EVE_COUNT_SH*) cat >/dev/null; echo "EVECOUNTS tables=1 rows=1 counts=0123456789abcdef" ;;
  exec\ -i*) cat >/dev/null ;;
  exec*) echo 0 ;;
  run\ *) cat >/dev/null; echo 0 ;;
esac
exit 0
STUB
chmod 755 "$FDF/docker"
printf '#!/bin/sh\ncat >/dev/null 2>&1 || true\n' >"$FDF/age"; chmod 755 "$FDF/age"
mkdir -p "$T/flagset" "$T/flagrd"; for k in db:dump documents:tar resumes:tar; do echo x >"$T/flagset/eve-${k%%:*}-20261023T010000Z.${k#*:}.age"; done
: >"$T/flag.stop"; rm -f "$T/flag.dlog"
out="$(env -i PATH="$FDF:$PATH" HOME="$TEST_HOME" FAKE_LOG="$T/flag.dlog" EVE_RESTORE_STOP_FILE="$T/flag.stop" bash "$SCRIPTS/restore.sh" --env-file /dev/null --identity "$KEY" --set 20261023T010000Z --backup-dir "$T/flagset" --no-verify-log --target-project ja-a2h-flag --target-db-user postgres --documents-volume ja-a2h-flag_documents --resumes-dir "$T/flagrd" 2>&1)"; rc=$?
check "F-QA-24: with the stop flag present, restore.sh starts no helper container and stops (status=failed reason=stopped)" \
  bash -c '[[ $1 != 0 && $2 == *"reason=stopped"* ]] && ! grep -q "^run " "$3"' _ "$rc" "$out" "$T/flag.dlog"
check "F-QA-24: every helper docker run in restore.sh is guarded by the stop-flag check" \
  bash -c 'n=$(grep -c "docker run --rm" "$1"); [[ $(grep -B3 "docker run --rm" "$1" | grep -c "^ *helper_guard || return 15") == "$n" ]]' _ "$SCRIPTS/restore.sh"
check "F-QA-24: teardown writes the stop flag before it removes anything" \
  bash -c 'awk "/^teardown\\(\\) \\{/{t=1} t&&/stop_flag/{print NR; exit}" "$1" | grep -q . && grep -q "EVE_RESTORE_STOP_FILE" "$1"' _ "$SCRIPTS/restore-drill.sh"
# F-SEC-24: on_signal waits for every process of the step (the docker CLIs restore.sh
# started), not only restore.sh, before teardown runs.
check "F-SEC-24: on_signal waits until no descendant of the step is left (bounded, then KILL)" \
  bash -c 'sed -n "/^on_signal()/,/^}/p" "$1" | grep -q "descendants" && sed -n "/^on_signal()/,/^}/p" "$1" | grep -q "wait_procs" && sed -n "/^wait_procs()/,/^}/p" "$1" | grep -q "kill -KILL"' _ "$SCRIPTS/restore-drill.sh"

# F-SEC-25: `restore-drill.sh --cleanup NAME` removes a kept drill project with the
# same teardown and verification (helpers first), and refuses a project it did not
# create, or a live name, before removing anything. It needs no identity or backup.
drillc() { # drillc STUBDIR MODE PROJECT [seed]; sets out rc calls. seed: the stub's
  # "project is up" marker, as left by a kept drill.
  : >"$T/fc.calls"; rm -f "$T/fc.calls.t" "$T/fc.calls.volgone"
  [[ -z "${4:-}" ]] || echo "seed: up -d --wait" >"$T/fc.calls"
  out="$(env -i PATH="$1:$PATH" HOME="$TEST_HOME" STUB_MODE="$2" STUB_LOG="$T/fc.calls" bash "$SCRIPTS/restore-drill.sh" --cleanup "$3" --env-file /dev/null 2>&1)"; rc=$?
  calls="$(cat "$T/fc.calls")"
}
drillc "$FD19" clean ja-a2f-drill19
check "F-SEC-25: --cleanup of an owned kept project: removes helpers (rm -fv) then volumes, verifies, exit 0, last line status=ok step=cleanup" \
  bash -c '[[ $1 == 0 && $(tail -n 1 <<<"$2") == *"eve-drill status=ok step=cleanup project=ja-a2f-drill19" ]] && grep -q "^rm -fv" <<<"$3" && grep -q "^volume rm" <<<"$3" && (( $(grep -n "^rm -fv" <<<"$3" | head -1 | cut -d: -f1) < $(grep -n "^volume rm" <<<"$3" | head -1 | cut -d: -f1) )) && ! grep -q "up -d" <<<"$3"' _ "$rc" "$out" "$calls"
drillc "$FD19" foreign ja-a2f-drill19
check "F-SEC-25: --cleanup refuses a project with an unlabelled container (foreign-project), removes nothing" \
  bash -c '[[ $1 == 2 && $(tail -n 1 <<<"$2") == *"reason=foreign-project" ]] && ! grep -qE "^(rm |volume rm|network rm|compose .* down)" <<<"$3"' _ "$rc" "$out" "$calls"
drillc "$FD19" clean eve
check "F-SEC-25: --cleanup refuses a live project name before any docker call" \
  bash -c '[[ $1 == 2 && $2 == *"reason=live-project"* && -z $3 ]]' _ "$rc" "$out" "$calls"
drillc "$FDL" x ja-a2h-late seed
check "F-SEC-25: --cleanup uses the same settle loop: a helper appearing after the first pass is removed before the volumes" \
  bash -c '[[ $1 == 0 ]] && grep -q "^rm -fv.* h0000002" <<<"$2" && (( $(grep -n "^rm -fv.* h0000002" <<<"$2" | head -1 | cut -d: -f1) < $(grep -n "^volume rm" <<<"$2" | tail -1 | cut -d: -f1) ))' _ "$rc" "$calls"
drillc "$FDH" volrmfail ja-a2g-helper seed
check "F-SEC-25: --cleanup reports a leftover it cannot remove (status=failed step=cleanup reason=leftover), exit 1" \
  bash -c '[[ $1 == 1 && $(tail -n 1 <<<"$2") == *"status=failed step=cleanup reason=leftover"*"ja-a2g-helper_documents"* ]]' _ "$rc" "$out"
check "F-SEC-25: the docs' --keep removal and the header point at --cleanup" \
  bash -c 'grep -q "restore-drill.sh --cleanup" "$1" && grep -q -- "--cleanup" "$2" && ! grep -q "drill.compose.yml down --volumes && docker volume rm" "$1"' _ "$SCRIPTS/../../docs/ops/backups.md" "$SCRIPTS/restore-drill.sh"

# F-QA-26: eve_private_dir must work with GNU stat (Linux) and BSD stat (macOS): true
# for a real 0700 dir owned by the user, false for 0755, 0770, a symlink to a 0700
# dir, a missing path and a file.
mkdir -p "$T/pd700" "$T/pd755" "$T/pd770"; chmod 700 "$T/pd700"; chmod 755 "$T/pd755"; chmod 770 "$T/pd770"
ln -sfn "$T/pd700" "$T/pdlink"; : >"$T/pdfile"; chmod 700 "$T/pdfile"
pd="$(env -i PATH="$PATH" bash -c '. "$1"; for d in "$2/pd700" "$2/pd755" "$2/pd770" "$2/pdlink" "$2/pdmissing" "$2/pdfile"; do eve_private_dir "$d" && printf 1 || printf 0; done' _ "$SCRIPTS/lib.sh" "$T")"
check "F-QA-26: eve_private_dir is true only for a real 0700 dir (700 755 770 symlink missing file -> 100000) on this platform ($(uname -s))" test "$pd" = 100000

# F-SEC-37: report the awk in use; in the Linux container it must be the host default
# (mawk on Debian/Ubuntu), so every awk program in the scripts runs under it.
AWK_IMPL="$(awk -W version 2>&1 </dev/null | head -n 1; awk --version 2>&1 </dev/null | head -n 1)"
echo "# awk: $(readlink -f "$(command -v awk)" 2>/dev/null || command -v awk) ${AWK_IMPL//$'\n'/ | }"
if [[ "$(uname -s)" == Linux && -n "${EVE_TEST_EXPECT_AWK:-}" ]]; then
  check "F-SEC-37: the suite runs under the expected awk ($EVE_TEST_EXPECT_AWK)" bash -c '[[ $(readlink -f "$(command -v awk)") == *"$1"* ]]' _ "$EVE_TEST_EXPECT_AWK"
fi

# F-QA-26 audit: no script or test uses the BSD-first "stat -f ... || stat -c" idiom
# (wrong on GNU: stat -f prints file-system status there). Mode checks go through
# eve_mode; the only flavour-specific stat calls are inside eve_mode and the guard.
check "F-QA-26: no 'stat -f ... || stat -c' fallback anywhere in scripts/backup" \
  bash -c '! grep -rn "stat -f[^|]*||[^|]*stat -c" "$1" | grep -v "F-QA-26"' _ "$SCRIPTS"

# F-QA-26 audit: the PID start time is written (restore.sh) and compared (drill) with
# one shared function, eve_proc_start in lib.sh, so the format cannot differ between
# the two sides (GNU procps and BSD ps print lstart differently padded).
check "F-QA-26: restore.sh and the drill use the same eve_proc_start for the PID start time" \
  bash -c 'grep -q "^eve_proc_start()" "$1" && grep -q "eve_proc_start" "$2" && grep -q "eve_proc_start" "$3" && ! grep -q "ps -o lstart=" "$2" "$3"' _ "$SCRIPTS/lib.sh" "$SCRIPTS/restore.sh" "$SCRIPTS/restore-drill.sh"
ps_start="$(env -i PATH="$PATH" bash -c '. "$1"; sleep 2 & p=$!; a="$(eve_proc_start "$p")"; b="$(eve_proc_start "$p")"; kill "$p"; wait "$p" 2>/dev/null; [[ -n $a && $a == "$b" && $a != *" " ]] && echo same' _ "$SCRIPTS/lib.sh")"
check "F-QA-26: eve_proc_start is stable for a running process, non-empty, with no trailing blanks ($(uname -s))" test "$ps_start" = same
gone="$(env -i PATH="$PATH" bash -c '. "$1"; sleep 0 & p=$!; wait "$p"; eve_proc_start "$p" && echo found || echo none' _ "$SCRIPTS/lib.sh")"
check "F-QA-26: eve_proc_start fails for a process that is gone" test "$gone" = none
# F-SEC-36: restore.sh removes cli.<pid> only from a directory it accepted (and wrote).
mkdir -p "$T/f36open"; chmod 777 "$T/f36open"
sed -n "/^helper_exec()/,/^}/p" "$SCRIPTS/restore.sh" >"$T/f36.he"; cat "$SCRIPTS/lib.sh" >>"$T/f36.he"
out36="$(env -i PATH="$PATH" EVE_RESTORE_PID_DIR="$T/f36open" bash -c '. "$1"; sleep 0.3 & s=$!; ( exec sleep 0 ); n=$(( s + 1 )); for i in $(seq 0 50); do : >"$2/cli.$(( s + i ))"; done; ( helper_exec true ); ls "$2" | wc -l | tr -d " "' _ "$T/f36.he" "$T/f36open" 2>&1)"
check "F-SEC-36: helper_exec never removes cli.<pid> from a directory it refused (0777): all 51 planted files remain" test "$out36" = 51

# F-SEC-31: a restore.sh that survives TERM (blocked on a pipe a reparented CLI holds)
# is KILLed after the bound, so its own EXIT trap never removes its work dir, which
# holds metadata of decrypted data. The drill gives restore.sh a work location inside
# its own 0700 directory and removes it in teardown; a removal failure is reported as
# a leftover, and the KILL is reported (F-SEC-29 c). Simulated with a copy of
# restore.sh that ignores the stop signals.
f31() { # f31 VARIANT(plain|locked); sets rc out tmp
  local d="$T/scripts31-$1"; tmp="$T/tmp31-$1"
  rm -rf "$d" "$tmp"; mkdir -p "$d" "$tmp"
  cp "$SCRIPTS"/*.sh "$SCRIPTS/drill.compose.yml" "$d/"
  awk -v v="$1" '{ print } /^set -Eeuo pipefail$/ && !s { print "trap \"\" TERM HUP INT QUIT # TEST: survive TERM"; s = 1 }
    /^trap .rm -rf -- "\$WORK". EXIT$/ && v == "locked" { print "mkdir \"$WORK/locked\"; : >\"$WORK/locked/f\"; chmod 500 \"$WORK/locked\" # TEST" }' \
    "$SCRIPTS/restore.sh" >"$d/restore.sh"
  : >"$T/f31.calls"; rm -f "$T/f31.calls.blocked"
  env -i PATH="$FD20:$PATH" HOME="$TEST_HOME" TMPDIR="$tmp" STUB_LOG="$T/f31.calls" bash "$d/restore-drill.sh" --identity "$KEY" --backup-dir "$T/drill20" --set 20261023T010000Z --project ja-a2h-f31 --env-file /dev/null >"$T/f31.out" 2>&1 &
  local spid=$!
  for _ in $(seq 400); do [[ -s "$T/f31.calls.blocked" ]] && break; sleep 0.05; done
  kill -TERM "$spid"; wait "$spid"; rc=$?
  out="$(cat "$T/f31.out")"
}
f31 plain
check "F-SEC-31: restore.sh's work dir is inside the drill's private dir while it runs (no eve-restore.* elsewhere)" \
  bash -c '[[ -z $(find "$1" -maxdepth 1 -name "eve-restore.*" 2>/dev/null) ]] && grep -q "^trap \"\" TERM" "$2"' _ "$tmp" "$T/scripts31-plain/restore.sh"
check "F-SEC-31: a restore.sh KILLed after the bound leaves no work dir; the KILL is reported (note=killed); exit 143; teardown ran" \
  bash -c '[[ $1 == 143 && -z $(find "$3" -mindepth 1 2>/dev/null) && $2 == *"eve-drill note=killed"* ]] && sed -n "/^exec/,\$p" "$4" | grep -q "down --volumes"' _ "$rc" "$out" "$tmp" "$T/f31.calls"
f31 locked
check "F-SEC-31: a work dir that cannot be removed is reported: last line status=failed step=teardown reason=leftover naming workdir:" \
  bash -c '[[ $1 == 143 && $(tail -n 1 <<<"$2") == *"status=failed step=teardown reason=leftover"*"workdir:"* ]]' _ "$rc" "$out"
chmod -R u+w "$T/tmp31-locked" 2>/dev/null; rm -rf "$T/tmp31-locked" "$T/tmp31-plain"

# F-SEC-34: the pre-TERM descendant snapshot is checked by start time too. A snapshot
# entry whose PID now belongs to a different process (reused PID) is not selected; a
# live entry with its own start time is.
cat "$SCRIPTS/lib.sh" >"$T/f34.fn"; grep -E "^cli_start\(\)" "$SCRIPTS/restore-drill.sh" >>"$T/f34.fn"; sed -n "/^snapshot()/,/^}/p;/^snap_alive()/,/^}/p" "$SCRIPTS/restore-drill.sh" >>"$T/f34.fn"
bash -c 'exec -a f34-other sleep 30' & other=$!
sleep 0.3
out="$(env -i PATH="$PATH" bash -c '. "$1"; snap_alive "$2|Thu Jan  1 00:00:00 1970"; echo "--"; snap_alive "$(snapshot "$2")"' _ "$T/f34.fn" "$other" 2>&1)"
check "F-SEC-34: a snapshot entry whose PID now has another start time is not selected; a matching one is" \
  bash -c '[[ $1 == "--"$'"'"'\n'"'"'"$2" ]] && kill -0 "$2"' _ "$out" "$other"
kill "$other" 2>/dev/null
check "F-SEC-34: on_signal signals only snapshot entries that are still the same process (snap_alive), and wait_procs uses snapshots" \
  bash -c 'sed -n "/^on_signal()/,/^}/p" "$1" | grep -q "kill -TERM \"\$p\"" && sed -n "/^on_signal()/,/^}/p" "$1" | grep -q "for p in \$(snap_alive" && sed -n "/^wait_procs()/,/^}/p" "$1" | grep -q snap_alive' _ "$SCRIPTS/restore-drill.sh"

# F-SEC-33: restore.sh writes a PID record only into a private directory (real dir,
# owned by the user, 0700) and never through a symlink (noclobber).
sed -n "/^helper_exec()/,/^}/p" "$SCRIPTS/restore.sh" >"$T/f33.he"; cat "$SCRIPTS/lib.sh" >>"$T/f33.he"
mkdir -p "$T/f33open" "$T/f33priv"; chmod 777 "$T/f33open"; chmod 700 "$T/f33priv"
env -i PATH="$PATH" EVE_RESTORE_PID_DIR="$T/f33open" bash -c '. "$1"; ( helper_exec sleep 0.5 ) & sleep 0.2; ls "$2"; wait' _ "$T/f33.he" "$T/f33open" >"$T/f33a.out" 2>&1
check "F-SEC-33: no PID record is written into a directory that is not private (0777)" test ! -s "$T/f33a.out"
: >"$T/f33victim"
# Deterministic: the command itself is `ps`-free; a wrapper "ps" plants the symlink at
# cli.<pid> right before helper_exec writes the record (ps runs first, for lstart).
mkdir -p "$T/f33bin"; printf '#!/bin/sh\n[ "$1" = -o ] && ln -sf "$F33_VICTIM" "$F33_DIR/cli.$4" 2>/dev/null && echo "plant $4" >>"$F33_LOG"\nexec %s "$@"\n' "$(command -v ps)" >"$T/f33bin/ps"; chmod +x "$T/f33bin/ps"
rm -f "$T/f33plant.log"
env -i PATH="$T/f33bin:$PATH" F33_VICTIM="$T/f33victim" F33_DIR="$T/f33priv" F33_LOG="$T/f33plant.log" EVE_RESTORE_PID_DIR="$T/f33priv" bash -c '. "$1"; ( helper_exec true ); echo rc=$?; ls -l "$2"' _ "$T/f33.he" "$T/f33priv" >"$T/f33b.out" 2>&1
check "F-SEC-33: a symlink planted at the record path just before the write is not followed (target stays empty); the command still runs" \
  bash -c '[[ -f "$1" && ! -L "$1" && ! -s "$1" ]] && grep -q "rc=0" "$2" && grep -q "^plant " "$3"' _ "$T/f33victim" "$T/f33b.out" "$T/f33plant.log"
rm -rf "$T/f33open" "$T/f33priv"

# F-SEC-30: the recorded-PID path alone. The stub CLI runs under a process name that
# contains "docker" (exec -a), ignores TERM, and is detached from restore.sh (its
# parent subshell exits at once), so it is never a descendant of the step: only the
# recorded PID (and start time) lets the drill find it. It must be TERMed/KILLed
# before teardown, within the bounded wait.
FD30="$T/fakedocker-f30"; mkdir -p "$FD30"
cat >"$FD30/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
case "$*" in
  "ps -aq"*) exit 0 ;;
  "ps -q"*) echo fakepg0030; exit 0 ;;
  exec*"select 1"*) exit 0 ;;
  exec\ -i*) cat >/dev/null; exit 0 ;;
  exec*EVE_COUNT_SH*) echo "EVECOUNTS tables=1 rows=1 counts=0123456789abcdef"; exit 0 ;;
  exec*) echo 0; exit 0 ;;
  "run "*)
    # Replace this process (keeping its PID, the recorded one) by a TERM-ignoring
    # loop named docker-cli-stub, then orphan it: a double fork would change the
    # PID, so instead the stub re-parents by having restore.sh's subshell be killed.
    exec -a docker-cli-stub bash -c 'trap "" TERM INT HUP; echo "$$" >"$0.cli"; while :; do sleep 0.2; done' "$STUB_LOG" ;;
  *" down --volumes"*) c="$(cat "$STUB_LOG.cli" 2>/dev/null)"; if [[ -n $c ]] && kill -0 "$c" 2>/dev/null; then echo "cli-alive-at-down" >>"$STUB_LOG"; else echo "cli-gone-at-down" >>"$STUB_LOG"; fi; exit 0 ;;
  "volume ls"* | "network ls"*) exit 0 ;;
  "volume inspect"*) exit 1 ;;
esac
exit 0
STUB
chmod +x "$FD30/docker"; add_cfg_stub "$FD30/docker"
printf '#!/bin/sh\ncat >/dev/null 2>&1; exit 0\n' >"$FD30/age"; chmod +x "$FD30/age"
: >"$T/f30.calls"; rm -f "$T/f30.calls.cli"
env -i PATH="$FD30:$PATH" HOME="$TEST_HOME" STUB_LOG="$T/f30.calls" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$T/drill20" --set 20261023T010000Z --project ja-a2h-f30 --env-file /dev/null >"$T/f30.out" 2>&1 &
spid=$!
for _ in $(seq 400); do [[ -s "$T/f30.calls.cli" ]] && break; sleep 0.05; done
cli="$(cat "$T/f30.calls.cli" 2>/dev/null)"
# Detach the CLI from the step before the drill takes its snapshot: kill every
# ancestor between restore.sh and the CLI (the subshells), so the CLI is reparented.
# restore.sh is the drill's direct child; every process between it and the CLI is
# one of its subshells. KILL those, so the CLI's parent becomes PID 1 (or launchd).
if [[ -n $cli ]]; then
  # The drill's direct child running restore.sh (ps args column; GNU and BSD).
  rs="$(ps -A -o pid= -o ppid= -o args= | awk -v d="$spid" '$2 == d && /restore\.sh/ { print $1 }')" || rs=""
  pp="$(ps -o ppid= -p "$cli" | tr -d ' ')"
  while [[ -n $pp && $pp != 1 && $pp != "$rs" && $pp != "$spid" ]]; do
    nxt="$(ps -o ppid= -p "$pp" | tr -d ' ')"; kill -KILL "$pp" 2>/dev/null; pp="$nxt"
  done
  sleep 0.3
fi
comm30="$(ps -o args= -p "$cli" 2>/dev/null)"; ppid30="$(ps -o ppid= -p "$cli" 2>/dev/null | tr -d ' ')"
# Watchdog: without the recorded-PID wait the drill would leave the CLI running and
# the test must fail, not hang. After 60 s it KILLs the drill and the CLI.
# F-QA-27: proven by order (the stub's compose down logs whether the CLI is still
# alive), not by wall time; the time check only guards against a hang.
( sleep 60; kill -KILL "$spid" "$cli" 2>/dev/null ) &
wd=$!
t0=$SECONDS; kill -TERM "$spid"; wait "$spid"; rc=$?; dt=$((SECONDS - t0))
cli_alive=0; kill -0 "$cli" 2>/dev/null && cli_alive=1
kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
sleep 0.3
check "F-SEC-30: the stub CLI is named docker and is reparented (not a descendant of the step) before the signal" \
  bash -c '[[ $1 == *docker* && -n $2 && $2 != "$3" ]] && ! ps -o command= -p "$2" | grep -q restore' _ "$comm30" "$ppid30" "$rs"
check "F-SEC-30: a reparented helper CLI found only by its recorded PID is KILLed after the bound and reported (note=killed), and is gone before teardown's compose down; exit 143" \
  bash -c '[[ $1 == 143 && -n $3 && $5 == 0 ]] && grep -q "eve-drill note=killed" "$6" && grep -q "^cli-gone-at-down$" "$4" && ! grep -q "^cli-alive-at-down$" "$4"' _ "$rc" "$dt" "$cli" "$T/f30.calls" "$cli_alive" "$T/f30.out"
check "F-SEC-30: the drill's wait is bounded (no hang: within 50 s, measured $dt s)" test "$dt" -le 50
[[ -n $cli ]] && kill -KILL "$cli" 2>/dev/null

# F-SEC-28: PID records are removed when the helper CLI exits, and carry the start
# time; teardown signals a recorded PID only if its start time still matches. A stale
# record whose PID now belongs to an unrelated docker-named process is left alone.
bash -c 'exec -a docker-unrelated sleep 30' & unrel=$!
sleep 0.3
mkdir -p "$T/f28dir"
cat "$SCRIPTS/lib.sh" >"$T/f28.cp"; grep -E "^cli_start\(\)|^cli_pids\(\)" "$SCRIPTS/restore-drill.sh" >>"$T/f28.cp"; sed -n "/^cli_snap()/,/^}/p;/^snap_alive()/,/^}/p" "$SCRIPTS/restore-drill.sh" >>"$T/f28.cp"
printf '%s Thu Jan  1 00:00:00 1970\n' "$unrel" >"$T/f28dir/cli.$unrel"
out="$(env -i PATH="$PATH" HOME="$TEST_HOME" bash -c '. "$1"; STOP_DIR="$2"; cli_pids' _ "$T/f28.cp" "$T/f28dir" 2>&1)"
check "F-SEC-28: a stale PID record whose PID now belongs to an unrelated docker-named process is not selected" \
  bash -c '[[ -z $1 ]] && kill -0 "$2"' _ "$out" "$unrel"
printf '%s %s\n' "$unrel" "$(ps -o lstart= -p "$unrel")" >"$T/f28dir/cli.$unrel"
out="$(env -i PATH="$PATH" HOME="$TEST_HOME" bash -c '. "$1"; STOP_DIR="$2"; cli_pids' _ "$T/f28.cp" "$T/f28dir" 2>&1)"
check "F-SEC-28: control: a record whose start time matches is selected" test "$out" = "$unrel"
kill "$unrel" 2>/dev/null
D28="$(mktemp -d)"; chmod 700 "$D28"
sed -n "/^helper_exec()/,/^}/p" "$SCRIPTS/restore.sh" >"$T/f28.he"; cat "$SCRIPTS/lib.sh" >>"$T/f28.he"
env -i PATH="$PATH" EVE_RESTORE_PID_DIR="$D28" bash -c '. "$1"; ( helper_exec true ); ( helper_exec sh -c "exit 3" ); echo "rc=$?"' _ "$T/f28.he" >"$T/f28.out" 2>&1
check "F-SEC-28: helper_exec records PID and start time, removes the record when the CLI exits, and keeps its exit code" \
  bash -c '[[ $(cat "$2") == rc=3 && -z $(ls -A "$1") ]] && sed -n "/^helper_exec()/,/^}/p" "$3" | grep -q "eve_proc_start" && sed -n "/^helper_exec()/,/^}/p" "$3" | grep -q "rm -f"' _ "$D28" "$T/f28.out" "$SCRIPTS/restore.sh"
rm -rf "$D28"

# F-QA-27: the settle loop needs both SETTLE seconds and at least 4 quiet checks, so a
# helper that appears late is still caught when a single check takes longer than the
# settle period (heavy load). Simulated with a docker stub whose listing takes 2.5 s
# and whose second helper appears on the third listing.
FDQ="$T/fakedocker-q27"; mkdir -p "$FDQ"
cat >"$FDQ/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
case "$*" in
  "ps -aq --filter label=eve.backup.target-project="*)
    n=$(grep -c "^ps -aq --filter label=eve.backup.target-project=" "$STUB_LOG"); sleep 2.5
    [[ $n == 1 ]] && echo q0000001
    # q0000002 appears on the third look and stays until removed, as in Docker.
    [[ $n -ge 3 ]] && ! grep -q "^rm -fv.*q0000002" "$STUB_LOG" && echo q0000002
    exit 0 ;;
  "ps -aq"* | "rm -fv"* | "inspect -f"* | "volume rm"* | "network rm"* | "volume ls"* | "network ls"*) exit 0 ;;
esac
exit 0
STUB
chmod +x "$FDQ/docker"
cat "$SCRIPTS/lib.sh" >"$T/q27.fn"; sed -n '/^labelled_ids()/,/^}/p;/^remove_containers()/,/^}/p;/^remove_project()/,/^}/p' "$SCRIPTS/restore-drill.sh" >>"$T/q27.fn"
: >"$T/q27.calls"
env -i PATH="$FDQ:$PATH" STUB_LOG="$T/q27.calls" bash -c '. "$1"; PROJECT=ja-a2i-q27 SETTLE=2 SETTLE_MAX=60 DRILL_VOLUMES="" DRILL_NETWORKS="" HELPER_ANON="" ANON_UNVERIFIED=0; COMPOSE=(true); remove_project' _ "$T/q27.fn" >/dev/null 2>&1
check "F-QA-27: with a listing slower than the settle period, a helper appearing on the third look is still removed (q0000002)" \
  grep -q "^rm -fv.*q0000002" "$T/q27.calls"

# F-QA-27: the drill's wait bound is wall-clock (10 s), not a number of polls, so it
# holds when each poll is slow (heavy load). A ps that takes 1 s per call must not
# stretch the wait: wait_procs on a TERM-ignoring process returns (after KILL) within
# 10 s + one poll + margin.
mkdir -p "$T/slowps"; printf '#!/bin/sh\nsleep 1\nexec %s "$@"\n' "$(command -v ps)" >"$T/slowps/ps"; chmod +x "$T/slowps/ps"
cat "$SCRIPTS/lib.sh" >"$T/fqa27.fn"; sed -n '/^cli_start()/p;/^snap_alive()/,/^}/p;/^wait_procs()/,/^}/p;/^snapshot()/,/^}/p' "$SCRIPTS/restore-drill.sh" >>"$T/fqa27.fn"
bash -c 'trap "" TERM; exec -a fqa27-stuck sleep 60' & stuck=$!
sleep 0.2
out27="$(env -i PATH="$T/slowps:$PATH" bash -c 'say() { echo "$*"; }; . "$1"; s=$(snapshot "$2"); t0=$SECONDS; wait_procs "$s"; echo "dt=$((SECONDS - t0))"' _ "$T/fqa27.fn" "$stuck" 2>&1)"
kill -KILL "$stuck" 2>/dev/null; wait "$stuck" 2>/dev/null
dt27="${out27##*dt=}"
check "F-QA-27: wait_procs' 10 s bound is wall-clock: with a 1 s ps it KILLs and returns within 16 s (measured ${dt27} s), reporting note=killed" \
  bash -c '[[ $1 =~ ^[0-9]+$ && $1 -ge 9 && $1 -le 16 && $2 == *"note=killed pids=1"* ]]' _ "$dt27" "$out27"

# F-SEC-26: the unpack helper's `docker run` CLI is a child of a command-substitution
# subshell, not of restore.sh. When TERM kills that subshell, the CLI is reparented and
# is no longer a descendant of the step; an attached CLI forwards the signal and keeps
# running. The drill must still wait for it (it records each helper CLI's own PID)
# and KILL it after the bounded wait. The stub CLI ignores TERM and blocks.
# F-QA-27: proven by order, not wall time (load-robust): the CLI's PID record exists
# before the signal; the stub's `compose down` (teardown) logs whether the CLI is
# still alive at that moment; the drill reports the KILL (note=killed). Wall time only
# guards against a hang (10 s bound + 40 s margin; a 60 s watchdog ends a stuck run).
FDR26="$T/fakedocker-f26"; mkdir -p "$FDR26" "$T/tmp26"
cat >"$FDR26/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
case "$*" in
  "ps -aq"*) exit 0 ;;
  "ps -q"*) echo fakepg0026; exit 0 ;;
  exec*"select 1"*) exit 0 ;;
  exec\ -i*) cat >/dev/null; exit 0 ;;
  exec*EVE_COUNT_SH*) echo "EVECOUNTS tables=1 rows=1 counts=0123456789abcdef"; exit 0 ;;
  exec*) echo 0; exit 0 ;;
  "run "*) echo "$$" >"$STUB_LOG.cli"; trap '' TERM INT HUP; sleep 60; echo cli-finished >>"$STUB_LOG"; exit 0 ;;
  *" down --volumes"*) c="$(cat "$STUB_LOG.cli" 2>/dev/null)"; if [[ -n $c ]] && kill -0 "$c" 2>/dev/null; then echo "cli-alive-at-down" >>"$STUB_LOG"; else echo "cli-gone-at-down" >>"$STUB_LOG"; fi; exit 0 ;;
  "volume ls"* | "network ls"*) exit 0 ;;
  "volume inspect"*) exit 1 ;;
esac
exit 0
STUB
chmod +x "$FDR26/docker"; add_cfg_stub "$FDR26/docker"
printf '#!/bin/sh\ncat >/dev/null 2>&1; exit 0\n' >"$FDR26/age"; chmod +x "$FDR26/age"
: >"$T/f26.calls"; rm -f "$T/f26.calls.cli"
env -i PATH="$FDR26:$PATH" HOME="$TEST_HOME" TMPDIR="$T/tmp26" STUB_LOG="$T/f26.calls" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$T/drill20" --set 20261023T010000Z --project ja-a2h-f26 --env-file /dev/null >"$T/f26.out" 2>&1 &
spid=$!
for _ in $(seq 400); do [[ -s "$T/f26.calls.cli" ]] && break; sleep 0.05; done
cli="$(cat "$T/f26.calls.cli" 2>/dev/null)"
recorded=no
for _ in $(seq 40); do compgen -G "$T/tmp26/eve-drill.*/cli.$cli" >/dev/null && { recorded=yes; break; }; sleep 0.05; done
( sleep 60; kill -KILL "$spid" "$cli" 2>/dev/null ) &
wd=$!
t0=$SECONDS; kill -TERM "$spid"; wait "$spid"; rc=$?; dt=$((SECONDS - t0))
kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
sleep 0.3
check "F-SEC-26: the helper CLI's own PID was recorded (cli.<pid> in the drill's dir) before the signal" test "$recorded" = yes
check "F-SEC-26: a helper CLI that ignores TERM is KILLed after the bound and reported (note=killed), and is gone before teardown's compose down; exit 143" \
  bash -c '[[ $1 == 143 && -n $3 ]] && ! kill -0 "$3" 2>/dev/null && ! grep -q cli-finished "$4" && grep -q "^cli-gone-at-down$" "$4" && ! grep -q "^cli-alive-at-down$" "$4" && grep -q "eve-drill note=killed" "$5"' _ "$rc" "$dt" "$cli" "$T/f26.calls" "$T/f26.out"
check "F-SEC-26: the drill's wait is bounded (finished within the 10 s bound + 40 s margin, measured $dt s)" test "$dt" -le 50
[[ -n $cli ]] && kill -KILL "$cli" 2>/dev/null
check "F-SEC-26: every helper docker run in restore.sh records its CLI PID (helper_exec)" \
  bash -c 'n=$(grep -c "docker run --rm" "$1"); [[ $n -ge 3 && $(grep "docker run --rm" "$1" | grep -c "helper_exec docker run --rm") == "$n" ]]' _ "$SCRIPTS/restore.sh"

# F-SEC-23: the EXIT trap's first command ignores HUP INT QUIT TERM, before teardown
# runs anything, and still passes the original exit code on. Checked on the installed
# trap string, then behaviourally: an instrumented copy signals itself as the first
# thing inside teardown; the teardown must still run to the end.
check "F-SEC-23: the EXIT trap string starts with trap '' HUP INT QUIT TERM" \
  bash -c 'grep -qE "^trap '"'"'trap -- \"\" HUP INT QUIT TERM" "$1"' _ "$SCRIPTS/restore-drill.sh"
mkdir -p "$T/scripts23"; cp "$SCRIPTS"/*.sh "$SCRIPTS/drill.compose.yml" "$T/scripts23/"
awk '{ print } /^teardown\(\) \{$/ { print "  kill -TERM $$; sleep 0.3" }' "$SCRIPTS/restore-drill.sh" >"$T/scripts23/restore-drill.sh"
: >"$T/f19.calls"
out="$(env -i PATH="$FD19:$PATH" HOME="$TEST_HOME" STUB_MODE=clean STUB_LOG="$T/f19.calls" bash "$T/scripts23/restore-drill.sh" --identity "$KEY" --backup-dir "$T/drill19" --set 20261023T010000Z --project ja-a2f-drill19 --env-file /dev/null 2>&1)"; rc=$?
check "F-SEC-23: a TERM as teardown starts cannot cut it short: exit 1 kept, compose down and volume rm still run" \
  bash -c '[[ $1 == 1 ]] && sed -n "/up -d --wait/,\$p" "$2" | grep -q "down --volumes" && sed -n "/up -d --wait/,\$p" "$2" | grep -q "^volume rm"' _ "$rc" "$T/f19.calls"

# F-QA-23: with --keep, a signal during `compose up` must still print the kept line:
# the step's output goes to /dev/null, the handler's and teardown's do not.
for sc in HUP:129 INT:130 QUIT:131 TERM:143; do
  : >"$T/sig.calls"
  env -i PATH="$FDS:$PATH" HOME="$TEST_HOME" STUB_LOG="$T/sig.calls" perl -e '$SIG{INT} = $SIG{QUIT} = "DEFAULT"; exec @ARGV' bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$T/drill19" --set 20261023T010000Z --project ja-a2g-keepup --env-file /dev/null --keep >"$T/keepup.out" 2>&1 &
  spid=$!
  for _ in $(seq 100); do grep -q "up -d --wait" "$T/sig.calls" && break; sleep 0.05; done
  sleep 0.2; kill -"${sc%:*}" "$spid"; wait "$spid"; rc=$?
  check "F-QA-23: --keep and SIG${sc%:*} during compose up: exit ${sc#*:}, last line kept project=, nothing removed after up" \
    bash -c '[[ $1 == $2 && $(tail -n 1 "$3") == *"kept project=ja-a2g-keepup" ]] && ! sed -n "/up -d --wait/,\$p" "$4" | grep -q -e "down --volumes" -e "volume rm"' _ "$rc" "${sc#*:}" "$T/keepup.out" "$T/sig.calls"
done

# Harness exit (run a2i, devops-3): a TERM (or HUP, INT) of the harness stops every
# process of the run before $T is removed, both its descendants and processes that
# were reparented away but name $T, so no script can fall through to the real docker
# CLI. A process that ignores TERM is KILLed after the bound. Then the unit cases'
# fixed-name volumes that did not exist at the start are removed, and nothing else.
mkdir -p "$T/hx/tag" "$T/hx/bin"
sed -n '/^suite_procs()/,/^}/p;/^SUITE_STOP_BOUND=/p;/^stop_suite_procs()/,/^}/p;/^SUITE_UNIT_PROJECTS=/p;/^remove_suite_volumes()/,/^}/p' "$TEST_DIR/run-tests.sh" >"$T/hx/fn.sh"
cat >"$T/hx/harness.sh" <<'HX'
. "$1"; TAG="$2"; SUITE_STOP_BOUND=3
trap 'stop_suite_procs "$$" "$TAG"; echo cleaned >>"$TAG/log"' EXIT
# a descendant that tears down on TERM, a reparented one that names TAG, and one that ignores TERM
bash -c 'trap "echo child-term >>\"$0/log\"; exit 0" TERM; echo $$ >"$0/child.pid"; while :; do sleep 0.1; done' "$TAG" &
( bash -c 'trap "echo orphan-term >>\"$0/log\"; exit 0" TERM; echo $$ >"$0/orphan.pid"; while :; do sleep 0.1; done' "$TAG" & )
( bash -c 'trap "" TERM; echo $$ >"$0/stubborn.pid"; while :; do sleep 0.1; done' "$TAG" & )
echo ready >>"$TAG/log"
while :; do sleep 0.1; done
HX
: >"$T/hx/tag/log"
bash "$T/hx/harness.sh" "$T/hx/fn.sh" "$T/hx/tag" & hpid=$!
for _ in $(seq 200); do [[ -s $T/hx/tag/child.pid && -s $T/hx/tag/orphan.pid && -s $T/hx/tag/stubborn.pid ]] && grep -q ready "$T/hx/tag/log" && break; sleep 0.05; done
hxp="$(cat "$T/hx/tag/child.pid" "$T/hx/tag/orphan.pid" "$T/hx/tag/stubborn.pid" 2>/dev/null | tr '\n' ' ')"
kill -TERM "$hpid"; wait "$hpid"; hrc=$?
sleep 0.3
hx_alive=""; for p in $hxp; do kill -0 "$p" 2>/dev/null && hx_alive="$hx_alive $p"; done
check "harness exit: on TERM the run's processes (a descendant, a reparented one naming \$T, one ignoring TERM) are all stopped before cleanup ends (exit 143)" \
  bash -c '[[ $1 == 143 && $(wc -w <<<"$2") -eq 3 && -z $3 ]] && grep -q child-term "$4" && grep -q orphan-term "$4" && grep -q cleaned "$4"' _ "$hrc" "$hxp" "$hx_alive" "$T/hx/tag/log"
for p in $hx_alive; do kill -KILL "$p" 2>/dev/null; done
cat >"$T/hx/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
case "$*" in
  "volume ls -q") printf '%s\n' old-vol ja-a2h-f30_documents ja-a2h-f26_documents ja-a2h-f26x_documents investor-gap_mongo_data ja-a2h-f31 ;;
esac
exit 0
STUB
chmod +x "$T/hx/bin/docker"; : >"$T/hx/rm.calls"
env -i PATH="$T/hx/bin:$PATH" STUB_LOG="$T/hx/rm.calls" bash -c '. "$1"; SUITE_VOLS0=$(printf "%s\n" old-vol ja-a2h-f30_documents); remove_suite_volumes' _ "$T/hx/fn.sh"
check "harness exit: only new volumes of the unit cases' projects are removed (ja-a2h-f26_documents; not a pre-existing one, a lookalike, another project's)" \
  bash -c '[[ $(grep "^volume rm" "$1") == "volume rm ja-a2h-f26_documents" ]]' _ "$T/hx/rm.calls"
check "harness exit: the EXIT trap stops the run's processes and removes test volumes before \$T is removed; INT exits" \
  bash -c 's=$(sed -n "/^cleanup()/,/^}/p" "$1"); grep -q "^trap cleanup EXIT$" "$1" && grep -q "^trap .exit 130. INT$" "$1" && [[ $(grep -n stop_suite_procs <<<"$s" | head -1 | cut -d: -f1) -lt $(grep -n remove_suite_volumes <<<"$s" | head -1 | cut -d: -f1) && $(grep -n remove_suite_volumes <<<"$s" | head -1 | cut -d: -f1) -lt $(grep -n "rm -rf -- \"\$T\"$" <<<"$s" | cut -d: -f1) ]]' _ "$TEST_DIR/run-tests.sh"

if ((UNIT_ONLY)); then
  check "safety: the real ~/eve-backups listing is unchanged by the suite" test "$(real_backups_state)" = "$REAL_BACKUPS_BEFORE"
  echo "1..$N"
  echo "# pass=$PASS fail=$FAIL"
  ((FAIL == 0))
  exit
fi

# ---------------------------------------------------------- integration tests
echo "# integration (compose project $PROJECT)"
SUITE_DANGLING0="$(docker volume ls -qf dangling=true -f label=com.docker.volume.anonymous | sort)"
export BACKUP_TEST_BOOTSTRAP_PASSWORD="$BOOTSTRAP_PW"
"${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
"${DRILL_COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
docker volume rm -f "$DOC_VOL" "$RES_VOL" "$CAND_VOL" "$A2_DOC_VOL" "$A2_RES_VOL" >/dev/null 2>&1 || true
if ! "${COMPOSE[@]}" up -d --wait >/dev/null 2>&1; then echo "Bail out! compose up failed"; exit 1; fi
eve_wait_pg "$PROJECT" job_assistant test_bootstrap "$BOOTSTRAP_PW" || { echo "Bail out! test postgres not ready"; exit 1; }
PG="$(eve_pg_container "$PROJECT")" || { echo "Bail out! no test postgres"; exit 1; }
psql_boot() { docker exec -i -e PGPASSWORD="$BOOTSTRAP_PW" "$PG" psql -X -q -At -v ON_ERROR_STOP=1 -U test_bootstrap -d job_assistant "$@"; }
psql_owner() { docker exec -i -e PGPASSWORD="$MARK_PW" "$PG" psql -X -q -At -v ON_ERROR_STOP=1 -U ja_owner -d job_assistant "$@"; }
psql_backup() { docker exec -i -e PGPASSWORD="$MARK_BACKUP_PW" "$PG" psql -X -q -At -v ON_ERROR_STOP=1 -U ja_backup -d job_assistant "$@"; }

# Fake schema shaped like Eve's: owner role owns the database, public tables and pgboss.
psql_boot >/dev/null <<SQL
CREATE ROLE ja_owner LOGIN PASSWORD '$MARK_PW';
ALTER DATABASE job_assistant OWNER TO ja_owner;
-- fix-backup-role: as provision-roles creates it (ensureBackupRole).
CREATE ROLE ja_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS PASSWORD '$MARK_BACKUP_PW';
-- SEC-FBR-02: sessions start read-only; pg_dump and the counts must still work.
ALTER ROLE ja_backup SET default_transaction_read_only = on;
REVOKE ALL ON DATABASE job_assistant FROM PUBLIC;
SQL
psql_owner >/dev/null <<SQL
CREATE SCHEMA pgboss;
CREATE TABLE pgboss.job (id bigserial primary key, name text, data jsonb);
CREATE TABLE public.resume_upload (id text primary key, original_filename text not null, storage_name text not null unique);
CREATE TABLE public.career_profile_version (id serial primary key, content text);
CREATE TABLE public.tailored_document (id text primary key, pdf_storage_name text not null, docx_storage_name text not null);
CREATE TABLE public.empty_table (id int);
INSERT INTO public.resume_upload VALUES ('r1', '$MARK_RESNAME', 'r1.pdf'), ('r2', 'cv.docx', 'r2.docx');
INSERT INTO public.career_profile_version (content) SELECT '$MARK_PROFILE ' || g FROM generate_series(1, 250) g;
INSERT INTO public.tailored_document VALUES ('d1', 'd1.pdf', 'd1.docx'), ('d2', '$MARK_DOCNAME', 'd2.docx');
INSERT INTO pgboss.job (name, data) SELECT 'expiry', jsonb_build_object('note', '$MARK_PROFILE') FROM generate_series(1, 7);
-- Shaped like 0017: two Candidates, a Candidate table and an installation table, RLS enabled and FORCED.
CREATE TABLE public.candidate (id uuid primary key, role text not null);
INSERT INTO public.candidate VALUES ('00000000-0000-4000-8000-00000000000a', 'operator'), ('00000000-0000-4000-8000-00000000000b', 'candidate');
CREATE TABLE public.application (id serial primary key, candidate_id uuid not null references public.candidate(id), role_title text);
INSERT INTO public.application (candidate_id, role_title) VALUES
  ('00000000-0000-4000-8000-00000000000a', '$MARK_PROFILE A'),
  ('00000000-0000-4000-8000-00000000000b', '$MARK_PROFILE B1'), ('00000000-0000-4000-8000-00000000000b', '$MARK_PROFILE B2');
ALTER TABLE public.application ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.application FORCE ROW LEVEL SECURITY;
CREATE POLICY application_candidate ON public.application FOR ALL
  USING (candidate_id = nullif(current_setting('eve.candidate_id', true), '')::uuid)
  WITH CHECK (candidate_id = nullif(current_setting('eve.candidate_id', true), '')::uuid);
CREATE TABLE public.access_request (id serial primary key, email text not null);
INSERT INTO public.access_request (email) VALUES ('marker-request@example.test');
ALTER TABLE public.access_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_request FORCE ROW LEVEL SECURITY;
CREATE POLICY access_request_installation ON public.access_request FOR ALL
  USING (current_setting('eve.scope', true) = 'installation') WITH CHECK (current_setting('eve.scope', true) = 'installation');
-- As migrate grants it (grantBackupAccess): connect, usage, select, default privileges.
GRANT CONNECT ON DATABASE job_assistant TO ja_backup;
GRANT USAGE ON SCHEMA public, pgboss TO ja_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public, pgboss TO ja_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public, pgboss TO ja_backup;
ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ja_backup;
ALTER DEFAULT PRIVILEGES GRANT SELECT ON SEQUENCES TO ja_backup;
SQL
SRC_TABLES=8 SRC_ROWS=267
# The reproduction (fix-backup-role): the owner role is bound by FORCE, so its pg_dump fails.
owner_dump_err="$(docker exec -e PGPASSWORD="$MARK_PW" "$PG" pg_dump -Fc -U ja_owner -d job_assistant 2>&1 >/dev/null)"; odrc=$?
check "control: pg_dump as the owner role fails on the forced-RLS tables (the bug)" bash -c '[[ $1 != 0 && $2 == *"row-level security policy"* ]]' _ "$odrc" "$owner_dump_err"
check "control: the owner role sees no Candidate or installation rows without a scope" test "$(psql_owner -c "select (select count(*) from application) + (select count(*) from access_request)")" = 0
check "the backup role reads every row of the forced-RLS tables, for both Candidates" \
  test "$(psql_backup -c "select string_agg(n::text, ',' order by n) from (select count(*) n from application group by candidate_id) s")|$(psql_backup -c "select count(*) from access_request")" = "1,2|1"
backup_cannot_write() {
  ! psql_backup -c "insert into access_request (email) values ('x@example.test')" >/dev/null 2>&1 &&
    ! psql_backup -c "update application set role_title = 'x'" >/dev/null 2>&1 &&
    ! psql_backup -c "delete from application" >/dev/null 2>&1 &&
    test "$(psql_boot -c "select count(*) from application")" = 3
}
check "the backup role cannot write (insert, update, delete refused; rows unchanged)" backup_cannot_write
check "SEC-FBR-02: the backup role's sessions start read-only" test "$(psql_backup -c "show default_transaction_read_only")" = on


# Fake volumes shaped like the api's: node-owned (1000), directories 0700, files 0600.
docker volume create --label "com.docker.compose.project=$PROJECT" "$DOC_VOL" >/dev/null
docker volume create --label "com.docker.compose.project=$PROJECT" "$RES_VOL" >/dev/null
docker run --rm --network none -e MD="$MARK_DOCNAME" -e MP="$MARK_PROFILE" -v "$DOC_VOL:/d" -v "$RES_VOL:/r" --entrypoint sh postgres:17-alpine -c '
  set -e
  for n in d1.pdf d1.docx "$MD" d2.docx orphan.pdf; do printf "%s fake document %s\n" "$MP" "$n" >"/d/$n"; done
  mkdir -p "/d/nested dir/deeper" && echo nested >"/d/nested dir/deeper/a file.txt"
  ln -s d1.pdf /d/link-not-counted
  for n in r1.pdf r2.docx; do printf "%s fake resume\n" "$MP" >"/r/$n"; done
  chown -R 1000:1000 /d /r; find /d /r -type d -exec chmod 700 {} +; find /d /r -type f -exec chmod 600 {} +' >/dev/null
SRC_DOCS=6 SRC_RES=2

B="$T/backups"
env_file "$T/test.env" "$RECIPIENT" "$B"
# A leftover from an old killed run and an old complete set: retention must clean both.
mkdir -p "$B" && chmod 700 "$B"
for k in db:dump documents:tar resumes:tar; do echo old >"$B/eve-${k%%:*}-20200101T010000Z.${k#*:}.age"; done
echo old >"$B/eve-documents-20200102T010000Z.tar.age.partial"
echo keep >"$B/my-notes.txt"

run_backup() { # run_backup OUTFILE [args...]; returns the exit code
  local outf="$1"; shift
  env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/backup.sh" --env-file "$T/test.env" "$@" >"$outf" 2>&1
}
# The folder already exists here (it holds the old files); creation is tested below.
run_backup "$T/run1.out" --nightly; rc=$?
check "nightly backup exits 0" test "$rc" = 0
SET1="$(sed -nE 's/.* status=ok set=([0-9]{8}T[0-9]{6}Z) .*/\1/p' "$T/run1.out" | tail -n 1)"
check "a status=ok line names the set" test -n "$SET1"
check "pre-A2 (no candidates volume): the candidates step is skipped and no candidates file is written" bash -c 'grep -q "step=candidates status=skipped reason=no-volume" "$1" && [[ ! -e "$2" ]]' _ "$T/run1.out" "$B/eve-candidates-$SET1.tar.age"
check "three encrypted files exist with the UTC set name" test -s "$B/eve-db-$SET1.dump.age" -a -s "$B/eve-documents-$SET1.tar.age" -a -s "$B/eve-resumes-$SET1.tar.age"
modes_ok=1
for f in "$B"/eve-*-"$SET1".*.age "$B/backup.log"; do [[ "$(mode_of "$f")" == 600 ]] || modes_ok=0; [[ -O "$f" ]] || modes_ok=0; done
check "backup files and backup.log are 0600 and owned by the runner" test "$modes_ok" = 1
check "BACKUP_DIR is 0700" test "$(mode_of "$B")" = 700
check "no *.partial, lock or work dir is left behind" bash -c '! ls -A "$1" | grep -q -e "\.partial$" -e "^\.backup\.lock$" -e "^\.work\."' _ "$B"
check "old set (2020) and the leftover partial were deleted; unrelated file kept" bash -c '! ls "$1" | grep -q 20200 && test -f "$1/my-notes.txt"' _ "$B"
check "status line reports deleted=4" grep -q " status=ok .* deleted=4 " "$T/run1.out"
check "every encrypted file starts with the age header (no plaintext on disk)" bash -c 'for f in "$1"/eve-*-"$2".*.age; do head -c 21 "$f" | grep -q "age-encryption.org/v1" || exit 1; done' _ "$B" "$SET1"
check "the dump cannot be decrypted with a different key" bash -c '! age -d -i "$1" "$2" >/dev/null 2>&1' _ "$OTHER_KEY" "$B/eve-db-$SET1.dump.age"
list="$(age -d -i "$KEY" "$B/eve-db-$SET1.dump.age" | docker exec -i "$PG" pg_restore --list 2>/dev/null)"; lrc=$?
check "pg_restore --list succeeds on the decrypted dump" test "$lrc" = 0 -a -n "$list"
check "the dump includes the pgboss schema" test "$(printf '%s\n' "$list" | grep -c 'SCHEMA - pgboss')" -ge 1
check "the dump holds objects owned by ja_owner (the run logs in as the backup role with its password; see the wrong-password test)" test "$(printf '%s\n' "$list" | grep -c 'TABLE public resume_upload ja_owner')" = 1
check "the dump keeps the RLS setup: both policies and both ROW SECURITY entries" \
  bash -c '[[ $(grep -c -e "POLICY public application application_candidate" -e "POLICY public access_request access_request_installation" <<<"$1") == 2 && $(grep -c "ROW SECURITY" <<<"$1") -ge 2 ]]' _ "$list"
rls_rows_in_dump() { age -d -i "$KEY" "$B/eve-db-$SET1.dump.age" | docker exec -i "$PG" pg_restore -a -t application -t access_request -f - 2>/dev/null | grep -cE '^[0-9]+[[:space:]]'; }
check "the dump holds every forced-RLS row (3 application + 1 access_request COPY lines)" test "$(rls_rows_in_dump)" = 4
docn="$(age -d -i "$KEY" "$B/eve-documents-$SET1.tar.age" | tar -tvf - | grep -c '^-')"
resn="$(age -d -i "$KEY" "$B/eve-resumes-$SET1.tar.age" | tar -tvf - | grep -c '^-')"
check "documents archive holds exactly the volume's regular files ($SRC_DOCS)" test "$docn" = "$SRC_DOCS"
check "resumes archive holds exactly the volume's regular files ($SRC_RES)" test "$resn" = "$SRC_RES"
check "the log reports the same file counts and table/row totals" grep -q " status=ok set=$SET1 .* documents_files=$SRC_DOCS resumes_files=$SRC_RES tables=$SRC_TABLES rows=$SRC_ROWS " "$B/backup.log"
check "archives keep relative paths (nested dir with spaces)" bash -c 'age -d -i "$1" "$2" | tar -tf - | grep -qx "./nested dir/deeper/a file.txt"' _ "$KEY" "$B/eve-documents-$SET1.tar.age"
check "the database step is logged before the documents and resumes steps" bash -c 'grep -n "step=" "$1" | grep -E "step=(db|documents|resumes) status=done" | cut -d" " -f4 | tr "\n" " " | grep -q "step=db step=documents step=resumes"' _ "$T/run1.out"
check "log and stdout lines are the same" bash -c 'diff <(grep "set=$2\| step=db\| step=candidates\| step=documents\| step=resumes" "$1/backup.log" | tail -n 5) <(tail -n 5 "$3") >/dev/null' _ "$B" "$SET1" "$T/run1.out"
check "log scrub: no password, URL, recipient, identity, profile text or file names in log or stdout" no_markers "$B/backup.log" "$T/run1.out"
check "log lines hold only whitelisted fields" bash -c '! grep -vE "^[0-9TZ:-]+ eve-backup mode=(nightly|on-demand)( (step|status|set|reason|seconds|bytes|tables|rows|counts|files|db_bytes|documents_bytes|resumes_bytes|documents_files|resumes_files|candidates_bytes|candidates_files|deleted)=[A-Za-z0-9_.-]+)+$" "$1"' _ "$B/backup.log"

# Status check (B.12).
st="$(env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/backup-status.sh" --backup-dir "$B" --env-file /dev/null)"; src=$?
check "backup-status: fresh after a run, exit 0, prints the last result line" bash -c '[[ $1 == 0 && $2 == *"status=ok set="* && $2 == *"fresh=yes"* ]]' _ "$src" "$st"
S="$T/stale" && mkdir -p "$S" && grep " status=ok " "$B/backup.log" | tail -n 1 | sed -E "s/^[^ ]+/$(date -u -v-27H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '27 hours ago' +%Y-%m-%dT%H:%M:%SZ)/" >"$S/backup.log"
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/backup-status.sh" --backup-dir "$S" --env-file /dev/null >"$T/stale.out"; src=$?
check "backup-status: last ok 27 h ago is stale (exit 1, fresh=no)" bash -c '[[ $1 == 1 ]] && grep -q "fresh=no last_ok_hours=27 max_hours=26" "$2"' _ "$src" "$T/stale.out"
grep " status=ok " "$B/backup.log" | tail -n 1 | sed -E "s/^[^ ]+/$(date -u -v-25H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '25 hours ago' +%Y-%m-%dT%H:%M:%SZ)/" >"$S/backup.log"
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/backup-status.sh" --backup-dir "$S" --env-file /dev/null >/dev/null; src=$?
check "backup-status: last ok 25 h ago is fresh (exit 0)" test "$src" = 0

# Folder creation with 0700 when missing.
B2="$T/new/nested/backups"
env_file "$T/test2.env" "$RECIPIENT" "$B2"
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/backup.sh" --env-file "$T/test2.env" >"$T/run2.out" 2>&1; rc=$?
check "on-demand backup into a missing folder: exit 0, folder created 0700" test "$rc" = 0 -a "$(mode_of "$B2" 2>/dev/null)" = 700
check "on-demand runs log mode=on-demand" grep -q "mode=on-demand status=ok" "$B2/backup.log"

# Default BACKUP_DIR is ~/eve-backups (HOME pointed at a temp dir).
HOMET="$T/home" && mkdir -p "$HOMET"
env_file "$T/test3.env" "$RECIPIENT" ""
env -i PATH="$PATH" HOME="$HOMET" bash "$SCRIPTS/backup.sh" --env-file "$T/test3.env" >/dev/null 2>&1; rc=$?
check "unset BACKUP_DIR defaults to ~/eve-backups" test "$rc" = 0 -a -f "$HOMET/eve-backups/backup.log"

# Lock (B.8). The lock is a file holding the pid of a running backup.sh (SEC-B-05).
bash -c 'exec -a backup.sh sleep 60' & HOLDER=$!
sleep 0.2
mkdir "$B/.backup.lock" && echo "$HOLDER" >"$B/.backup.lock/pid"
before="$(ls "$B" | grep -c '\.age$')"
run_backup "$T/lock.out"; rc=$?
check "a held lock refuses the run: exit 3, step=lock reason=busy, nothing written" bash -c '[[ $1 == 3 ]] && grep -q "status=failed step=lock reason=busy" "$2" && [[ $(ls "$3" | grep -c "\.age$") == $4 ]]' _ "$rc" "$T/lock.out" "$B" "$before"
check "the refused run leaves the other run's lock in place" bash -c '[[ $(cat "$1/.backup.lock/pid") == $2 ]]' _ "$B" "$HOLDER"
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
echo 999999 >"$B/.backup.lock/pid"
run_backup "$T/stale-lock.out"; rc=$?
check "a stale lock (dead pid) is taken over: exit 0" test "$rc" = 0
rm -rf "$B/.backup.lock"
# Two runs at once: start one, wait until it holds the lock, start the second.
( run_backup "$T/conc1.out"; echo $? >"$T/conc1.rc" ) &
for _ in $(seq 100); do [[ -s "$B/.backup.lock/pid" ]] && break; sleep 0.05; done
run_backup "$T/conc2.out"; echo $? >"$T/conc2.rc"
wait
check "concurrent runs: the first succeeds, the second refuses with exit 3" test "$(cat "$T/conc1.rc") $(cat "$T/conc2.rc")" = "0 3"

# Failures: exit non-zero, one status=failed line, no partials, nothing deleted.
count_age() { ls "$B" | grep -c '\.age$'; }
before="$(count_age)"
env_file "$T/badpw.env" "$RECIPIENT" "$B" "wrong-$MARK_BACKUP_PW"
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/backup.sh" --env-file "$T/badpw.env" >"$T/badpw.out" 2>&1; rc=$?
check "wrong backup password: exit 1, step=db, no new files, no partials" bash -c '[[ $1 == 1 ]] && grep -q "status=failed step=db reason=" "$2" && [[ $(ls "$3" | grep -c "\.age$") == $4 ]] && ! ls -A "$3" | grep -q partial' _ "$rc" "$T/badpw.out" "$B" "$before"
check "the failed run never prints the password it tried" no_markers "$T/badpw.out" "$B/backup.log"
sed -i.bak "s/^BACKUP_RESUME_VOLUME=.*/BACKUP_RESUME_VOLUME=${PROJECT}_missing/" "$T/test.env" && rm -f "$T/test.env.bak"
# An old set that retention would delete must survive a failed run.
for k in db:dump documents:tar resumes:tar; do echo old >"$B/eve-${k%%:*}-20200301T010000Z.${k#*:}.age"; done
run_backup "$T/novol.out"; rc=$?
check "missing resumes volume: exit 1, step=resumes reason=no-volume, the volume is not created" bash -c '[[ $1 == 1 ]] && grep -q "status=failed step=resumes reason=no-volume" "$2" && ! docker volume inspect "$3" >/dev/null 2>&1' _ "$rc" "$T/novol.out" "${PROJECT}_missing"
check "a failed run deletes nothing (old set kept) and leaves no partials" bash -c 'test -f "$1/eve-db-20200301T010000Z.dump.age" && ! ls -A "$1" | grep -q partial' _ "$B"
check "exactly one final status line per failed run" test "$(grep -c 'status=failed' "$T/novol.out")" = 1
sed -i.bak "s/^BACKUP_RESUME_VOLUME=.*/BACKUP_RESUME_VOLUME=$RES_VOL/" "$T/test.env" && rm -f "$T/test.env.bak"
sed -i.bak "s/^BACKUP_COMPOSE_PROJECT=.*/BACKUP_COMPOSE_PROJECT=${PROJECT}-absent/" "$T/test.env" && rm -f "$T/test.env.bak"
run_backup "$T/nopg.out"; rc=$?
check "stack down: exit 1, step=db reason=no-postgres" bash -c '[[ $1 == 1 ]] && grep -q "status=failed step=db reason=no-postgres" "$2"' _ "$rc" "$T/nopg.out"
sed -i.bak "s/^BACKUP_COMPOSE_PROJECT=.*/BACKUP_COMPOSE_PROJECT=$PROJECT/" "$T/test.env" && rm -f "$T/test.env.bak"
# Interrupt mid-run: the db step's partial must never look complete.
( run_backup "$T/kill.out" ) &
kpid=$!
for _ in $(seq 200); do ls "$B" | grep -q '\.partial$' && break; sleep 0.02; done
saw_partial="$(ls "$B" | grep -c '\.partial$' || true)"
pkill -TERM -P "$kpid" bash 2>/dev/null || true
wait "$kpid" 2>/dev/null
check "an interrupted run leaves no *.partial and no lock" bash -c '! ls -A "$1" | grep -q -e partial -e "^\.backup\.lock$"' _ "$B"
check "files are written as *.partial while their pipeline runs" test "$saw_partial" -ge 1
echo "# saw_partial=$saw_partial"

# ------------------------------------------- repair wave 1 (integration, red first)
echo "# integration: repair wave 1"
# SEC-B-01: every helper `docker run` uses --log-driver none. A wrapper records the
# docker CLI arguments (never values of -e, which are names only) and runs the real docker.
REAL_DOCKER="$(command -v docker)"
WRAP="$T/wrapbin"
mkdir -p "$WRAP"
cat >"$WRAP/docker" <<EOF
#!/bin/sh
if [ "\$1" = run ]; then printf '%s\n' "\$*" | tr '\n' ' ' >>"$T/docker-run.args"; echo >>"$T/docker-run.args"; fi
exec "$REAL_DOCKER" "\$@"
EOF
cat >"$WRAP/age" <<EOF
#!/bin/sh
# SEC-B-03 probe: record whether age ever sees PGPASSWORD (yes/no only, never the value).
if [ -n "\${PGPASSWORD+x}" ]; then echo yes >>"$T/age-pgpassword.seen"; else echo no >>"$T/age-pgpassword.seen"; fi
exec "$(command -v age)" "\$@"
EOF
chmod 755 "$WRAP/docker" "$WRAP/age"
rm -f "$T/docker-run.args" "$T/age-pgpassword.seen"
env -i PATH="$WRAP:$PATH" HOME="$TEST_HOME" bash "$SCRIPTS/backup.sh" --env-file "$T/test.env" >"$T/wrap.out" 2>&1; rc=$?
check "wrapped backup run exits 0" test "$rc" = 0
check "SEC-B-01: both helper docker run calls in backup.sh pass --log-driver none" \
  bash -c '[[ $(grep -c . "$1") == 2 ]] && [[ $(grep -c -- "--log-driver none" "$1") == 2 ]]' _ "$T/docker-run.args"
check "SEC-B-03: age never sees PGPASSWORD in its environment" bash -c 'grep -q no "$1" && ! grep -q yes "$1"' _ "$T/age-pgpassword.seen"
# Direct probe of the daemon: the exact helper flags keep the plaintext out of docker logs,
# while the same container without the flag would have logged it (the test can detect a leak).
probe() { # probe NAME [extra docker args]: runs the archive snippet over the seeded docs volume, prints docker logs
  local name="$1"; shift
  "$REAL_DOCKER" run --name "$name" "$@" -i --network none --read-only --tmpfs /tmp --cap-drop ALL --cap-add DAC_READ_SEARCH \
    -v "$DOC_VOL:/src:ro" --entrypoint sh postgres:17-alpine -c "$EVE_ARCHIVE_SH" </dev/null >/dev/null 2>&1
  "$REAL_DOCKER" logs "$name" 2>&1 || true
  "$REAL_DOCKER" rm -fv "$name" >/dev/null 2>&1 || true
}
probe "${PROJECT}-probe-default" >"$T/probe-default.log"
probe "${PROJECT}-probe-none" --log-driver none >"$T/probe-none.log"
check "control: without --log-driver none the daemon log holds the plaintext marker" grep -q -F "$MARK_PROFILE" "$T/probe-default.log"
check "SEC-B-01: with --log-driver none, docker logs of the helper holds no plaintext" bash -c '! grep -q -F "$1" "$2" && ! grep -q -F "$3" "$2"' _ "$MARK_PROFILE" "$T/probe-none.log" "$MARK_DOCNAME"
rm -f "$T/probe-default.log"
# restore.sh helpers too (hygiene): run a restore through the wrapper.
rm -f "$T/docker-run.args"
"${DRILL_COMPOSE[@]}" up -d --wait >/dev/null 2>&1
eve_wait_pg "$DRILL_PROJECT" job_assistant postgres || echo "# drill postgres not ready"
WSET="$(sed -nE 's/.* status=ok set=([0-9]{8}T[0-9]{6}Z) .*/\1/p' "$T/wrap.out" | tail -n 1)"
env -i PATH="$WRAP:$PATH" HOME="$TEST_HOME" bash "$SCRIPTS/restore.sh" --env-file /dev/null --identity "$KEY" --target-project "$DRILL_PROJECT" --target-db-user postgres \
  --set "$WSET" --backup-dir "$B" --documents-volume "${DRILL_PROJECT}_w1" --resumes-volume "${DRILL_PROJECT}_w2" >"$T/wrap-restore.out" 2>&1; rc=$?
check "wrapped restore exits 0" test "$rc" = 0
check "every docker run in restore.sh passes --log-driver none" bash -c '[[ $(grep -c . "$1") -ge 4 ]] && ! grep -v -- "--log-driver none" "$1" | grep -q .' _ "$T/docker-run.args"
check "F-QA-25: every docker run in restore.sh mounts a tmpfs at the helper image's VOLUME path" bash -c '[[ $(grep -c . "$1") -ge 4 ]] && ! grep -v -- "--tmpfs /var/lib/postgresql/data" "$1" | grep -q .' _ "$T/docker-run.args"
"${DRILL_COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1
docker volume rm -f "${DRILL_PROJECT}_w1" "${DRILL_PROJECT}_w2" >/dev/null 2>&1 || true

# SEC-B-02: a BACKUP_DIR with spaces and a '*'. Failing and interrupted runs must not
# remove anything outside the folder (cron runs from the repo root).
SB="$T/bk a * b"
DECOY="$T/decoy cwd"
mkdir -p "$DECOY" && for n in keep1 keep2 "keep 3" b a; do echo d >"$DECOY/$n"; done
# Files (not folders) named after the path's words: a folder would make the old `rm` fail
# under set -e and stop the loop before it reached '*', hiding the bug.
echo d >"$T/bk" && echo d >"$T/a"
env_file "$T/glob.env" "$RECIPIENT" "$SB"
(cd "$DECOY" && env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/backup.sh" --env-file "$T/glob.env" >"$T/glob-ok.out" 2>&1); rc=$?
check "backup into 'bk a * b' succeeds" bash -c '[[ $1 == 0 ]] && ls "$2" | grep -c "\.age$" | grep -qx 3' _ "$rc" "$SB"
sed -i.bak "s/^BACKUP_RESUME_VOLUME=.*/BACKUP_RESUME_VOLUME=${PROJECT}_missing/" "$T/glob.env" && rm -f "$T/glob.env.bak"
(cd "$DECOY" && env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/backup.sh" --env-file "$T/glob.env" >"$T/glob-fail.out" 2>&1); rc=$?
check "failing run in 'bk a * b' exits 1 at step=resumes" bash -c '[[ $1 == 1 ]] && grep -q "step=resumes reason=no-volume" "$2"' _ "$rc" "$T/glob-fail.out"
check "SEC-B-02: after the failed run every decoy in the working directory survives" bash -c 'for n in keep1 keep2 "keep 3" a b; do [[ -f "$1/$n" ]] || exit 1; done' _ "$DECOY"
check "SEC-B-02: sibling files named after the path's words survive" test -f "$T/bk" -a -f "$T/a"
check "SEC-B-02: no .partial left in the spaced folder" bash -c '! ls -A "$1" | grep -q partial' _ "$SB"
# Control (after the checks, since it deletes $T/bk and $T/a): the dfb5e23 unquoted loop over
# this path deletes files in the working directory, so the checks above can fail.
mkdir -p "$T/control cwd" && echo d >"$T/control cwd/victim"
(cd "$T/control cwd" && RUN_PARTIALS=" $SB/eve-db-x.dump.age.partial" bash -c 'for p in $RUN_PARTIALS; do rm -f -- "$p"; done')
check "control: the dfb5e23 unquoted cleanup loop over 'bk a * b' would delete a file in the working directory" test ! -e "$T/control cwd/victim"
sed -i.bak "s/^BACKUP_RESUME_VOLUME=.*/BACKUP_RESUME_VOLUME=$RES_VOL/" "$T/glob.env" && rm -f "$T/glob.env.bak"
( cd "$DECOY" && exec env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/backup.sh" --env-file "$T/glob.env" >"$T/glob-kill.out" 2>&1 ) &
kpid=$!
for _ in $(seq 300); do ls "$SB" | grep -q '\.partial$' && break; sleep 0.02; done
kill -TERM "$kpid" 2>/dev/null; wait "$kpid" 2>/dev/null
check "SEC-B-02: an interrupted run in the spaced folder removes its partial and keeps the decoys" \
  bash -c '! ls -A "$1" | grep -q -e partial -e "^\.backup\.lock$" && [[ $(ls "$2" | grep -c .) == 5 ]]' _ "$SB" "$DECOY"

# SEC-B-04: the drill refuses to tear down a project it did not create.
docker volume create "${PROJECT}-foreign_documents" >/dev/null
echo keep | docker run --rm -i --log-driver none -v "${PROJECT}-foreign_documents:/v" --entrypoint sh postgres:17-alpine -c 'cat >/v/f' >/dev/null
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$B" --project "${PROJECT}-foreign" --env-file /dev/null >"$T/drill-foreign.out" 2>&1; rc=$?
check "SEC-B-04: drill refuses a project whose volume it did not label (exit 2), and the volume and its data survive" \
  bash -c '[[ $1 == 2 ]] && grep -q "reason=foreign-project" "$2" && docker run --rm --log-driver none -v "$3-foreign_documents:/v" --entrypoint cat postgres:17-alpine /v/f | grep -qx keep' _ "$rc" "$T/drill-foreign.out" "$PROJECT"
docker volume rm -f "${PROJECT}-foreign_documents" >/dev/null 2>&1

# F-QA-B-02: a dead run's .work dir and helper container are cleaned up under the lock.
mkdir -p "$B/.work.deadrun" && echo "EVECOUNTS tables=1 rows=1 counts=0000000000000000" >"$B/.work.deadrun/db.err"
DIRKEY="$(eve_dir_key "$B")"
docker create --name "${PROJECT}-deadhelper" --label eve.backup.helper=1 --label "eve.backup.dir=$DIRKEY" \
  -v "$DOC_VOL:/src:ro" --entrypoint true postgres:17-alpine >/dev/null
docker create --name "${PROJECT}-otherhelper" --label eve.backup.helper=1 --label "eve.backup.dir=someotherdir" \
  --entrypoint true postgres:17-alpine >/dev/null
mkdir "$B/.backup.lock" && echo 999999 >"$B/.backup.lock/pid"
run_backup "$T/takeover.out"; rc=$?
check "F-QA-B-02: the run after a dead one exits 0" test "$rc" = 0
check "F-QA-B-02: the dead run's .work dir is removed" test ! -e "$B/.work.deadrun"
check "F-QA-B-02: the dead run's helper container for this BACKUP_DIR is removed" bash -c '! docker inspect "$1" >/dev/null 2>&1' _ "${PROJECT}-deadhelper"
check "F-QA-B-02: a helper container labelled for another BACKUP_DIR is left alone" docker inspect "${PROJECT}-otherhelper"
docker rm -fv "${PROJECT}-otherhelper" >/dev/null 2>&1
check "helper containers of a finished run are gone" bash -c '[[ -z $(docker ps -aq --filter label=eve.backup.helper=1 --filter "label=eve.backup.dir=$1") ]]' _ "$DIRKEY"

# Restore drill (B.10): isolated postgres and volumes, counts and references.
LATEST="$(sed -nE 's/.* status=ok set=([0-9]{8}T[0-9]{6}Z) .*/\1/p' "$B/backup.log" | tail -n 1)"
DANGLING0="$(docker volume ls -qf dangling=true -f label=com.docker.volume.anonymous | sort)"
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$B" --project "$DRILL_PROJECT" --env-file /dev/null >"$T/drill.out" 2>&1; rc=$?
check "F-QA-25: a real drill leaves no new dangling anonymous volume" bash -c '[[ -z $(comm -13 <(printf "%s\n" "$1") <(docker volume ls -qf dangling=true -f label=com.docker.volume.anonymous | sort) | grep .) ]]' _ "$DANGLING0"
check "restore drill of the latest set exits 0" test "$rc" = 0
check "drill restored the newest status=ok set" grep -q "eve-drill status=ok set=$LATEST " "$T/drill.out"
check "drill: table count, row total and per-table digest matched backup.log" grep -q "eve-restore status=ok set=$LATEST verified=backup-log tables=$SRC_TABLES rows=$SRC_ROWS documents_files=$SRC_DOCS resumes_files=$SRC_RES " "$T/drill.out"
check "drill: every resume_upload and tailored_document row points at a restored file" grep -q "step=references resume_refs=2 resume_missing=0 document_refs=4 document_missing=0" "$T/drill.out"
check "drill removed its project and volumes" bash -c '[[ -z $(docker ps -aq --filter label=com.docker.compose.project=$1) ]] && ! docker volume inspect $1_documents >/dev/null 2>&1' _ "$DRILL_PROJECT"
check "drill output holds no markers, identity or recipient" no_markers "$T/drill.out"

# Negative drill: a row that points at a missing file must fail the check.
psql_owner -c "INSERT INTO public.resume_upload VALUES ('r3', 'x.pdf', 'r3-missing.pdf')" >/dev/null
run_backup "$T/run-dangling.out"; rc=$?
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$B" --project "$DRILL_PROJECT" --env-file /dev/null >"$T/drill-bad.out" 2>&1; rc2=$?
check "drill fails (exit 1) when a résumé row points at a file missing from the backup" bash -c '[[ $1 == 0 && $2 == 1 ]] && grep -q "resume_missing=1" "$3" && grep -q "reason=mismatch,resume-files-missing" "$3"' _ "$rc" "$rc2" "$T/drill-bad.out"
psql_owner -c "DELETE FROM public.resume_upload WHERE id = 'r3'" >/dev/null

# Count mismatch: a backup.log line that disagrees with the restored data must fail.
cp "$B/backup.log" "$T/backup.log.orig"
sed -i.bak -E "/ status=ok set=$LATEST /s/ rows=$SRC_ROWS / rows=$((SRC_ROWS + 1)) /" "$B/backup.log" && rm -f "$B/backup.log.bak"
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$B" --set "$LATEST" --project "$DRILL_PROJECT" --env-file /dev/null >"$T/drill-rows.out" 2>&1; rc=$?
check "restore fails when the restored row total differs from backup.log" bash -c '[[ $1 == 1 ]] && grep -q "reason=mismatch,rows" "$2"' _ "$rc" "$T/drill-rows.out"
cp "$T/backup.log.orig" "$B/backup.log"

# Restore into host directories (volume-free path) with explicit files.
mkdir -p "$T/rd" "$T/rr"
"${DRILL_COMPOSE[@]}" up -d --wait >/dev/null 2>&1
eve_wait_pg "$DRILL_PROJECT" job_assistant postgres || echo "# drill postgres not ready"
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/restore.sh" --identity "$KEY" --target-project "$DRILL_PROJECT" --target-db-user postgres \
  --db "$B/eve-db-$LATEST.dump.age" --documents "$B/eve-documents-$LATEST.tar.age" --resumes "$B/eve-resumes-$LATEST.tar.age" --backup-dir "$B" \
  --documents-dir "$T/rd" --resumes-dir "$T/rr" >"$T/restore-dirs.out" 2>&1; rc=$?
check "restore with file paths into empty host directories exits 0 and verifies" bash -c '[[ $1 == 0 ]] && grep -q "status=ok .* verified=backup-log" "$2"' _ "$rc" "$T/restore-dirs.out"
check "restored document bytes equal the source" bash -c 'grep -q "fake document d1.pdf" "$1/d1.pdf"' _ "$T/rd"
DPG="$(eve_pg_container "$DRILL_PROJECT")"
check "round trip: the restored forced-RLS table has both Candidates' rows (1 and 2), still FORCE ROW LEVEL SECURITY" \
  test "$(docker exec "$DPG" psql -X -q -At -U postgres -d job_assistant -c "select (select string_agg(n::text, ',' order by n) from (select count(*) n from application group by candidate_id) s) || '|' || (select count(*) from access_request) || '|' || (select bool_and(relforcerowsecurity)::text from pg_class where relname in ('application', 'access_request'))")" = "1,2|1|true"
# A target user bound by the policies would count 0 rows and pass a references check on nothing.
docker exec "$DPG" psql -X -q -U postgres -d job_assistant -c "CREATE ROLE drill_owner LOGIN" >/dev/null 2>&1
docker exec "$DPG" psql -X -q -U postgres -d job_assistant -c "CREATE DATABASE drill_owner_db OWNER drill_owner" >/dev/null 2>&1
mkdir -p "$T/rd2" "$T/rr2"
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/restore.sh" --identity "$KEY" --target-project "$DRILL_PROJECT" --target-db drill_owner_db --target-db-user drill_owner --set "$LATEST" --backup-dir "$B" \
  --documents-dir "$T/rd2" --resumes-dir "$T/rr2" >"$T/restore-owner.out" 2>&1; rc=$?
check "restore as a role bound by RLS (an owner without BYPASSRLS) fails with reason=rls-hides-rows, never a false ok" \
  bash -c '[[ $1 == 1 ]] && grep -q "status=failed step=db reason=rls-hides-rows" "$2" && ! grep -q "status=ok" "$2"' _ "$rc" "$T/restore-owner.out"
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/restore.sh" --identity "$KEY" --target-project "$DRILL_PROJECT" --target-db-user postgres --set "$LATEST" --backup-dir "$B" \
  --documents-volume "${DRILL_PROJECT}_x1" --resumes-volume "${DRILL_PROJECT}_x2" >"$T/restore-again.out" 2>&1; rc=$?
check "restore refuses a target database that already has tables" bash -c '[[ $1 == 1 ]] && grep -q "reason=target-db-not-empty" "$2"' _ "$rc" "$T/restore-again.out"
check "restore outputs hold no markers" no_markers "$T/restore-dirs.out" "$T/restore-owner.out" "$T/restore-again.out" "$T/drill-bad.out" "$T/drill-rows.out"
"${DRILL_COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1
docker volume rm -f "${DRILL_PROJECT}_x1" "${DRILL_PROJECT}_x2" >/dev/null 2>&1 || true

# ------------------------------------- EPIC-0002 A2: per-Candidate candidates volume
echo "# integration: EPIC-0002 A2 candidates volume"
# After storage:migrate: rows carry candidate_id, files live at <id>/{resumes,documents}/<name>
# in the candidates volume, and the flat volumes are empty.
C1="11111111-1111-4111-8111-111111111111" C2="22222222-2222-4222-8222-222222222222"
psql_owner >/dev/null <<SQL
ALTER TABLE public.resume_upload ADD COLUMN candidate_id uuid;
ALTER TABLE public.tailored_document ADD COLUMN candidate_id uuid;
UPDATE public.resume_upload SET candidate_id = CASE id WHEN 'r1' THEN '$C1'::uuid ELSE '$C2'::uuid END;
UPDATE public.tailored_document SET candidate_id = CASE id WHEN 'd1' THEN '$C1'::uuid ELSE '$C2'::uuid END;
SQL
for v in "$CAND_VOL" "$A2_DOC_VOL" "$A2_RES_VOL"; do docker volume create --label "com.docker.compose.project=$PROJECT" "$v" >/dev/null; done
docker run --rm --network none -e MD="$MARK_DOCNAME" -e MP="$MARK_PROFILE" -e C1="$C1" -e C2="$C2" -v "$CAND_VOL:/c" --entrypoint sh postgres:17-alpine -c '
  set -e
  mkdir -p "/c/$C1/resumes" "/c/$C1/documents" "/c/$C1/exports" "/c/$C2/resumes" "/c/$C2/documents"
  printf "%s r\n" "$MP" >"/c/$C1/resumes/r1.pdf"; printf "%s r\n" "$MP" >"/c/$C2/resumes/r2.docx"
  for n in d1.pdf d1.docx; do printf "%s d %s\n" "$MP" "$n" >"/c/$C1/documents/$n"; done
  for n in "$MD" d2.docx; do printf "%s d %s\n" "$MP" "$n" >"/c/$C2/documents/$n"; done
  printf "{\"version\":1}" >/c/.storage-migrated
  chown -R 1000:1000 /c; find /c -type d -exec chmod 700 {} +; find /c -type f -exec chmod 600 {} +' >/dev/null
CAND_FILES=7
# Migration 0022 (run a2e repair wave 1, F-DEV-01): the owner-only binding schema with its
# unlogged table, as migrate grants it (backup role: USAGE and SELECT; nobody else).
psql_owner >/dev/null <<SQL
CREATE SCHEMA tenant_binding;
REVOKE ALL ON SCHEMA tenant_binding FROM PUBLIC;
CREATE UNLOGGED TABLE tenant_binding.candidate_binding (xact xid8 primary key, candidate_id uuid not null);
REVOKE ALL ON TABLE tenant_binding.candidate_binding FROM PUBLIC;
INSERT INTO tenant_binding.candidate_binding VALUES ('1', '$C1'::uuid), ('2', '$C2'::uuid);
GRANT USAGE ON SCHEMA tenant_binding TO ja_backup;
GRANT SELECT ON tenant_binding.candidate_binding TO ja_backup;
SQL
env_file "$T/a2.env" "$RECIPIENT" "$B"
sed -i.bak -e "s/^BACKUP_DOCUMENT_VOLUME=.*/BACKUP_DOCUMENT_VOLUME=$A2_DOC_VOL/" -e "s/^BACKUP_RESUME_VOLUME=.*/BACKUP_RESUME_VOLUME=$A2_RES_VOL/" "$T/a2.env" && rm -f "$T/a2.env.bak"
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/backup.sh" --env-file "$T/a2.env" >"$T/a2-run.out" 2>&1; rc=$?
A2SET="$(sed -nE 's/.* status=ok set=([0-9]{8}T[0-9]{6}Z) .*/\1/p' "$T/a2-run.out" | tail -n 1)"
check "A2: backup with the candidates volume exits 0" test "$rc" = 0 -a -n "$A2SET"
check "A2: four encrypted files; the candidates archive has the age header and mode 0600" \
  bash -c 'f="$1/eve-candidates-$2.tar.age"; test -s "$f" && head -c 21 "$f" | grep -q "age-encryption.org/v1" && [[ $(ls "$1" | grep -c -- "-$2\.") == 4 ]] && [[ $(. "$3" && eve_mode "$f") == 600 ]]' _ "$B" "$A2SET" "$SCRIPTS/lib.sh"
check "A2: the candidates archive cannot be decrypted with a different key" bash -c '! age -d -i "$1" "$2" >/dev/null 2>&1' _ "$OTHER_KEY" "$B/eve-candidates-$A2SET.tar.age"
candn="$(age -d -i "$KEY" "$B/eve-candidates-$A2SET.tar.age" | tar -tvf - | grep -c '^-')"
check "A2: the candidates archive holds every regular file of the root ($CAND_FILES)" test "$candn" = "$CAND_FILES"
check "A2: the log line counts candidates files and still counts the (empty) flat volumes" grep -q " status=ok set=$A2SET .* documents_files=0 resumes_files=0 .* candidates_bytes=[0-9]* candidates_files=$CAND_FILES deleted=" "$B/backup.log"
a2list="$(age -d -i "$KEY" "$B/eve-db-$A2SET.dump.age" | docker exec -i "$PG" pg_restore --list 2>/dev/null)"
check "F-DEV-01: the dump keeps the binding table's definition but not its rows" \
  bash -c '[[ $1 == *"TABLE tenant_binding candidate_binding"* && $1 != *"TABLE DATA tenant_binding candidate_binding"* ]]' _ "$a2list"
a2counts="$(psql_backup -c "$EVE_COUNT_SQL")"
check "F-DEV-01: the per-table counts leave out the unlogged binding table and keep the logged ones" \
  bash -c '[[ $1 != *"tenant_binding."* && $1 == *"public.application=3"* ]]' _ "$a2counts"
check "A2: the candidates step runs after db and before documents and resumes" bash -c 'grep -E "step=(db|candidates|documents|resumes) status=done" "$1" | cut -d" " -f4 | tr "\n" " " | grep -q "step=db step=candidates step=documents step=resumes"' _ "$T/a2-run.out"
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/backup-status.sh" --backup-dir "$B" --env-file /dev/null >/dev/null; src=$?
check "A2: backup-status reads the longer status line (fresh, exit 0)" test "$src" = 0
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$B" --set "$A2SET" --project "$DRILL_PROJECT" --env-file /dev/null >"$T/a2-drill.out" 2>&1; rc=$?
check "A2: restore drill of the four-file set exits 0" test "$rc" = 0
check "A2: drill verified counts against backup.log, including candidates_files" grep -q "eve-restore status=ok set=$A2SET verified=backup-log .* documents_files=0 resumes_files=0 candidates_files=$CAND_FILES " "$T/a2-drill.out"
check "A2: every row resolves to <candidate_id>/<area>/<name> in the restored candidates volume" grep -q "step=references resume_refs=2 resume_missing=0 document_refs=4 document_missing=0" "$T/a2-drill.out"
check "A2: the drill removed its candidates volume" bash -c '! docker volume inspect "$1_candidates" >/dev/null 2>&1' _ "$DRILL_PROJECT"
# A row whose file is only in another Candidate's folder must not count as found.
psql_owner -c "UPDATE public.resume_upload SET candidate_id = '$C2'::uuid WHERE id = 'r1'" >/dev/null
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/backup.sh" --env-file "$T/a2.env" >"$T/a2-wrong.out" 2>&1
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$B" --project "$DRILL_PROJECT" --env-file /dev/null >"$T/a2-drill-wrong.out" 2>&1; rc=$?
check "A2: drill fails (exit 1) when a row's file sits under another Candidate's folder" bash -c '[[ $1 == 1 ]] && grep -q "resume_missing=1" "$2"' _ "$rc" "$T/a2-drill-wrong.out"
psql_owner -c "UPDATE public.resume_upload SET candidate_id = '$C1'::uuid WHERE id = 'r1'" >/dev/null
# A log line that counts candidates files without its archive must refuse, not restore a partial set.
mv "$B/eve-candidates-$A2SET.tar.age" "$T/held.age"
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$B" --set "$A2SET" --project "$DRILL_PROJECT" --env-file /dev/null >"$T/a2-drill-missing.out" 2>&1; rc=$?
check "A2: restore refuses (exit 2) a set whose log counts candidates files but whose archive is missing" bash -c '[[ $1 == 2 ]] && grep -q "reason=backup-file-missing" "$2"' _ "$rc" "$T/a2-drill-missing.out"
mv "$T/held.age" "$B/eve-candidates-$A2SET.tar.age"
# Backward compatibility: a pre-A2 three-file set still restores with the new drill.
env -i PATH="$PATH" HOME="$TEST_HOME" DOCKER_CONFIG="$DOCKER_CFG" bash "$SCRIPTS/restore-drill.sh" --identity "$KEY" --backup-dir "$B" --set "$LATEST" --project "$DRILL_PROJECT" --env-file /dev/null >"$T/a2-drill-old.out" 2>&1; rc=$?
check "A2: a pre-A2 three-file set still restores and verifies (candidates skipped, references found flat)" \
  bash -c '[[ $1 == 0 ]] && grep -q "step=candidates status=skipped reason=no-archive" "$2" && grep -q "eve-restore status=ok set=$3 verified=backup-log" "$2"' _ "$rc" "$T/a2-drill-old.out" "$LATEST"
check "A2: outputs hold no markers, identity or recipient" no_markers "$T"/a2-*.out

check "no backup run anywhere in this suite printed a marker" no_markers "$T"/*.out "$B/backup.log" "$B2/backup.log"

check "F-QA-25: the whole integration suite leaves no new dangling anonymous volume" bash -c '[[ -z $(comm -13 <(printf "%s\n" "$1") <(docker volume ls -qf dangling=true -f label=com.docker.volume.anonymous | sort) | grep .) ]]' _ "$SUITE_DANGLING0"
check "safety: the real ~/eve-backups listing is unchanged by the suite" test "$(real_backups_state)" = "$REAL_BACKUPS_BEFORE"
echo "1..$N"
echo "# pass=$PASS fail=$FAIL"
((FAIL == 0))
