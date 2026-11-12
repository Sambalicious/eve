#!/usr/bin/env bash
# Slice 5 compose browser test. Builds the api image, starts postgres, browser,
# egress and the fake ATS server under a per-role project, runs
# submission-check.mjs (worker-path submissions and the egress boundary), then
# starts the api and the worker (browser on) and runs gate-check.mjs (sample
# approvals through the HTTP API, submitted by the worker). Prints the JSON
# lines and tears everything down with volumes. Never touches the live eve/job-assistant project or its pinned volumes.
#
# SUBMISSION_TEST_PROJECT sets the compose project (default ja-s05-backend);
# SUBMISSION_TEST_IMAGE sets the image tag (default <project>-api:test).
set -euo pipefail
cd "$(dirname "$0")/../.."
PROJECT="${SUBMISSION_TEST_PROJECT:-ja-s05-backend}"
export SUBMISSION_TEST_IMAGE="${SUBMISSION_TEST_IMAGE:-$PROJECT-api:test}"
export SUBMISSION_TEST_VOLUME_PREFIX="$PROJECT"
case "$PROJECT" in job-assistant|eve) echo "refusing live project name $PROJECT" >&2; exit 1;; esac
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f docker/test/compose.submission-test.yml --env-file docker/test/submission-test.env)
cleanup() { "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
# SEC-515 repair wave 3: the form agent defaults to off in the api and the worker.
for svc in api worker; do
  agent=$(SUBMISSION_FORM_AGENT_ENABLED= "${COMPOSE[@]}" config --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).services[process.argv[1]].environment.SUBMISSION_FORM_AGENT_ENABLED)))' "$svc")
  if [ "$agent" != "0" ]; then echo "{\"check\":\"form_agent_default_off_$svc\",\"ok\":false,\"value\":\"$agent\"}"; exit 1; fi
  echo "{\"check\":\"form_agent_default_off_$svc\",\"ok\":true}"
done
# F-QA6-00: this worker keeps the `default` network (an outbound route), so it must
# never have Gmail settings: GMAIL_SMTP hard-codes smtp.gmail.com. Email is tested
# only by run-notifications-test.sh, whose worker is internal-only and fail-closed.
mail=$("${COMPOSE[@]}" config --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s).services.worker.environment;process.stdout.write(["GMAIL_SMTP_USER","GMAIL_SMTP_APP_PASSWORD","NOTIFY_TO"].filter(k=>String(e[k]??"").trim()!=="").join(","))})')
if [ -n "$mail" ]; then echo "{\"check\":\"worker_sender_off\",\"ok\":false,\"set\":\"$mail\"}"; exit 1; fi
echo '{"check":"worker_sender_off","ok":true}'
docker build -q -f apps/api/Dockerfile -t "$SUBMISSION_TEST_IMAGE" . >/dev/null
"${COMPOSE[@]}" up -d postgres fake-ats egress browser
status=0
"${COMPOSE[@]}" run --rm submission-check || status=$?
if [ "$status" -eq 0 ]; then
  "${COMPOSE[@]}" up -d --wait --wait-timeout 120 api worker || status=$?
fi
if [ "$status" -eq 0 ]; then
  "${COMPOSE[@]}" run --rm gate-check || status=$?
fi
if [ "$status" -ne 0 ]; then
  "${COMPOSE[@]}" logs --no-color --tail=60 api worker browser egress fake-ats >&2 || true
fi
exit "$status"
