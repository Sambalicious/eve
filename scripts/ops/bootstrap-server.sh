#!/usr/bin/env bash
# Prepares a fresh Ubuntu VM to run Eve and starts the stack. Idempotent: run it again after a pull.
# Runs ON the server, from the repository root. The laptop-side wrapper is deploy.sh.
#
# Usage: scripts/ops/bootstrap-server.sh [--no-timers]
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TIMERS=1
for arg in "$@"; do
  [ "$arg" = "--no-timers" ] && TIMERS=0
done

say() { printf '\n== %s\n' "$1"; }

say "Preconditions"
[ -f .env ] || { echo ".env is missing. Copy .env.example and fill it in first." >&2; exit 2; }
if grep -qE 'replace-with|change-me' .env; then
  echo ".env still holds placeholder values:" >&2
  grep -nE 'replace-with|change-me' .env | sed 's/=.*/=<hidden>/' >&2
  exit 2
fi
command -v apt-get >/dev/null || { echo "This script expects Debian or Ubuntu." >&2; exit 2; }

say "Base packages"
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl rsync >/dev/null

say "Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER" || true

say "Firewall: SSH only"
if command -v ufw >/dev/null; then
  sudo ufw allow 22/tcp >/dev/null
  sudo ufw --force enable >/dev/null
  sudo ufw status | sed -n '1,12p'
fi

say "First run: seed the Operator account"
if [ -n "${FIRST_GOOGLE_SUB:-}" ]; then
  if grep -q '^CANDIDATE_GOOGLE_SUB=..*' .env; then
    echo "Refusing: CANDIDATE_GOOGLE_SUB is set in .env. The api refuses to start while it is present." >&2
    echo "Remove it and pass --google-sub to deploy.sh instead." >&2
    exit 2
  fi
  # The key is retired: only the migration process may see it, never the api.
  sudo docker compose run --rm -e CANDIDATE_GOOGLE_SUB="$FIRST_GOOGLE_SUB" migrate
fi

say "Build and start the stack"
# sudo for the first run: the docker group applies to the next login, not this shell.
sudo docker compose up -d --build

say "Waiting for the api health route"
for i in $(seq 1 60); do
  if curl -fsS -m 3 http://127.0.0.1:3000/v1/health >/dev/null 2>&1; then
    echo "health: ok after ${i}0s"
    break
  fi
  sleep 10
  if [ "$i" = 60 ]; then
    echo "health: still failing. Read the logs:" >&2
    sudo docker compose logs --tail=40 api
    exit 1
  fi
done

if [ "$TIMERS" = 1 ]; then
  say "Backup and health timers"
  sudo apt-get install -y -qq age rclone >/dev/null
  mkdir -p "$HOME/.config/systemd/user"

  cat > "$HOME/.config/systemd/user/eve-backup.service" <<'UNIT'
[Unit]
Description=Eve nightly encrypted backup and off-box copy

[Service]
Type=oneshot
WorkingDirectory=%h/eve
ExecStart=%h/eve/scripts/backup/backup.sh --nightly
UNIT

  if [ -n "${RCLONE_REMOTE:-}" ]; then
    printf 'ExecStartPost=/usr/bin/rclone sync %s/eve-backups %s --transfers 4\n' "$HOME" "$RCLONE_REMOTE" >> "$HOME/.config/systemd/user/eve-backup.service"
  fi
  if [ -n "${HOST_BACKUP_CHECK_URL:-}" ]; then
    printf 'ExecStartPost=/usr/bin/curl -fsS -m 10 %s\n' "$HOST_BACKUP_CHECK_URL" >> "$HOME/.config/systemd/user/eve-backup.service"
  fi

  cat > "$HOME/.config/systemd/user/eve-backup.timer" <<'UNIT'
[Unit]
Description=Run the Eve backup at 03:10 daily

[Timer]
OnCalendar=*-*-* 03:10:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

  cat > "$HOME/.config/systemd/user/eve-health.service" <<'UNIT'
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'curl -fsS -m 10 http://127.0.0.1:3000/v1/health >/dev/null'
UNIT
  if [ -n "${HOST_API_CHECK_URL:-}" ]; then
    printf 'ExecStartPost=/usr/bin/curl -fsS -m 10 %s\n' "$HOST_API_CHECK_URL" >> "$HOME/.config/systemd/user/eve-health.service"
  fi

  cat > "$HOME/.config/systemd/user/eve-health.timer" <<'UNIT'
[Unit]
Description=Ping the Eve health route every five minutes

[Timer]
OnCalendar=*:0/5
Persistent=true

[Install]
WantedBy=timers.target
UNIT

  sudo loginctl enable-linger "$USER"
  systemctl --user daemon-reload
  systemctl --user enable --now eve-backup.timer eve-health.timer
  systemctl --user list-timers --no-pager | grep -E 'eve-(backup|health)' || true
fi

say "Status"
sudo docker compose ps
cat <<EOF

Next, from your laptop:

  ssh -N -L 3000:127.0.0.1:3000 $USER@<this host>
  open http://localhost:3000

Then run one backup by hand and check it ends with status=ok:

  scripts/backup/backup.sh --on-demand && tail -3 ~/eve-backups/backup.log
EOF
