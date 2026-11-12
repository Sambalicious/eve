# shellcheck shell=bash
# Shared functions for backup.sh, restore.sh, restore-drill.sh and backup-status.sh.
# Bash 3.2 compatible (macOS /bin/bash): no associative arrays, no mapfile.
# Sourced, never executed. Nothing here prints a secret, a row value or a file
# name from inside a volume.

EVE_BACKUP_NAME_RE='^eve-(db|documents|resumes|candidates)-([0-9]{8}T[0-9]{6}Z)\.(dump|tar)\.age(\.partial)?$'
EVE_TS_RE='^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$'
# X25519 age recipient: "age1" plus 58 bech32 characters. Plugin recipients are not supported.
EVE_RECIPIENT_RE='^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$'
# Keys the scripts read from the env file. Anything else in .env is ignored.
# DB_BACKUP_* (fix-backup-role): the read-only BYPASSRLS role backup.sh dumps as.
EVE_ENV_KEYS="BACKUP_AGE_RECIPIENT BACKUP_DIR BACKUP_RETENTION_DAYS BACKUP_COMPOSE_PROJECT BACKUP_DOCUMENT_VOLUME BACKUP_RESUME_VOLUME BACKUP_CANDIDATE_VOLUME BACKUP_HELPER_IMAGE POSTGRES_DB DB_OWNER_ROLE DB_OWNER_PASSWORD DB_BACKUP_ROLE DB_BACKUP_PASSWORD"
# Names that belong to the live stack (docker-compose.yml). Restores never target them by default.
EVE_LIVE_PROJECTS="eve job-assistant"
# job-assistant_candidate-data is the per-Candidate file root from EPIC-0002 A2.
EVE_LIVE_VOLUMES="job-assistant_document-data job-assistant_resume-data job-assistant_candidate-data job-assistant_postgres-data"

# --help: prints a script's header comment, from line 2 to the last line before the
# first non-comment line, so it never falls out of step with the header (F-CR-09).
eve_print_help() { awk 'NR > 1 && !/^#/ { exit } NR > 1' "$1"; }
eve_now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
eve_now_ts() { date -u +%Y%m%dT%H%M%SZ; }

# Seconds since the epoch for a YYYYmmddTHHMMSSZ timestamp, without GNU or BSD date flags.
eve_epoch_of_ts() {
  local re="$EVE_TS_RE"
  [[ "$1" =~ $re ]] || return 1
  local y=$((10#${BASH_REMATCH[1]})) m=$((10#${BASH_REMATCH[2]})) d=$((10#${BASH_REMATCH[3]}))
  local hh=$((10#${BASH_REMATCH[4]})) mi=$((10#${BASH_REMATCH[5]})) ss=$((10#${BASH_REMATCH[6]}))
  ((m >= 1 && m <= 12 && d >= 1 && d <= 31 && hh <= 23 && mi <= 59 && ss <= 60)) || return 1
  ((m <= 2)) && y=$((y - 1))
  local era=$((y / 400))
  local yoe=$((y - era * 400))
  local mp=$(((m + 9) % 12))
  local doy=$(((153 * mp + 2) / 5 + d - 1))
  local doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  echo $(((era * 146097 + doe - 719468) * 86400 + hh * 3600 + mi * 60 + ss))
}

# Reads only the whitelisted keys from an env file into shell variables (not
# exported, so child processes such as age never inherit them). Values already
# set in the environment win. No shell expansion: the file is parsed, never sourced.
eve_load_env() {
  local file="$1" line key val isset
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    key="${key#export }"
    key="${key// /}"
    case " $EVE_ENV_KEYS " in *" $key "*) ;; *) continue ;; esac
    eval "isset=\${$key+x}"
    [[ -n "$isset" ]] && continue
    val="${line#*=}"
    val="${val%$'\r'}"
    val="$(eve_env_value "$val")"
    printf -v "$key" '%s' "$val"
  done <"$file"
}

# One .env value: surrounding spaces and tabs trimmed. A quoted value keeps
# everything inside its quotes; anything after the closing quote is dropped.
# An unquoted value ends at the first " #" (space or tab, then #), like
# docker compose; a "#" with no space before it is part of the value.
eve_env_value() {
  local v="$1" ws=$' \t' q
  v="${v#"${v%%[!$ws]*}"}"
  q="${v:0:1}"
  if [[ "$q" == '"' || "$q" == "'" ]]; then
    local rest="${v:1}"
    if [[ "$rest" == *"$q"* ]]; then
      printf '%s' "${rest%%"$q"*}"
      return
    fi
  fi
  v="${v%%[$ws]#*}"
  [[ "$v" == "#"* && "$1" != "$v" && "$1" != "#"* ]] && v=""
  v="${v%"${v##*[!$ws]}"}"
  printf '%s' "$v"
}

eve_expand_home() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${1#\~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# 0 valid, 1 unset/empty, 2 malformed.
eve_check_recipient() {
  local r="$1" re="$EVE_RECIPIENT_RE"
  [[ -z "$r" ]] && return 1
  [[ "$r" =~ $re ]] || return 2
  # age verifies the bech32 checksum; encrypt nothing to /dev/null.
  age -r "$r" -o /dev/null </dev/null >/dev/null 2>&1 || return 2
  return 0
}

# Any eve* or job-assistant* / job_assistant* name, in any letter case, is
# treated as the live stack. Restore and drill also add the configured names.
eve_is_live_name() {
  local n
  n="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$n" in eve* | job-assistant* | job_assistant*) return 0 ;; esac
  return 1
}

# A short stable key for BACKUP_DIR, used to label this folder's helper containers.
eve_dir_key() { printf '%s' "$1" | shasum -a 256 2>/dev/null | cut -c1-16 || printf '%s' "$1" | sha256sum | cut -c1-16; }

eve_is_live_project() {
  case " $EVE_LIVE_PROJECTS " in *" $1 "*) return 0 ;; esac
  return 1
}

eve_is_live_volume() {
  case " $EVE_LIVE_VOLUMES " in *" $1 "*) return 0 ;; esac
  case "$1" in job-assistant_* | eve_*) return 0 ;; esac
  return 1
}

