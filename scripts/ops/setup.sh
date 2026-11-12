#!/usr/bin/env bash
# One command from a fresh checkout to a running Eve, self-hosted.
# Generates the database passwords and the backup key, asks for the four values only you can
# supply, writes a valid .env, seeds your account, starts the stack, and prints the URL.
#
# Usage:
#   scripts/ops/setup.sh                       # interactive
#   scripts/ops/setup.sh --dry-run             # show the plan, write nothing
#   scripts/ops/setup.sh --force               # overwrite an existing .env
#   scripts/ops/setup.sh --no-start            # write .env, do not start the stack
#   scripts/ops/setup.sh --google-sub 1234...  # skip the prompt for your Google subject
#
# Values can come from the environment instead of a prompt, which is what CI and the deploy
# wrapper use: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ANTHROPIC_API_KEY, GMAIL_SMTP_USER,
# GMAIL_SMTP_APP_PASSWORD, GOOGLE_SUB, PUBLIC_ORIGIN.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DRY=0
FORCE=0
START=1
GOOGLE_SUB="${GOOGLE_SUB:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --force) FORCE=1; shift ;;
    --no-start) START=0; shift ;;
    --google-sub) GOOGLE_SUB="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$1"; }
die() { echo "$1" >&2; exit 2; }

say "Checks"
[ -f .env.example ] || die "Run this from the repository root."
if [ -f .env ] && [ "$FORCE" = 0 ] && [ "$DRY" = 0 ]; then
  die ".env already exists. Re-run with --force to regenerate it, or edit it by hand."
fi
if [ "$DRY" = 0 ]; then
  command -v docker >/dev/null || die "Docker is not installed. https://docs.docker.com/engine/install/"
  if docker volume ls -q 2>/dev/null | grep -qxE '(eve|job-assistant)_postgres-data'; then
    die "A Postgres volume from an existing Eve already exists on this host, so this is not a first install.
Upgrading an existing install is a different job: back up first, then follow docs/ops/deploy.md.
To start clean on a scratch machine, remove that volume yourself. This script will not touch it."
  fi
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing."
  command -v openssl >/dev/null || die "openssl is missing."
  command -v age-keygen >/dev/null || die "age is missing. Install it: https://github.com/FiloSottile/age"
fi

say "Secrets"
BOOTSTRAP_PW="$(openssl rand -hex 24)"
OWNER_PW="$(openssl rand -hex 24)"
RUNTIME_PW="$(openssl rand -hex 24)"
BACKUP_PW="$(openssl rand -hex 24)"
ACCESS_SECRET="$(openssl rand -base64 32 | tr -d '\n')"

IDENTITY="${BACKUP_IDENTITY:-$HOME/eve-backup-identity.txt}"
if [ -f "$IDENTITY" ]; then
  RECIPIENT="$(age-keygen -y "$IDENTITY")"
  echo "reusing the backup identity at $IDENTITY"
else
  if [ "$DRY" = 1 ]; then
    RECIPIENT="<would be generated>"
  else
    mkdir -p "$(dirname "$IDENTITY")"
    age-keygen -o "$IDENTITY" >/dev/null 2>&1
    chmod 600 "$IDENTITY"
    RECIPIENT="$(age-keygen -y "$IDENTITY")"
    echo "wrote a new backup identity to $IDENTITY"
  fi
fi

ask() {
  local name="$1" prompt="$2" secret="${3:-0}" current="${!1:-}"
  if [ -n "$current" ]; then printf '%s' "$current"; return; fi
  if [ "$DRY" = 1 ]; then printf '<%s>' "$name"; return; fi
  local value=""
  if [ "$secret" = 1 ]; then
    read -r -s -p "$prompt: " value </dev/tty; echo >&2
  else
    read -r -p "$prompt: " value </dev/tty
  fi
  [ -n "$value" ] || die "$name cannot be empty."
  printf '%s' "$value"
}

say "The four values only you can supply"
GOOGLE_CLIENT_ID="$(ask GOOGLE_CLIENT_ID 'Google OAuth client id')"
GOOGLE_CLIENT_SECRET="$(ask GOOGLE_CLIENT_SECRET 'Google OAuth client secret' 1)"
ANTHROPIC_API_KEY="$(ask ANTHROPIC_API_KEY 'Anthropic API key' 1)"
GMAIL_SMTP_USER="$(ask GMAIL_SMTP_USER 'Gmail address for notifications')"
GMAIL_SMTP_APP_PASSWORD="$(ask GMAIL_SMTP_APP_PASSWORD 'Gmail app password' 1)"

ORIGIN="${PUBLIC_ORIGIN:-http://localhost:3000}"

say "Plan"
cat <<EOF
  .env at            $ROOT/.env
  public origin      $ORIGIN
  database           generated (bootstrap, owner, runtime, backup roles)
  backup identity    $IDENTITY
  backup recipient   $RECIPIENT
  google client      ${GOOGLE_CLIENT_ID:0:18}...
  anthropic key      ${ANTHROPIC_API_KEY:0:12}...
  notifications      $GMAIL_SMTP_USER
  google subject     ${GOOGLE_SUB:-<prompted or skipped>}
