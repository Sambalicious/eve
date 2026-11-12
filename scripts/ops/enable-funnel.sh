#!/usr/bin/env bash
# Publishes the dashboard through Tailscale Funnel, so it has a stable HTTPS URL and no open port.
# Runs ON the server, from the repository root.
#
# Usage:
#   TS_AUTHKEY=tskey-auth-... scripts/ops/enable-funnel.sh
#   scripts/ops/enable-funnel.sh --status
#   scripts/ops/enable-funnel.sh --off
#
# What only you can do, once, in the Tailscale admin console:
#   1. Enable HTTPS certificates for the tailnet (DNS page).
#   2. Allow Funnel in the access rules (Access controls, or the Funnel prompt in the admin UI).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

say() { printf '\n== %s\n' "$1"; }

if [ "${1:-}" = "--status" ]; then
  sudo tailscale funnel status || true
  sudo tailscale status --self --json 2>/dev/null | python3 -c 'import json,sys;d=json.load(sys.stdin);print("dns name:", d.get("Self",{}).get("DNSName","unknown"))' 2>/dev/null || true
  exit 0
fi

if [ "${1:-}" = "--off" ]; then
  sudo tailscale funnel reset
  echo "Funnel is off. The tailnet address still works for your own devices."
  exit 0
fi

say "Tailscale"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

if ! sudo tailscale status >/dev/null 2>&1; then
  if [ -n "${TS_AUTHKEY:-}" ]; then
    say "Joining the tailnet with TS_AUTHKEY"
    sudo tailscale up --authkey "$TS_AUTHKEY" --hostname eve
  else
    cat <<'EOF'
This host is not on a tailnet yet. Either run:

  sudo tailscale up

and approve it in the browser, or re-run this script with an auth key from
the admin console (Settings, Keys):

  TS_AUTHKEY=tskey-auth-... scripts/ops/enable-funnel.sh
EOF
    exit 2
  fi
fi

DNS_NAME="$(sudo tailscale status --self --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
[ -n "$DNS_NAME" ] || { echo "Could not read this host's tailnet DNS name." >&2; exit 1; }
URL="https://$DNS_NAME"

say "Funnel on port 3000"
sudo tailscale funnel --bg 3000
sleep 2
sudo tailscale funnel status || true

say "Point the app at the public URL"
if grep -q '^PUBLIC_ORIGIN=' .env; then
  sed -i "s|^PUBLIC_ORIGIN=.*|PUBLIC_ORIGIN=$URL|" .env
else
  printf '\nPUBLIC_ORIGIN=%s\n' "$URL" >> .env
fi
chmod 600 .env
sudo docker compose up -d api

cat <<EOF

Funnel URL:   $URL
Health:       $URL/v1/health
OAuth redirect to add in Google Cloud console:

  $URL/v1/auth/google/callback

Cookies are Secure over HTTPS, so sign-in works in any browser, including Safari and on a phone.
Turn it off with: scripts/ops/enable-funnel.sh --off
EOF
