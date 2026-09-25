#!/usr/bin/env bash
# PB-10: two sessions approve two proposals for the same price book subject.
# Session A approves and holds its transaction; session B starts while A
# holds it. With the approval lock on the SUBJECT, B waits, then sees A's new
# row and is refused as stale. With a per-proposal lock both would approve.
set -euo pipefail

case_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
database_url=${CONTRACT_DATABASE_URL:-}
if [ -z "$database_url" ]; then
  echo "error: CONTRACT_DATABASE_URL is required" >&2
  exit 2
fi

psql "$database_url" -X -q -v ON_ERROR_STOP=1 \
  -f "$case_directory/concurrent-seed.sql" >/dev/null

output_directory=$(mktemp -d)
cleanup() {
  rm -rf "$output_directory"
}
trap cleanup EXIT

set +e
psql "$database_url" -X -q -v ON_ERROR_STOP=1 -v proposal=pb10-proposal-a -v hold=3 \
  -f "$case_directory/concurrent-worker.sql" >"$output_directory/a" 2>&1 &
pid_a=$!
sleep 1
psql "$database_url" -X -q -v ON_ERROR_STOP=1 -v proposal=pb10-proposal-b -v hold=0 \
  -f "$case_directory/concurrent-worker.sql" >"$output_directory/b" 2>&1 &
pid_b=$!
wait "$pid_a"
status_a=$?
wait "$pid_b"
status_b=$?
set -e

if [ "$status_a" -ne 0 ] || [ "$status_b" -ne 0 ]; then
  cat "$output_directory/a" "$output_directory/b"
  echo "error: a PB-10 race session failed" >&2
  exit 1
fi
if ! grep -q 'OUTCOME APPROVED' "$output_directory/a" \
   || ! grep -q 'OUTCOME STALE' "$output_directory/b"; then
  cat "$output_directory/a" "$output_directory/b"
  echo "error: PB-10 expected session A APPROVED and session B STALE" >&2
  exit 1
fi

psql "$database_url" -X -q -v ON_ERROR_STOP=1 \
  -f "$case_directory/concurrent-check.sql" >/dev/null
echo "PB-10 subject lock: second approval refused as stale"