EOF

if [ "$DRY" = 1 ]; then
  echo
  echo "dry run: nothing written, nothing started."
  exit 0
fi

say "Writing .env"
WORKER=1 POSTGRES_PASSWORD="$BOOTSTRAP_PW" DB_OWNER_PASSWORD="$OWNER_PW" DB_RUNTIME_PASSWORD="$RUNTIME_PW" \
DB_BACKUP_PASSWORD="$BACKUP_PW" GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" \
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" GMAIL_SMTP_USER="$GMAIL_SMTP_USER" GMAIL_SMTP_APP_PASSWORD="$GMAIL_SMTP_APP_PASSWORD" \
BACKUP_AGE_RECIPIENT="$RECIPIENT" PUBLIC_ORIGIN="$ORIGIN" ACCESS_REQUEST_SECRET="$ACCESS_SECRET" python3 - <<'PY'
import os, re, pathlib
src = pathlib.Path(".env.example").read_text().splitlines()
env = dict(os.environ)
replacements = {
    "POSTGRES_PASSWORD": env["POSTGRES_PASSWORD"],
    "DB_OWNER_PASSWORD": env["DB_OWNER_PASSWORD"],
    "DB_RUNTIME_PASSWORD": env["DB_RUNTIME_PASSWORD"],
    "DB_BACKUP_PASSWORD": env["DB_BACKUP_PASSWORD"],
    "MIGRATION_DATABASE_URL": f"postgres://ja_owner:{env['DB_OWNER_PASSWORD']}@postgres:5432/job_assistant",
    "DATABASE_URL": f"postgres://ja_runtime:{env['DB_RUNTIME_PASSWORD']}@postgres:5432/job_assistant",
    "GOOGLE_CLIENT_ID": env["GOOGLE_CLIENT_ID"],
    "GOOGLE_CLIENT_SECRET": env["GOOGLE_CLIENT_SECRET"],
    "ANTHROPIC_API_KEY": env["ANTHROPIC_API_KEY"],
    "GMAIL_SMTP_USER": env["GMAIL_SMTP_USER"],
    "GMAIL_SMTP_APP_PASSWORD": env["GMAIL_SMTP_APP_PASSWORD"],
    "BACKUP_AGE_RECIPIENT": env["BACKUP_AGE_RECIPIENT"],
    "BACKUP_DIR": os.path.expanduser("~/eve-backups"),
    "PUBLIC_ORIGIN": env["PUBLIC_ORIGIN"],
    "API_HOST_PORT": "3000",
    "SUBMISSION_BROWSER_ENABLED": "0",
    # Retired key: the api refuses to start with a value, so write it empty.
    "ACCESS_REQUEST_SECRET": env["ACCESS_REQUEST_SECRET"],
    "CANDIDATE_GOOGLE_SUB": "",
}
out = []
seen = set()
for line in src:
    match = re.match(r"^([A-Z0-9_]+)=", line)
    if match and match.group(1) in replacements:
        key = match.group(1)
        out.append(f"{key}={replacements[key]}")
        seen.add(key)
    else:
        out.append(line)
for key, value in replacements.items():
    if key not in seen:
        out.append(f"{key}={value}")
pathlib.Path(".env").write_text("\n".join(out).rstrip() + "\n")
PY
chmod 600 .env

say "Checking the written file"
if grep -qE 'replace-with|change-me' .env; then
  grep -nE 'replace-with|change-me' .env | sed 's/=.*/=<hidden>/' >&2
  rm -f .env
  die "The generated .env still held placeholders, so it was removed. Report which keys above."
fi

if [ -z "$GOOGLE_SUB" ]; then
  read -r -p "Your Google subject id (seeds your account, one time only): " GOOGLE_SUB </dev/tty || true
fi

if [ -n "$GOOGLE_SUB" ]; then
  say "Seeding your account"
  docker compose run --rm -e CANDIDATE_GOOGLE_SUB="$GOOGLE_SUB" migrate
else
  echo "No Google subject given. Run the migration with CANDIDATE_GOOGLE_SUB set once, then remove it."
fi

if [ "$START" = 1 ]; then
  say "Starting the stack"
  docker compose up -d --build
  say "Waiting for health"
  for i in $(seq 1 60); do
    if curl -fsS -m 3 http://127.0.0.1:3000/v1/health >/dev/null 2>&1; then
      echo "health: ok"
      break
    fi
    sleep 5
    [ "$i" = 60 ] && { docker compose logs --tail=40 api; die "Health never came up."; }
  done
fi

cat <<EOF

Eve is running.

  Dashboard   $ORIGIN
  Health      $ORIGIN/v1/health
  OAuth       add this redirect in Google Cloud console:
              $ORIGIN/v1/auth/google/callback

Next: run one backup and check it ends with status=ok

  scripts/backup/backup.sh --on-demand && tail -3 ~/eve-backups/backup.log
EOF
