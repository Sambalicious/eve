#!/usr/bin/env bash
# Rejects an env file whose database credentials are still the .env.example placeholders.
# docker-compose.yml's `:?set in .env` only refuses an empty value, so "change-me-owner-password"
# would otherwise start a database with a published, guessable password.
#
# Usage: scripts/ops/preflight.sh [env-file]     (default: .env in the repository root)
# Exit 0 when clean, 2 when a database password or URL is missing or a placeholder.
# Values are never printed. Called by setup.sh, deploy.sh and bootstrap-server.sh.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${1:-$ROOT/.env}"
[ -f "$ENV_FILE" ] || { echo "preflight: no env file at $ENV_FILE" >&2; exit 2; }

# Required by docker-compose.yml, and the URLs that embed the same passwords.
REQUIRED=(POSTGRES_PASSWORD DB_OWNER_PASSWORD DB_RUNTIME_PASSWORD MIGRATION_DATABASE_URL DATABASE_URL)
# Optional (empty leaves the backup role NOLOGIN) but must not be a placeholder when set.
OPTIONAL=(DB_BACKUP_PASSWORD)

bad=0
value_of() { grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true; }

for key in "${REQUIRED[@]}" "${OPTIONAL[@]}"; do
  value="$(value_of "$key")"
  value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
  if [ -z "$value" ]; then
    case " ${OPTIONAL[*]} " in *" $key "*) continue ;; esac
    echo "preflight: $key is empty in $ENV_FILE" >&2
    bad=1
  elif printf '%s' "$value" | grep -qiE 'change-?me|replace-?with'; then
    echo "preflight: $key is still a placeholder (change-me / replace-with) in $ENV_FILE" >&2
    bad=1
  fi
done

if [ "$bad" = 1 ]; then
  echo "preflight: generate real values, for example: openssl rand -hex 24" >&2
  echo "preflight: scripts/ops/setup.sh does this for a first install." >&2
  exit 2
fi
echo "preflight: database credentials in $ENV_FILE are not placeholders"
