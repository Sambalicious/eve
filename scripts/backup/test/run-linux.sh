#!/usr/bin/env bash
# Runs the backup suite (run-tests.sh) inside a Linux container (debian:stable-slim,
# GNU coreutils and procps), so the scripts are tested on the documented backup-host
# platform as well as on macOS.
#
# Usage: scripts/backup/test/run-linux.sh [--unit-only] [--rebuild]
#   --unit-only  unit cases only (no Docker daemon needed inside, but the socket is
#                still mounted for the cases that ask `docker compose config`)
#   --rebuild    rebuild the cached test image (ja-backup-linux-test:debian-<pin hash>)
#   Environment: BACKUP_TEST_PROJECT (default ja-backup-linux-test) is passed on; it
#   must be a throwaway compose project name, as for run-tests.sh.
#
# The repo is mounted read-only at /repo; HOME and TMPDIR are a temp dir inside the
# container, so nothing can reach the owner's ~/eve-backups. The host Docker socket
# is mounted so the integration cases can start their throwaway compose projects;
# the suite mounts only named volumes into its containers, never host paths.
#
# SECURITY: access to the Docker socket is control of the Docker host (equivalent to
# root on it). Run this only on a trusted local or CI machine, from a checkout you
# trust, never on the production backup host and never on untrusted code.
# The image is pinned (base by digest, tools by version) and uses mawk as awk, as a
# stock Debian/Ubuntu host does.
# Exit: the suite's exit code; 2 on bad arguments; 1 if the image cannot be built.
set -Eeuo pipefail

UNIT="" REBUILD=0
for a in "$@"; do
  case "$a" in
    --unit-only) UNIT="--unit-only" ;;
    --rebuild) REBUILD=1 ;;
    -h | --help) sed -n '2,/^set -E/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "run-linux.sh: unknown argument $a" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
PROJECT="${BACKUP_TEST_PROJECT:-ja-backup-linux-test}"
case "$PROJECT" in eve* | job-assistant* | job_assistant*) echo "run-linux.sh: refusing live-looking project $PROJECT" >&2; exit 2 ;; esac

# F-SEC-38: the base image is pinned by digest (the multi-arch index of
# debian:stable-slim, Debian 13 "trixie") and the tools by version, so a rebuild
# gives the same environment. awk is mawk, the default on Debian/Ubuntu hosts, not
# gawk (F-SEC-37). If Debian replaces a pinned version, the build fails: update the
# pins together with BASE (docker pull debian:stable-slim; apt-cache policy NAME).
BASE="debian@sha256:a717a33469731894e77e912ea7d714e27c2dc38ee6554fd1a3102e92999cfc66"
PKGS="bash=5.2.37-2+b10 coreutils=9.7-3 procps=2:4.0.4-9 findutils=4.10.0-3 grep=3.11-4+b1 sed=4.9-2+deb13u1 mawk=1.3.4.20250131-1 perl=5.40.1-6+deb13u1 age=1.2.1-1+b5 docker-cli=26.1.5+dfsg1-9+deb13u1 docker-compose=2.26.1-4 postgresql-client=17+278 ca-certificates"
IMAGE="ja-backup-linux-test:debian-$(printf '%s %s' "$BASE" "$PKGS" | cksum | cut -d' ' -f1)"
if ((REBUILD)) || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -q -t "$IMAGE" --build-arg BASE="$BASE" --build-arg PKGS="$PKGS" - >/dev/null <<'DOCKERFILE' || { echo "run-linux.sh: image build failed (a pinned package version may have been replaced: update BASE and PKGS)" >&2; exit 1; }
ARG BASE
FROM ${BASE}
ARG PKGS
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ${PKGS} \
 && test "$(readlink -f "$(command -v awk)")" = /usr/bin/mawk \
 && rm -rf /var/lib/apt/lists/*
DOCKERFILE
fi

# The suite runs as an unprivileged user (uid 1000, as an operator on the backup
# host would), so permission checks behave as there (root would bypass them). It
# gets the socket's group so it can reach the Docker daemon.
SOCK_GID="$(docker run --rm -v "$SOCK:/s" "$IMAGE" stat -c %g /s)"
exec docker run --rm -i \
  --name "${PROJECT}-runner-$$" \
  --user 1000:1000 --group-add "$SOCK_GID" \
  -v "$REPO:/repo:ro" \
  -v "$SOCK:/var/run/docker.sock" \
  -e BACKUP_TEST_PROJECT="$PROJECT" -e EVE_TEST_EXPECT_AWK=mawk \
  --tmpfs /work:rw,exec,mode=700,uid=1000,gid=1000 \
  -e HOME=/work/home -e TMPDIR=/work/tmp \
  -w /repo \
  "$IMAGE" bash -c 'mkdir -p "$HOME" "$TMPDIR" && exec bash scripts/backup/test/run-tests.sh '"$UNIT"
