#!/usr/bin/env bash
# Restore drill (docs/ops/backups.md, B.10). Starts a throwaway Postgres and
# three throwaway volumes (documents, resumes, candidates) in their own compose project, restores one backup set
# with restore.sh, checks it against backup.log and the file references, then
# removes the project with its volumes (unless --keep).
#
# Usage: restore-drill.sh --identity FILE [--set UTC_TS] [--backup-dir DIR]
#                         [--project NAME] [--env-file PATH] [--keep]
#        restore-drill.sh --cleanup NAME [--env-file PATH]
#   --set       defaults to the newest status=ok set in BACKUP_DIR/backup.log
#   --project   defaults to ja-ops-backup-drill; eve and job-assistant are refused
#   --keep      leave the drill project running for a look around; remove it afterwards
#               with restore-drill.sh --cleanup NAME
#   --cleanup   remove a kept or left-behind drill project NAME with the teardown below,
#               after the same name and ownership checks; starts nothing, needs no
#               identity. Last line "status=ok step=cleanup project=NAME" (exit 0) or
#               "status=failed step=cleanup reason=leftover left=..." (exit 1).
# Exit: (table in docs/ops/backups.md, "Every exit of the drill") 0 restored and verified;
#       restore.sh's code (1 or 2) after "status=failed set=... exit=N"; 1 the drill
#       database did not start (status=failed step=start, no exit=N line), or a
#       Docker call failed after step=start (no result line); 2 refused; 1 a bare
#       trailing option (no line); 0 --help; 129/130/131/143 stopped by HUP, INT,
#       QUIT or TERM (a closed terminal or SSH session, Ctrl-C, `kill PID`): the
#       running step (compose up, restore.sh and their children) is stopped at once
#       and waited for, then the drill tears down as below; a second signal is
#       ignored. No result line; the last line is whatever the step printed,
#       possibly a raw child error.
# Removal: nothing is ever removed before the ownership check has finished and found
# the project to be the drill's. Refusals (arguments, identity, project name, live
# project, database name, backup.log, compose-config, docker-unavailable,
# foreign-project) remove nothing and print no "kept" line, with or without --keep.
# compose-config: `docker compose config` of drill.compose.yml failed or listed no
# volume or no network, so the drill cannot know what its teardown would remove.
# foreign-project: a container of the project, a file volume, or a volume or network
# of the drill compose project (NAME_pgdata, NAME_drill) exists without
# eve.backup.drill=1.
# Every exit after the check tears down: it first creates a stop flag, so restore.sh
# starts no new helper container, then removes every container of the project with
# its anonymous volumes (docker rm -fv; compose containers and restore.sh helpers
# labelled eve.backup.target-project=NAME, running or only created), repeating until
# none has appeared for 2 s (at most 30 s), then removes the project, its volumes and
# network, and checks nothing is left, including the helpers' anonymous volumes. It
# never removes a named volume other than the drill's own, nor any live volume
# (live-looking name, built-in, or BACKUP_*_VOLUME from .env) even if it carries the
# anonymous label; a failed anonymous-volume listing is reported as unverified. A
# leftover prints "status=failed step=teardown reason=leftover left=..." last and
# turns exit 0 into 1. After a signal the drill first waits (up to 10 s, then KILL)
# for every process of the stopped step, including each helper `docker run` CLI,
# which restore.sh records by PID (with its start time, so a reused PID is never
# signalled) because it can be reparented away from the step; restore.sh itself is
# waited for in the same bounded loop. Every process is signalled only while its start
# time still matches its snapshot. Processes KILLed after the bound are reported as
# "note=killed pids=N". Teardown also waits for any recorded CLI still running, and
# removes restore.sh's work dir (kept in the drill's private 0700 directory, so it is
# removed even if restore.sh was KILLed); a work dir it cannot remove is a leftover
# ("workdir:PATH"), also with --keep. The EXIT trap ignores
# further signals as its first command.
# With --keep it leaves them and prints "kept project=NAME" as the last line, also
# after a signal during compose up.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

