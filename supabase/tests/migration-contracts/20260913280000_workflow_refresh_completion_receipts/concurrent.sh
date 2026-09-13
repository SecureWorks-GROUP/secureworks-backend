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
psql "$database_url" -X -At -v ON_ERROR_STOP=1 -v actor=concurrent-a \
  -f "$case_directory/concurrent-worker.sql" >"$output_directory/a" 2>&1 &
pid_a=$!
psql "$database_url" -X -At -v ON_ERROR_STOP=1 -v actor=concurrent-b \
  -f "$case_directory/concurrent-worker.sql" >"$output_directory/b" 2>&1 &
pid_b=$!
wait "$pid_a"
status_a=$?
wait "$pid_b"
status_b=$?
set -e

if [ "$status_a" -ne 0 ] || [ "$status_b" -ne 0 ]; then
  cat "$output_directory/a" "$output_directory/b"
  echo "error: concurrent Refresh session failed" >&2
  exit 1
fi

if ! grep -Fxq 'START_OK' "$output_directory/a" \
  || ! grep -Fxq 'START_OK' "$output_directory/b"; then
  cat "$output_directory/a" "$output_directory/b"
  echo "error: both concurrent sessions must start or join" >&2
  exit 1
fi

psql "$database_url" -X -v ON_ERROR_STOP=1 \
  -f "$case_directory/concurrent-check.sql" >/dev/null
