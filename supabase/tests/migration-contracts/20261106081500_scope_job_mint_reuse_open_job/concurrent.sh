#!/usr/bin/env bash
# Two scopers start a job for the same new customer, one typing the email and
# one the mobile. Exactly one job is made, and both get it.
set -euo pipefail

case_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
database_url=${CONTRACT_DATABASE_URL:-}
if [ -z "$database_url" ]; then
  echo "error: CONTRACT_DATABASE_URL is required" >&2
  exit 2
fi

# One round: session b starts after the given delay. 0 means both arrive
# together; 1.5 means b arrives after a has made the job, so b must reuse it.
run_round() {
  local delay_b=$1
  local label=$2
  psql "$database_url" -X -v ON_ERROR_STOP=1 -f "$case_directory/concurrent-seed.sql" >/dev/null

  local status_a status_b pid_a pid_b result_a result_b
  set +e
  psql "$database_url" -X -v ON_ERROR_STOP=1 \
    -v req=00000000-0000-4000-8000-000000000a01 -v key=email:race@example.com -v opp=oppRaceA -v delay=0 \
    -f "$case_directory/concurrent-worker.sql" >"$output_directory/a" 2>&1 &
  pid_a=$!
  psql "$database_url" -X -v ON_ERROR_STOP=1 \
    -v req=00000000-0000-4000-8000-000000000a02 -v key=phone:0400000077 -v opp=oppRaceB -v delay="$delay_b" \
    -f "$case_directory/concurrent-worker.sql" >"$output_directory/b" 2>&1 &
  pid_b=$!
  wait "$pid_a"
  status_a=$?
  wait "$pid_b"
  status_b=$?
  set -e

  if [ "$status_a" -ne 0 ] || [ "$status_b" -ne 0 ]; then
    cat "$output_directory/a" "$output_directory/b"
    echo "error: $label: a mint session failed" >&2
    exit 1
  fi

  result_a=$(grep -o 'RESULT decision=[a-z]* job=[0-9a-f-]*' "$output_directory/a" || true)
  result_b=$(grep -o 'RESULT decision=[a-z]* job=[0-9a-f-]*' "$output_directory/b" || true)
  case "$result_a" in
    "RESULT decision=complete job="?*) ;;
    *) cat "$output_directory/a" "$output_directory/b"; echo "error: $label: session a did not finish with a job" >&2; exit 1 ;;
  esac
  if [ "$result_a" != "$result_b" ]; then
    cat "$output_directory/a" "$output_directory/b"
    echo "error: $label: the two sessions got different results: '$result_a' and '$result_b'" >&2
    exit 1
  fi

  psql "$database_url" -X -v ON_ERROR_STOP=1 -f "$case_directory/concurrent-check.sql" >/dev/null
}

output_directory=$(mktemp -d)
cleanup() {
  rm -rf "$output_directory"
}
trap cleanup EXIT

run_round 0 "together"
run_round 1.5 "second after the first made the job"
