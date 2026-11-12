#!/usr/bin/env bash
# Copies this checkout to a fresh VM and runs the server bootstrap there.
# Runs on your laptop, from anywhere in the repository.
#
# Usage: scripts/ops/deploy.sh ubuntu@<instance-ip> [--env .env] [--dry-run]
#
# The .env stays on your laptop until this script copies it. It is never committed.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET=""
ENV_FILE="$ROOT/.env"
DRY=0
FUNNEL=0
GOOGLE_SUB=""

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --funnel) FUNNEL=1; shift ;;
    --google-sub) GOOGLE_SUB="$2"; shift 2 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) TARGET="$1"; shift ;;
  esac
done

[ -n "$TARGET" ] || { echo "usage: scripts/ops/deploy.sh <user@host> [--env .env] [--dry-run]" >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "no env file at $ENV_FILE" >&2; exit 2; }

if grep -qE 'replace-with|change-me' "$ENV_FILE"; then
  echo "Refusing: $ENV_FILE still holds placeholder values:" >&2
  grep -nE 'replace-with|change-me' "$ENV_FILE" | sed 's/=.*/=<hidden>/' >&2
  exit 2
fi

for key in PUBLIC_ORIGIN GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET ANTHROPIC_API_KEY BACKUP_AGE_RECIPIENT; do
  grep -qE "^${key}=.+" "$ENV_FILE" || { echo "Refusing: $key is empty in $ENV_FILE" >&2; exit 2; }
done

RSYNC=(rsync -az --delete
  --exclude '.git/' --exclude 'node_modules/' --exclude 'dist/' --exclude '.env'
  --exclude '*/node_modules/' --exclude '*/dist/' --exclude '*.log' --exclude '.turbo/'
  --exclude '.playwright-mcp/' --exclude '.runs/' --exclude 'epics/')
RSYNC+=("$ROOT/" "$TARGET:~/eve/")

echo "target: $TARGET"
echo "env:    $ENV_FILE"

if [ "$DRY" = 1 ]; then
  echo "dry run, no connection made. It would run:"
  printf '  %q ' "${RSYNC[@]}"; echo
  echo "  scp $ENV_FILE $TARGET:~/eve/.env"
  echo "  ssh $TARGET \"cd ~/eve && FIRST_GOOGLE_SUB='$GOOGLE_SUB' bash scripts/ops/bootstrap-server.sh\""
  exit 0
fi

ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" 'echo connected to $(hostname)' || {
  echo "Cannot reach $TARGET over SSH with your key. Check the IP, the user and the key." >&2
  exit 1
}

echo "copying the checkout"
"${RSYNC[@]}"

echo "copying the env file"
scp -q "$ENV_FILE" "$TARGET:~/eve/.env"
ssh "$TARGET" 'chmod 600 ~/eve/.env'

echo "bootstrapping the server"
ssh -t "$TARGET" "cd ~/eve && FIRST_GOOGLE_SUB='$GOOGLE_SUB' bash scripts/ops/bootstrap-server.sh"
if [ "$FUNNEL" = 1 ]; then
  echo "publishing through Tailscale Funnel"
  ssh -t "$TARGET" 'cd ~/eve && bash scripts/ops/enable-funnel.sh' || echo "Funnel not enabled. Run scripts/ops/enable-funnel.sh on the server once Tailscale is logged in."
fi

cat <<EOF

Deployed. Open the dashboard:

  ssh -N -L 3000:127.0.0.1:3000 $TARGET
  open http://localhost:3000

Health, from your laptop through the tunnel: http://localhost:3000/v1/health
EOF
