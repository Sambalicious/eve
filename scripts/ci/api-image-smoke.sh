#!/usr/bin/env bash
# Builds the production api image (apps/api/Dockerfile, node:22) and smoke-tests it
# against a throwaway postgres:17-alpine: provision roles, migrate, run storage-migrate
# (EPIC-0002 A2: the api refuses to start without its marker), start the api, expect
# GET /v1/health to return 200 with database "ok". CI tests the source on the .nvmrc
# Node (24); this job proves the image that ships still runs on node:22.
# Run from the repository root: scripts/ci/api-image-smoke.sh
# All credentials below are synthetic and exist only for the life of the containers.
set -euo pipefail

TAG="${API_SMOKE_IMAGE:-eve-api:ci-smoke}"
SUFFIX="$$"
NET="eve-api-smoke-${SUFFIX}"
PG="eve-api-smoke-pg-${SUFFIX}"
API="eve-api-smoke-api-${SUFFIX}"
# Throwaway named volume for /data/candidates: storage-migrate writes the marker the
# api checks at boot, as in docker-compose.yml. A fresh volume inherits the image's
# node:node 0700 directory.
CANDIDATES="eve-api-smoke-candidates-${SUFFIX}"
DB=eve_smoke
OWNER=eve_owner
OWNER_PW=smoke-owner-pw
RUNTIME=eve_runtime
RUNTIME_PW=smoke-runtime-pw
ADMIN_PW=smoke-admin-pw

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ] && docker inspect "$API" >/dev/null 2>&1; then
    echo "--- api container logs ---"
    docker logs "$API" 2>&1 | tail -n 100 || true
  fi
  docker rm -f -v "$API" "$PG" >/dev/null 2>&1 || true
  docker volume rm "$CANDIDATES" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

echo "::group::docker build"
docker build -f apps/api/Dockerfile -t "$TAG" .
echo "::endgroup::"
echo "Image Node: $(docker run --rm "$TAG" node --version)"

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_PASSWORD="$ADMIN_PW" -e POSTGRES_DB="$DB" postgres:17-alpine >/dev/null

echo "Waiting for Postgres"
for _ in $(seq 1 60); do
  if docker exec "$PG" pg_isready -U postgres -d "$DB" -h 127.0.0.1 >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$PG" pg_isready -U postgres -d "$DB" -h 127.0.0.1

echo "Provisioning roles"
docker run --rm --network "$NET" \
  -e ADMIN_DATABASE_URL="postgres://postgres:${ADMIN_PW}@${PG}:5432/${DB}" \
  -e POSTGRES_DB="$DB" \
  -e DB_OWNER_ROLE="$OWNER" -e DB_OWNER_PASSWORD="$OWNER_PW" \
  -e DB_RUNTIME_ROLE="$RUNTIME" -e DB_RUNTIME_PASSWORD="$RUNTIME_PW" \
  "$TAG" node dist/db/provision-roles.cli.js

echo "Migrating"
docker run --rm --network "$NET" \
  -e DATABASE_URL="postgres://${OWNER}:${OWNER_PW}@${PG}:5432/${DB}" \
  -e RUNTIME_DATABASE_ROLE="$RUNTIME" \
  "$TAG" node dist/db/migrate.cli.js

echo "Moving stored files (storage:migrate)"
docker run --rm --network "$NET" -v "${CANDIDATES}:/data/candidates" \
  -e DATABASE_URL="postgres://${OWNER}:${OWNER_PW}@${PG}:5432/${DB}" \
  "$TAG" node dist/db/storage-migrate.cli.js

echo "Starting the api"
docker run -d --name "$API" --network "$NET" -p 127.0.0.1::3000 -v "${CANDIDATES}:/data/candidates" \
  -e DATABASE_URL="postgres://${RUNTIME}:${RUNTIME_PW}@${PG}:5432/${DB}" \
  -e PUBLIC_ORIGIN=http://localhost:5173 \
  -e GOOGLE_CLIENT_ID=smoke-client.apps.googleusercontent.com \
  -e GOOGLE_CLIENT_SECRET=smoke-client-secret \
  -e ACCESS_REQUEST_SECRET=smoke-access-request-secret-0000-SYNTHETIC \
  "$TAG" >/dev/null
PORT="$(docker port "$API" 3000/tcp | head -n 1 | awk -F: '{print $NF}')"

echo "Polling http://127.0.0.1:${PORT}/v1/health"
body=""
for _ in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$API")" != "true" ]; then
    echo "The api container exited early" >&2
    exit 1
  fi
  if body="$(curl -fsS "http://127.0.0.1:${PORT}/v1/health" 2>/dev/null)"; then break; fi
  body=""
  sleep 1
done
echo "Response: ${body}"
if [ "$body" != '{"status":"ok","database":"ok"}' ]; then
  echo "Health check did not return 200 with database ok" >&2
  exit 1
fi
echo "api image smoke test passed"
