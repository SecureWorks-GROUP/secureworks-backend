#!/usr/bin/env bash
set -euo pipefail

case_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
database_url=${CONTRACT_DATABASE_URL:-}
if [ -z "$database_url" ]; then
  echo "error: CONTRACT_DATABASE_URL is required" >&2
  exit 2
fi

psql "$database_url" -X -v ON_ERROR_STOP=1 \
  -f "$case_directory/concurrent-seed.sql" >/dev/null

output_directory=$(mktemp -d)
cleanup() {
  rm -rf "$output_directory"
}
trap cleanup EXIT

set +e
psql "$database_url" -X -v ON_ERROR_STOP=1 \
  -v lease_owner=concurrent-worker-a -v actor=contract-concurrent-a \
  -f "$case_directory/concurrent-worker.sql" >"$output_directory/a" 2>&1 &
pid_a=$!
psql "$database_url" -X -v ON_ERROR_STOP=1 \
  -v lease_owner=concurrent-worker-b -v actor=contract-concurrent-b \
  -f "$case_directory/concurrent-worker.sql" >"$output_directory/b" 2>&1 &
pid_b=$!
wait "$pid_a"
status_a=$?
wait "$pid_b"
status_b=$?
set -e

if [ "$status_a" -ne 0 ] || [ "$status_b" -ne 0 ]; then
  cat "$output_directory/a" "$output_directory/b"
  echo "error: concurrent invoice retry session failed" >&2
  exit 1
fi

claimed=0
held=0
if grep -Fxq 'CLAIMED' "$output_directory/a"; then
  claimed=$((claimed + 1))
fi
if grep -Fxq 'CLAIMED' "$output_directory/b"; then
  claimed=$((claimed + 1))
fi
if grep -Fxq 'HELD' "$output_directory/a"; then
  held=$((held + 1))
fi
if grep -Fxq 'HELD' "$output_directory/b"; then
  held=$((held + 1))
fi

if [ "$claimed" -ne 1 ] || [ "$held" -ne 1 ]; then
  cat "$output_directory/a" "$output_directory/b"
  echo "error: expected one CLAIMED and one HELD session; got claimed=$claimed held=$held" >&2
  exit 1
fi

psql "$database_url" -X -v ON_ERROR_STOP=1 \
  -f "$case_directory/concurrent-check.sql" >/dev/null
