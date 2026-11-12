#!/bin/bash
# Fake docker for run-tests.sh (adapted from QA qa-3; never contacts the daemon). Modes from env:
#   FAKE_DB=ok|fail|slow   FAKE_DOC=ok|slow   FAKE_RESVOL=ok|missing   FAKE_LOG=<file>
echo "$1 $2" >>"${FAKE_LOG:-/dev/null}"
stream() { # stream SECONDS
  local end=$((SECONDS + $1)); while ((SECONDS < end)); do head -c 65536 /dev/zero | tr '\0' 'F'; sleep 0.2; done; head -c 4096 /dev/zero | tr '\0' 'F'
}
case "$1" in
  ps) for a in "$@"; do [[ "$a" == label=com.docker.compose.service=postgres ]] && { echo fakepg0001; exit 0; }; done; exit 0 ;;
  exec)
    echo "EVECOUNTS tables=1 rows=1 counts=0123456789abcdef" >&2
    case "${FAKE_DB:-ok}" in
      fail) head -c 8192 /dev/zero | tr '\0' 'D'; echo "EVEFAIL pg_dump" >&2; exit 5 ;;
      slow) stream 4 ;;
      *) head -c 8192 /dev/zero | tr '\0' 'D' ;;
    esac; exit 0 ;;
  volume)
    [[ "$2" == inspect ]] || exit 0
    [[ "${FAKE_RESVOL:-ok}" == missing && "$3" == *res* ]] && exit 1
    exit 0 ;;
  run)
    echo "EVEFILES files=1" >&2
    [[ "${FAKE_DOC:-ok}" == slow ]] && stream 4 || head -c 8192 /dev/zero | tr '\0' 'T'
    exit 0 ;;
  rm | inspect | logs) exit 0 ;;
  *) exit 0 ;;
esac