# True for any volume restore and the drill must treat as live: a live-looking name,
# a built-in live volume, or one configured in .env (BACKUP_DOCUMENT_VOLUME,
# BACKUP_RESUME_VOLUME, BACKUP_CANDIDATE_VOLUME, with their defaults). Shared by
# restore.sh and restore-drill.sh (F-SEC-29).
eve_is_live_target_volume() { # eve_is_live_target_volume NAME
  eve_is_live_name "$1" || eve_is_live_volume "$1" && return 0
  [[ "$1" == "${BACKUP_DOCUMENT_VOLUME:-job-assistant_document-data}" ||
    "$1" == "${BACKUP_RESUME_VOLUME:-job-assistant_resume-data}" ||
    "$1" == "${BACKUP_CANDIDATE_VOLUME:-job-assistant_candidate-data}" ]]
}

# Prints the real names of the volumes or networks of a compose project, one per line,
# as Compose itself resolves them (`name:` overrides, the implicit <project>_default
# network), read from `docker compose config --format json`: `.volumes[].name`,
# `.networks[].name`. No YAML parsing here (F-SEC-19). Fails (1) if the command
# fails, if an entry has no name, or if a name is not a plain Docker name. The
# caller must also treat an empty result as a failure.
eve_compose_names() { # eve_compose_names PROJECT FILE volumes|networks
  local json
  json="$(docker compose -p "$1" -f "$2" config --format json 2>/dev/null)" || return 1
  # Compose prints indented JSON: sections at 2 spaces, entries at 4, fields at 6.
  awk -v sec="$3" '
    /^  "[^"]*": / { in_sec = ($0 ~ "^  \"" sec "\": \\{"); if (key != "") bad = 1; key = ""; next }
    !in_sec { next }
    /^    "[^"]*": / { if (key != "") bad = 1; key = $0; next }
    /^    }/ { if (key != "") bad = 1; key = ""; next }
    key != "" && /^      "name": "[^"]*",?$/ {
      n = $0; sub(/^      "name": "/, "", n); sub(/",?$/, "", n)
      if (n !~ /^[A-Za-z0-9][A-Za-z0-9_.-]*$/) bad = 1; else print n
      key = ""
    }
    END { exit bad }
  ' <<<"$json"
}

# File mode in octal (e.g. 700) on GNU (Linux) and BSD (macOS) stat. The flavour is
# detected once: GNU stat answers --version, BSD stat does not. (GNU `stat -f` means
# file-system status and exits non-zero after printing it, so trying BSD flags first
# and falling back is wrong there: F-QA-26.)
EVE_STAT_FLAVOUR=""
eve_mode() { # eve_mode PATH: prints the permission bits in octal, or fails
  if [[ -z "$EVE_STAT_FLAVOUR" ]]; then
    if stat --version >/dev/null 2>&1; then EVE_STAT_FLAVOUR=gnu; else EVE_STAT_FLAVOUR=bsd; fi
  fi
  if [[ "$EVE_STAT_FLAVOUR" == gnu ]]; then stat -c %a -- "$1" 2>/dev/null; else stat -f %Lp "$1" 2>/dev/null; fi
}

