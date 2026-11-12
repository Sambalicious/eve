#!/usr/bin/env bash
# Slice 6 notifications compose test (F-QA6-00). Sends real SMTP from the real
# worker to a local mailpit that holds the DNS alias smtp.gmail.com on an
# internal-only network. Never reaches Gmail:
#   1. a static check of the merged compose config: the worker is only on
#      internal networks, has no extra_hosts, and mailpit has the alias;
#   2. the worker runs docker/test/notification-failclosed.mjs before it starts
#      (it exits if smtp.gmail.com is not the fake or 1.1.1.1:443 is reachable);
#   3. this script runs the same guard again with `exec` in the running worker
#      and aborts before any outbox row is written if it fails.
# Then notification-check.mjs seeds outbox rows and checks what mailpit got.
# Tears everything down with volumes. Never touches the live eve/job-assistant
# project or its pinned volumes.
#
# NOTIFY_TEST_PROJECT sets the compose project (default ja-s06-backend);
# NOTIFY_TEST_IMAGE sets the image tag (default <project>-api:test).
set -euo pipefail
cd "$(dirname "$0")/../.."
PROJECT="${NOTIFY_TEST_PROJECT:-ja-s06-backend}"
case "$PROJECT" in job-assistant|eve|job-assistant_*) echo "refusing live project name $PROJECT" >&2; exit 1;; esac
export NOTIFY_TEST_IMAGE="${NOTIFY_TEST_IMAGE:-$PROJECT-api:test}"
export NOTIFY_TEST_VOLUME_PREFIX="$PROJECT"
TLS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/notify-test-tls.XXXXXX")"
export NOTIFY_TEST_TLS_DIR="$TLS_DIR"
# Throwaway sentinel, never a real app password.
export NOTIFY_TEST_APP_PASSWORD="nt$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f docker/test/compose.notifications-test.yml --env-file docker/test/submission-test.env)
cleanup() {
  "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TLS_DIR"
}
trap cleanup EXIT
"${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true

# Throwaway CA and a certificate for smtp.gmail.com, trusted only by this worker.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=notify-test-ca" -keyout "$TLS_DIR/ca.key" -out "$TLS_DIR/ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj "/CN=smtp.gmail.com" -keyout "$TLS_DIR/smtp.key" -out "$TLS_DIR/smtp.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:smtp.gmail.com\n' > "$TLS_DIR/ext.cnf"
openssl x509 -req -in "$TLS_DIR/smtp.csr" -CA "$TLS_DIR/ca.pem" -CAkey "$TLS_DIR/ca.key" -CAcreateserial -days 1 -extfile "$TLS_DIR/ext.cnf" -out "$TLS_DIR/smtp.pem" >/dev/null 2>&1
printf 'notify-test-sender@example.test:%s\n' "$NOTIFY_TEST_APP_PASSWORD" > "$TLS_DIR/smtp-auth"
chmod 0644 "$TLS_DIR"/*.pem "$TLS_DIR/smtp.key" "$TLS_DIR/smtp-auth"
chmod 0755 "$TLS_DIR"

# 1. Static guard on the merged config.
"${COMPOSE[@]}" config --format json | node -e '
let s = ""
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const c = JSON.parse(s)
  const worker = c.services.worker
  const nets = Object.keys(worker.networks ?? {})
  const internal = nets.length > 0 && nets.every((n) => c.networks[n]?.internal === true)
  const alias = (c.services.mailpit.networks ?? {})
  const aliased = Object.entries(alias).some(([n, v]) => c.networks[n]?.internal === true && (v?.aliases ?? []).includes("smtp.gmail.com") && nets.includes(n))
  const noExtraHosts = !worker.extra_hosts || Object.keys(worker.extra_hosts).length === 0
  const checks = { worker_networks_internal_only: internal, mailpit_alias_on_worker_internal_net: aliased, worker_no_extra_hosts: noExtraHosts }
  let ok = true
  for (const [check, pass] of Object.entries(checks)) { if (!pass) ok = false; console.log(JSON.stringify({ check, ok: pass, ...(check.startsWith("worker_networks") ? { networks: nets } : {}) })) }
  process.exit(ok ? 0 : 1)
})'

docker build -q -f apps/api/Dockerfile -t "$NOTIFY_TEST_IMAGE" . >/dev/null
status=0
"${COMPOSE[@]}" up -d --wait --wait-timeout 180 postgres mailpit worker || status=$?
# 3. The guard again, inside the running worker. Abort before any row is written if it fails.
if [ "$status" -eq 0 ]; then
  "${COMPOSE[@]}" exec -T worker node /app/check/notification-failclosed.mjs || { echo '{"check":"failclosed_in_worker","ok":false}'; status=1; }
fi
if [ "$status" -eq 0 ]; then
  "${COMPOSE[@]}" run --rm notification-check || status=$?
fi
if [ "$status" -ne 0 ]; then
  "${COMPOSE[@]}" logs --no-color --tail=60 worker mailpit >&2 || true
fi
exit "$status"