IDENTITY="" SET_TS="" DIR_ARG="" PROJECT="ja-ops-backup-drill" KEEP=0 CLEANUP=0 ENV_FILE="$REPO_ROOT/.env"
say() { printf '%s eve-drill %s\n' "$(eve_now_iso)" "$*"; }
refuse() { say "status=refused reason=$1"; exit 2; }
while (($#)); do
  case "$1" in
    --identity) IDENTITY="${2:-}"; shift ;;
    --set) SET_TS="${2:-}"; shift ;;
    --backup-dir) DIR_ARG="${2:-}"; shift ;;
    --project) PROJECT="${2:-}"; shift ;;
    --env-file) ENV_FILE="${2:-}"; shift ;;
    --keep) KEEP=1 ;;
    --cleanup) CLEANUP=1; PROJECT="${2:-}"; shift ;;
    -h | --help) eve_print_help "$0"; exit 0 ;;
    *) refuse unknown-argument ;;
  esac
  shift
done

((CLEANUP)) || [[ -n "$IDENTITY" ]] || refuse no-identity
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || refuse bad-project
eve_load_env "$ENV_FILE"
unset DB_OWNER_PASSWORD DB_BACKUP_PASSWORD
# SEC-B-04: the drill deletes its project's volumes, so refuse every live-looking name.
eve_is_live_name "$PROJECT" && refuse live-project
eve_is_live_project "$PROJECT" && refuse live-project
[[ "$PROJECT" == "${BACKUP_COMPOSE_PROJECT:-eve}" ]] && refuse live-project
BACKUP_DIR="$(eve_expand_home "${DIR_ARG:-${BACKUP_DIR:-~/eve-backups}}")"
DB_NAME="${POSTGRES_DB:-job_assistant}"
[[ "$DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || refuse bad-db-name
if ((CLEANUP == 0)) && [[ -z "$SET_TS" ]]; then
  [[ -f "$BACKUP_DIR/backup.log" ]] || refuse no-backup-log
  SET_TS="$(grep -E ' status=ok set=[0-9]{8}T[0-9]{6}Z ' "$BACKUP_DIR/backup.log" | tail -n 1 | sed -E 's/.* status=ok set=([0-9]{8}T[0-9]{6}Z) .*/\1/' || true)"
  [[ -n "$SET_TS" ]] || refuse no-ok-set-in-log
fi

COMPOSE=(docker compose -p "$PROJECT" -f "$SCRIPT_DIR/drill.compose.yml")
export DRILL_DB="$DB_NAME"
# SEC-B-04, F-QA-19, F-SEC-18, F-SEC-19: never tear down a project the drill did not
# create. Every existing container of the project, and every existing volume and
# network the teardown can remove, must carry the drill label: the three file
# volumes plus each volume and network of the drill compose project, by the real
# names Compose resolves (`docker compose config`, so `name:` overrides and an
# implicit default network count). If Compose cannot report them, or reports no
# volume or no network, the drill refuses compose-config and removes nothing.
# check_ownership returns 0 owned (or absent), 1 foreign, 2 a Docker call failed.
CFG_VOLUMES="$(eve_compose_names "$PROJECT" "$SCRIPT_DIR/drill.compose.yml" volumes)" || refuse compose-config
CFG_NETWORKS="$(eve_compose_names "$PROJECT" "$SCRIPT_DIR/drill.compose.yml" networks)" || refuse compose-config
[[ -n "$CFG_VOLUMES" && -n "$CFG_NETWORKS" ]] || refuse compose-config
DRILL_VOLUMES="${PROJECT}_documents ${PROJECT}_resumes ${PROJECT}_candidates ${CFG_VOLUMES//$'\n'/ }"
DRILL_NETWORKS="${CFG_NETWORKS//$'\n'/ }"
check_labelled() { # check_labelled volume|network NAMES...: 0 all present ones labelled, 1 foreign, 2 Docker failed
  local kind="$1" have n label
  shift
  have="$(docker "$kind" ls --format '{{.Name}}' 2>/dev/null)" || return 2
  for n in "$@"; do
    grep -Fxq -- "$n" <<<"$have" || continue
    label="$(docker "$kind" inspect -f '{{index .Labels "eve.backup.drill"}}' "$n" 2>/dev/null)" || return 2
    [[ "$label" == 1 ]] || return 1
  done
  return 0
}
check_ownership() {
  local ids id label rc
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null)" || return 2
  for id in $ids; do
    label="$(docker inspect -f '{{index .Config.Labels "eve.backup.drill"}}' "$id" 2>/dev/null)" || return 2
    [[ "$label" == 1 ]] || return 1
  done
  rc=0
  # shellcheck disable=SC2086 # word-split lists of validated names
  check_labelled volume $DRILL_VOLUMES || rc=$?
  ((rc == 0)) || return "$rc"
  # shellcheck disable=SC2086
  check_labelled network $DRILL_NETWORKS || rc=$?
  return "$rc"
}
owned=0
check_ownership || owned=$?
((owned != 2)) || refuse docker-unavailable
((owned != 1)) || refuse foreign-project
# remove_project: removes every container of the drill (compose containers and the
# restore helpers that mount its volumes, created or running) with -v, then the
# compose project and all its volumes and networks. Helpers first: a volume in use by
# any container cannot be removed (F-QA-22, F-SEC-22). The anonymous volumes of
# removed helpers are remembered in HELPER_ANON so leftovers can check them (F-QA-25).
HELPER_ANON="" ANON_UNVERIFIED=0
# F-QA-24: the daemon can still create a helper for a `docker run` that was killed
# after it sent its request (observed up to 0.25 s later). So teardown's removal repeats until no
# labelled container has been seen for SETTLE seconds (bounded by SETTLE_MAX), and
# only then removes the volumes. The stop flag already keeps restore.sh from
# starting new helpers.
# The pre-start cleanup settles only when it found a container.
SETTLE="${EVE_DRILL_SETTLE:-2}" SETTLE_MAX="${EVE_DRILL_SETTLE_MAX:-30}"
labelled_ids() {
  docker ps -aq --filter "label=eve.backup.target-project=$PROJECT" 2>/dev/null
  docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null
}
remove_containers() { # removes every labelled container with -v; prints nothing
  local ids id m anon
  ids="$(labelled_ids)" || true
  [[ -n "${ids//[[:space:]]/}" ]] || return 0
  # F-SEC-27: only anonymous volumes (Docker's com.docker.volume.anonymous label) of
  # these containers are remembered for removal. A named volume that is not one of the
  # drill's own (DRILL_VOLUMES, ownership-checked) is never removed, whoever mounts it.
  # F-SEC-29 (b): a failed listing is remembered and reported as unverified.
  anon="$(docker volume ls -q --filter label=com.docker.volume.anonymous 2>/dev/null)" || { anon=""; ANON_UNVERIFIED=1; }
  for id in $ids; do
    for m in $(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$id" 2>/dev/null); do
      grep -Fxq -- "$m" <<<"$anon" || continue
      # F-SEC-29: the anonymous label can be set by anyone; never a live volume
      # (live-looking, built-in, or configured in .env), shared with restore.sh.
      eve_is_live_target_volume "$m" && continue
      case " $DRILL_VOLUMES $HELPER_ANON " in *" $m "*) ;; *) HELPER_ANON="$HELPER_ANON $m" ;; esac
    done
  done
  # shellcheck disable=SC2086 # container IDs
  docker rm -fv $ids >/dev/null 2>&1 || true
}
remove_project() { # remove_project [prestart]
  local quiet_since=$SECONDS start=$SECONDS settle="$SETTLE" quiet_checks=0
  if [[ "${1:-}" == prestart ]]; then
    [[ -n "$(labelled_ids | tr -d '[:space:]')" ]] || settle=0
  fi
  remove_containers
  # Quiet means no labelled container for SETTLE seconds AND for at least 4 checks:
  # under heavy load one check can take longer than the whole settle period, which
  # would otherwise end the loop after a single look (F-QA-27).
  while ((settle > 0 && SECONDS - start < SETTLE_MAX)) && ((SECONDS - quiet_since < settle || quiet_checks < 4)); do
    sleep 0.25
    if [[ -n "$(labelled_ids | tr -d '[:space:]')" ]]; then
      remove_containers
      quiet_since=$SECONDS quiet_checks=0
    else
      quiet_checks=$((quiet_checks + 1))
    fi
  done
  "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  # shellcheck disable=SC2086 # validated names
  docker volume rm -f $DRILL_VOLUMES $HELPER_ANON >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  docker network rm $DRILL_NETWORKS >/dev/null 2>&1 || true
}
# leftovers: prints every drill container, volume or network that still exists, or
# "unverified" if Docker cannot list them (never reported as clean by mistake).
# shellcheck disable=SC2329 # used by teardown (EXIT trap)
leftovers() {
  local have n
  ((ANON_UNVERIFIED == 0)) || echo "unverified:anonymous-volumes"
  have="$(docker ps -aq --filter "label=eve.backup.target-project=$PROJECT" 2>/dev/null &&
    docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null)" || { echo unverified; return 0; }
  for n in $have; do echo "container:$n"; done
  have="$(docker volume ls --format '{{.Name}}' 2>/dev/null)" || { echo unverified; return 0; }
  for n in $DRILL_VOLUMES $HELPER_ANON; do grep -Fxq -- "$n" <<<"$have" && echo "volume:$n"; done
  have="$(docker network ls --format '{{.Name}}' 2>/dev/null)" || { echo unverified; return 0; }
  for n in $DRILL_NETWORKS; do grep -Fxq -- "$n" <<<"$have" && echo "network:$n"; done
  return 0
}
# F-QA-24: the stop flag. restore.sh checks EVE_RESTORE_STOP_FILE right before each
# helper `docker run` and starts none once the file exists.
STOP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/eve-drill.XXXXXX")"
export EVE_RESTORE_STOP_FILE="$STOP_DIR/stop"
stop_flag() { : >"$EVE_RESTORE_STOP_FILE" 2>/dev/null || true; }
# F-SEC-24, F-SEC-26, F-SEC-28: restore.sh records each running helper `docker run`
# CLI in EVE_RESTORE_PID_DIR as "cli.<pid>" holding "<pid> <start time>", and removes
# the record when the CLI exits. The CLI can be reparented away from the step, so it
# is tracked by PID. A record counts only while that PID's current start time still
# matches the recorded one, so a reused PID (another process) is never signalled.
export EVE_RESTORE_PID_DIR="$STOP_DIR"
export EVE_RESTORE_WORK_PARENT="$STOP_DIR" # F-SEC-31: restore.sh's work dir lives here
cli_start() { eve_proc_start "$1"; } # shared with restore.sh's record (F-QA-26)
cli_snap() { # prints the recorded helper CLIs as snapshot lines "pid|start"
  local f p rec
  for f in "$STOP_DIR"/cli.*; do
    [[ -e "$f" ]] || continue
    rec="$(cat "$f" 2>/dev/null)" || continue
    p="${rec%% *}"
    [[ "$p" =~ ^[0-9]+$ ]] || continue
    rec="${rec#* }"
    rec="${rec%"${rec##*[![:space:]]}"}"
    printf '%s|%s\n' "$p" "$rec"
  done
  return 0
}
# shellcheck disable=SC2329 # kept as the documented selector (tests use it)
cli_pids() { snap_alive "$(cli_snap)"; } # recorded helper CLI PIDs whose start time still matches
# F-SEC-34: process snapshots. A PID is signalled only while its start time still
# matches the one recorded in the snapshot, so a PID reused by another process is
# never signalled. snapshot PIDS... prints "pid|start" lines; snap_alive SNAP prints
# the PIDs of SNAP that are still the same process and not a zombie.
snapshot() {
  local p st
  for p in "$@"; do
    [[ "$p" =~ ^[0-9]+$ ]] || continue
    st="$(cli_start "$p")"
    [[ -n "$st" ]] && printf '%s|%s\n' "$p" "$st"
  done
  return 0
}
snap_alive() {
  local p st now
  # Each pid|start pair once (the snapshot is appended to on every pass).
  while IFS='|' read -r p st; do
    [[ "$p" =~ ^[0-9]+$ ]] || continue
    now="$(cli_start "$p")"
    [[ -n "$now" && "$now" == "$st" && "$(ps -o stat= -p "$p" 2>/dev/null)" != Z* ]] && echo "$p"
  done < <(printf '%s\n' "$1" | awk 'NF && !seen[$0]++')
  return 0
}
# wait_procs SNAP: waits up to 10 s for the snapshot's processes to exit, then KILLs
# what is left and reports it (F-SEC-29 c): "eve-drill note=killed pids=N".
# The 10 s bound is wall-clock (SECONDS), not a number of polls, so it holds when
# each poll is slow under heavy load (F-QA-27).
wait_procs() {
  local snap="$1" left p n=0 start=$SECONDS
  while :; do
    left="$(snap_alive "$snap")"
    [[ -n "$left" ]] || return 0
    ((SECONDS - start < 10)) || break
    sleep 0.25
  done
  for p in $left; do kill -KILL "$p" 2>/dev/null && n=$((n + 1)); done
  ((n == 0)) || say "note=killed pids=$n" 2>/dev/null || true
  return 0
}
# The teardown trap is installed only here, after the check passed: no exit before
# this line can remove anything.
# shellcheck disable=SC2329 # invoked by the EXIT trap below
teardown() { # teardown RC (the EXIT trap passes the exit code)
  local rc="$1" left work_left w
  stop_flag # before anything is removed: restore.sh starts no new helper from here on
  wait_procs "$(cli_snap)" # any helper CLI still running (F-SEC-26)
  # F-SEC-31: restore.sh's work dir (metadata of decrypted data) is removed here even
  # if restore.sh was KILLed; one that cannot be removed is a reported leftover.
  work_left=""
  for w in "$STOP_DIR"/work.*; do
    [[ -e "$w" ]] || continue
    rm -rf -- "$w" 2>/dev/null || true
    [[ ! -e "$w" ]] || work_left="${work_left:+$work_left,}workdir:$w"
  done
  if ((KEEP)); then
    if [[ -n "$work_left" ]]; then
      say "status=failed step=teardown reason=leftover left=$work_left" 2>/dev/null || true
      ((rc != 0)) || rc=1
    fi
    # After a hangup stdout may be gone; a failed write must not end the shell (set -e)
    # with another exit code.
    say "kept project=$PROJECT" 2>/dev/null || true
  else
    remove_project
    left="$(leftovers)"
    [[ -z "$work_left" ]] || left="${left:+$left
}${work_left//,/
}"
    if [[ -n "$left" ]]; then
      # Never silent: a drill volume left behind can hold restored, unencrypted data.
      say "status=failed step=teardown reason=leftover left=${left//$'\n'/,}" 2>/dev/null || true
      ((rc != 0)) || rc=1
    fi
  fi
  rm -rf -- "$STOP_DIR" 2>/dev/null || true
  exit "$rc"
}
# F-QA-20, F-SEC-21: the long steps (compose up, restore.sh) run as a background job
# and the drill waits for it. Bash runs a trap only after a foreground child exits,
# but at once while in `wait`. Every terminating signal, HUP (a closed terminal or
# SSH session), INT, QUIT and TERM, goes to on_signal: it sends TERM to the step and
# all its descendants (a background job ignores INT and QUIT), waits for the step,
# then exits 128+signal, so the EXIT trap tears down (or keeps) only after the step
# is gone. The step stays in the drill's process group, so age can still prompt on
# the terminal.
CHILD=""
# shellcheck disable=SC2329 # used by on_signal
descendants() { # descendants PID: prints every live descendant PID
  local all kids k
  all="$(ps -A -o pid= -o ppid= 2>/dev/null)" || return 0
  kids="$(awk -v p="$1" '$2 == p { print $1 }' <<<"$all")"
  for k in $kids; do echo "$k"; descendants "$k"; done
}
# shellcheck disable=SC2329 # invoked by the signal traps below
on_signal() { # on_signal CODE
  local _ p snap
  # A second signal must not cut this handler or the teardown short. Ignoring here
  # does not reach the step: it was forked with the normal dispositions.
  trap '' HUP INT QUIT TERM
  if [[ -n "$CHILD" ]]; then
    # The stop flag first, so restore.sh starts no new helper while it is stopped.
    # The process list is taken before TERM, while every process is still a
    # descendant; the recorded helper CLIs are added by PID (F-SEC-26).
    stop_flag
    # shellcheck disable=SC2046 # descendants prints PIDs, one per line
    snap="$(snapshot "$CHILD" $(descendants "$CHILD"))
$(cli_snap)"
    for _ in 1 2; do # twice: catches a child forked while the first pass ran
      for p in $(snap_alive "$snap"); do kill -TERM "$p" 2>/dev/null || true; done
      # shellcheck disable=SC2046 # PIDs
      snap="$snap
$(snapshot $(descendants "$CHILD"))
$(cli_snap)"
    done
    # F-SEC-24, F-SEC-30: wait for every process of the step, restore.sh included,
    # bounded (10 s, then KILL). restore.sh itself is waited for in the same bounded
    # loop: it can block on a command substitution whose pipe a reparented CLI still
    # holds open, so an unbounded `wait` could hang. It is reaped afterwards.
    wait_procs "$snap
$(cli_snap)"
    wait "$CHILD" 2>/dev/null || true
    CHILD=""
  fi
  exit "$1"
}
# F-SEC-20: a signal between starting the step and recording its PID would find
# CHILD empty and orphan the step. So while the step starts, the signals only set
# PENDING; once CHILD is set the real traps return and a pending signal stops the
# step at once. (Not `trap ''`: an ignored signal stays ignored in the child, and
# the drill could then no longer stop restore.sh.)
PENDING=""
signal_traps() {
  trap 'on_signal 129' HUP
  trap 'on_signal 130' INT
  trap 'on_signal 131' QUIT
  trap 'on_signal 143' TERM
}
run_step() { # run_step CMD...: runs CMD as a waited-for background job, returns its exit code
  local rc=0
  trap 'PENDING=129' HUP
  trap 'PENDING=130' INT
  trap 'PENDING=131' QUIT
  trap 'PENDING=143' TERM
  "$@" &
  CHILD=$!
  signal_traps
  [[ -z "$PENDING" ]] || on_signal "$PENDING"
  # `|| rc=$?`: a failed wait never trips set -e, so the shell cannot exit here
  # while the step still runs.
  wait "$CHILD" || rc=$?
  CHILD=""
  return "$rc"
}
# F-QA-23: the redirect belongs to the step only. `run_step ... >/dev/null` would
# also send the signal handler's and teardown's output (the kept line) to /dev/null.
# shellcheck disable=SC2329 # passed to run_step by name
quietly() { "$@" >/dev/null 2>&1; }
# F-SEC-23: the trap's first command ignores further signals, so none can cut the
# teardown short or skip its report. It also captures the exit code first:
# ${_E[...]} with an arithmetic subscript sets EXIT_RC without changing $?.
# F-SEC-25: --cleanup NAME removes a kept drill project with the same removal and
# verification as the teardown, after the same ownership check. It starts nothing.
if ((CLEANUP)); then
  trap '' HUP INT QUIT TERM
  stop_flag
  remove_project
  left="$(leftovers)"
  rm -rf -- "$STOP_DIR" 2>/dev/null || true
  if [[ -n "$left" ]]; then say "status=failed step=cleanup reason=leftover left=${left//$'\n'/,}"; exit 1; fi
  say "status=ok step=cleanup project=$PROJECT"
  exit 0