# Start time of process PID as printed by `ps -o lstart=`, trailing blanks removed,
# or fails if there is no such process. The one function used both to record a PID
# (restore.sh) and to check it later (the drill), so both sides always agree
# (BSD ps pads the field, GNU procps does not; F-QA-26).
eve_proc_start() { # eve_proc_start PID
  local s
  s="$(ps -o lstart= -p "$1" 2>/dev/null)" || return 1
  s="${s%"${s##*[![:space:]]}"}"
  [[ -n "$s" ]] || return 1
  printf '%s\n' "$s"
}

# True if DIR is a real directory (not a symlink), owned by this user, mode 0700:
# only then may a script create files in a directory it was handed (F-SEC-31/33).
eve_private_dir() { # eve_private_dir DIR
  local m
  [[ -n "$1" && -d "$1" && ! -L "$1" && -O "$1" ]] || return 1
  m="$(eve_mode "$1")" || return 1
  [[ "$m" == 700 ]]
}

# Prints "--tmpfs PATH" for every VOLUME path the image declares (pulling it first if
# needed), so a helper container creates no anonymous volume (F-QA-25). Prints
# nothing if the image declares none or cannot be inspected.
eve_tmpfs_args() { # eve_tmpfs_args IMAGE
  local vols v
  docker image inspect "$1" >/dev/null 2>&1 || docker pull -q "$1" >/dev/null 2>&1 || true
  vols="$(docker image inspect -f '{{range $k, $v := .Config.Volumes}}{{$k}}{{"\n"}}{{end}}' "$1" 2>/dev/null)" || return 0
  while IFS= read -r v; do [[ -n "$v" ]] && printf -- '--tmpfs\n%s\n' "$v"; done <<<"$vols"
  return 0
}

# Prints the single running postgres container of a compose project, or fails.
eve_pg_container() {
  local ids n
  ids="$(docker ps -q --filter "label=com.docker.compose.project=$1" --filter "label=com.docker.compose.service=${2:-postgres}" 2>/dev/null)" || return 1
  n="$(printf '%s\n' "$ids" | grep -c . || true)"
  [[ "$n" == 1 ]] || return 1
  printf '%s\n' "$ids"
}

# Waits until the postgres of a compose project answers a query 3 times in a row.
# The image's healthcheck can pass during first-boot init, before the real server starts.
eve_wait_pg() { # eve_wait_pg PROJECT DB USER [PASSWORD]
  local i good=0 c
  for i in $(seq 120); do
    if c="$(eve_pg_container "$1")" && docker exec -e PGPASSWORD="${4:-}" "$c" psql -X -q -At -U "$3" -d "$2" -c 'select 1' >/dev/null 2>&1; then
      good=$((good + 1))
      ((good >= 3)) && return 0
    else
      good=0
    fi
    sleep 1
  done
  return 1
}

# Retention (B.7): delete backup files whose filename timestamp is older than
# $3 days before $2 (epoch), never the newest complete set, never a file whose
# name does not match the backup pattern. Prints the number deleted.
# A set is complete when it has db, documents and resumes. Sets from EPIC-0002 A2
# on also have candidates, which backup.sh writes before documents and resumes,
# so a set that has resumes always has its candidates file too.
eve_retention() {
  local dir="$1" now="$2" days="$3" re="$EVE_BACKUP_NAME_RE"
  local f base kind ts ext partial cutoff newest="" deleted=0 e
  cutoff=$((now - days * 86400))
  local complete
  complete="$(
    for f in "$dir"/eve-*; do
      base="${f##*/}"
      [[ "$base" =~ $re ]] || continue
      [[ -n "${BASH_REMATCH[4]}" ]] && continue
      [[ -f "$f" ]] || continue
      printf '%s %s\n' "${BASH_REMATCH[2]}" "${BASH_REMATCH[1]}"
    done | sort -u | awk '$2 != "candidates" {n[$1]++} END{for (t in n) if (n[t]==3) print t}' | sort | tail -n 1
  )"
  newest="$complete"
  for f in "$dir"/eve-*; do
    base="${f##*/}"
    [[ "$base" =~ $re ]] || continue
    kind="${BASH_REMATCH[1]}" ts="${BASH_REMATCH[2]}" ext="${BASH_REMATCH[3]}" partial="${BASH_REMATCH[4]}"
    if [[ "$kind" == db && "$ext" != dump ]] || [[ "$kind" != db && "$ext" != tar ]]; then continue; fi
    [[ -f "$f" && ! -L "$f" ]] || continue
    # The caller holds the lock, so any *.partial is left over from a killed run.
    if [[ -n "$partial" ]]; then rm -f -- "$f" && deleted=$((deleted + 1)); continue; fi
    [[ "$ts" == "$newest" ]] && continue
    e="$(eve_epoch_of_ts "$ts")" || continue
    if ((e < cutoff)); then
      rm -f -- "$f" && deleted=$((deleted + 1))
    fi
  done
  echo "$deleted"
}