fi
_E=()
trap 'trap -- "" HUP INT QUIT TERM ${_E[$((EXIT_RC = $?))]-}; teardown "$EXIT_RC"' EXIT
signal_traps
remove_project prestart
say "step=start project=$PROJECT set=$SET_TS"
run_step quietly "${COMPOSE[@]}" up -d --wait || { say "status=failed step=start reason=compose-up"; exit 1; }
eve_wait_pg "$PROJECT" "$DB_NAME" postgres || { say "status=failed step=start reason=postgres-not-ready"; exit 1; }
# Named volumes are created only when a service mounts them: create them now.
docker volume create --label "com.docker.compose.project=$PROJECT" --label eve.backup.drill=1 "${PROJECT}_documents" >/dev/null
docker volume create --label "com.docker.compose.project=$PROJECT" --label eve.backup.drill=1 "${PROJECT}_resumes" >/dev/null
# EPIC-0002 A2: per-Candidate files. restore.sh leaves it empty for a set without a candidates archive.
docker volume create --label "com.docker.compose.project=$PROJECT" --label eve.backup.drill=1 "${PROJECT}_candidates" >/dev/null

set +e
run_step "$SCRIPT_DIR/restore.sh" --env-file "$ENV_FILE" --identity "$IDENTITY" --set "$SET_TS" --backup-dir "$BACKUP_DIR" \
  --target-project "$PROJECT" --target-db "$DB_NAME" --target-db-user postgres \
  --documents-volume "${PROJECT}_documents" --resumes-volume "${PROJECT}_resumes" --candidates-volume "${PROJECT}_candidates"
rc=$?
set -e
if ((rc == 0)); then say "status=ok set=$SET_TS project=$PROJECT"; else say "status=failed set=$SET_TS exit=$rc"; fi
exit "$rc"