# Lines "schema.table=rowcount" in C order, then a one-line summary on stderr.
# Shared by the backup (inside a snapshot) and the restore checks, so the
# digest of the same data is identical. Unlogged tables are left out, as their
# rows are left out of the dump (EVE_DUMP_SH): the only one, migration 0022's
# tenant_binding.candidate_binding, holds per-transaction rows that mean nothing
# after a restore (run a2e repair wave 1, F-DEV-01).
EVE_COUNT_SQL="SELECT n.nspname || '.' || c.relname || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND c.relpersistence = 'p' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%' ORDER BY n.nspname COLLATE \"C\", c.relname COLLATE \"C\";"

# POSIX sh run inside the postgres container. Env: EVE_DB_NAME, EVE_DB_USER,
# EVE_COUNT_SQL, optional PGPASSWORD and EVE_SNAPSHOT. Prints only the summary.
# row_security=off (as pg_dump sets it): a role bound by row-level security gets
# an error instead of a count that silently leaves out the rows it cannot see.
EVE_COUNT_SH='set -eu
PGOPTIONS="${PGOPTIONS:-} -c row_security=off"
export PGOPTIONS
summarise() {
  tables=$(printf "%s\n" "$1" | grep -c . || true)
  rows=$(printf "%s\n" "$1" | awk -F= "NF{s+=\$NF} END{printf \"%d\", s}")
  digest=$(printf "%s\n" "$1" | sha256sum | cut -c1-16)
  echo "EVECOUNTS tables=$tables rows=$rows counts=$digest"
}
if [ -n "${EVE_SNAPSHOT:-}" ]; then
  counts=$(printf "%s\n" "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" "SET TRANSACTION SNAPSHOT '"'"'$EVE_SNAPSHOT'"'"';" "$EVE_COUNT_SQL" "COMMIT;" | psql -X -q -At -v ON_ERROR_STOP=1 -U "$EVE_DB_USER" -d "$EVE_DB_NAME")
else
  counts=$(psql -X -q -At -v ON_ERROR_STOP=1 -U "$EVE_DB_USER" -d "$EVE_DB_NAME" -c "$EVE_COUNT_SQL")
fi
summarise "$counts"'

# POSIX sh run inside the postgres container for the backup: export a snapshot,
# count rows in it (summary to stderr), pg_dump -Fc the same snapshot to stdout.
# Unlogged tables keep their definition but not their rows (see EVE_COUNT_SQL).
EVE_DUMP_SH='set -eu
d=$(mktemp -d)
trap "rm -rf \"$d\"" EXIT
mkfifo "$d/ctl"
psql -X -q -At -v ON_ERROR_STOP=1 -U "$EVE_DB_USER" -d "$EVE_DB_NAME" <"$d/ctl" >"$d/snap" 2>/dev/null &
holder=$!
exec 3>"$d/ctl"
printf "%s\n" "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" "SELECT pg_export_snapshot();" >&3
i=0
while [ ! -s "$d/snap" ]; do
  i=$((i + 1))
  if [ "$i" -gt 300 ] || ! kill -0 "$holder" 2>/dev/null; then echo "EVEFAIL connect" >&2; exit 3; fi
  sleep 0.1
done
EVE_SNAPSHOT=$(head -n 1 "$d/snap")
export EVE_SNAPSHOT
sh -c "$EVE_COUNT_SH" >&2 || { echo "EVEFAIL count" >&2; exit 4; }
pg_dump -Fc --no-unlogged-table-data --snapshot="$EVE_SNAPSHOT" -U "$EVE_DB_USER" -d "$EVE_DB_NAME" || { echo "EVEFAIL pg_dump" >&2; exit 5; }
printf "COMMIT;\n" >&3
exec 3>&-
wait "$holder" || true'

# POSIX sh run in a throwaway helper container with the volume at /src (read-only).
# Streams a tar of the volume to stdout and counts the regular files actually archived.
EVE_ARCHIVE_SH='set -eu
set -o pipefail
cd /src
mkfifo /tmp/list
( tar -tvf - </tmp/list | awk "substr(\$0,1,1)==\"-\"{n++} END{printf \"EVEFILES files=%d\n\", n}" >&2 ) &
lister=$!
tar -cf - . | tee /tmp/list
wait "$lister"'
