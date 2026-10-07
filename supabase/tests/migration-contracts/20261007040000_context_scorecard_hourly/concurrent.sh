#!/usr/bin/env bash
# Two sessions against the hourly scorecard run (20261007040000).
#
#  1. One run at a time: while another session holds the recorder's lock, a
#     second call records nothing and says it skipped.
#  2. The job's exact command shape, sent as pg_cron sends it (one simple
#     query: SET; SET; SELECT): each SET governs the SELECT after it. With the
#     scorecard held behind a table lock, the command's own lock timeout, then
#     its own statement timeout, cut the run, and each hour is stored as a
#     failed run with its code instead of being lost. The status read then tells
#     the hourly reader the check is failing (since when, which code, how many in
#     a row), and the reader's receipt of that failure is kept as failing. Every
#     row is deleted afterwards (receipts go with their runs), so nothing
#     outlives this script.
set -euo pipefail

database_url=${CONTRACT_DATABASE_URL:-}
if [ -z "$database_url" ]; then
  echo "error: CONTRACT_DATABASE_URL is required" >&2
  exit 2
fi

output_directory=$(mktemp -d)
cleanup() {
  rm -rf "$output_directory"
}
trap cleanup EXIT

q() {
  psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At "$@"
}

# Wait until the holding session is asleep, so its lock is held.
wait_for_holder() {
  local marker=$1
  local i
  for i in $(seq 1 100); do
    if [ "$(q -c "SELECT count(*) FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND query LIKE '%${marker}%' AND pid <> pg_backend_pid()")" -ge 1 ]; then
      return 0
    fi
    sleep 0.1
  done
  echo "error: the holding session ${marker} never started" >&2
  exit 1
}

# End a holding session once its check is done (its sleep is only an upper bound).
release_holder() {
  local marker=$1
  local pid=$2
  q -c "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE query LIKE '%${marker}%' AND pid <> pg_backend_pid()" >/dev/null
  wait "$pid" || true
}

# 1. One run at a time.
psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At \
  -c "BEGIN" \
  -c "SELECT pg_advisory_xact_lock(hashtextextended('context_scorecard_record_run', 0))" \
  -c "SELECT pg_sleep(30) /* hourly-holder-lock */" \
  -c "ROLLBACK" >"$output_directory/holder-lock" 2>&1 &
holder=$!
wait_for_holder hourly-holder-lock
skipped=$(q -c "BEGIN" -c "SELECT public.context_scorecard_record_run('manual')->>'skipped'" -c "ROLLBACK")
release_holder hourly-holder-lock "$holder"
if [ "$skipped" != "another_run_in_progress" ]; then
  cat "$output_directory/holder-lock"
  echo "error: a second run while one held the lock did not skip: '${skipped}'" >&2
  exit 1
fi

# 2. The job's command, as one simple query, with the scorecard held behind a lock.
command=$(q -c "SELECT public.context_scorecard_run_policy()->>'command'")
expected="SET statement_timeout = '60s'; SET lock_timeout = '10s'; SELECT public.context_scorecard_record_run('cron')"
if [ "$command" != "$expected" ]; then
  echo "error: the policy's command is not the one this script tests: ${command}" >&2
  exit 1
fi
lock_command=${command/"lock_timeout = '10s'"/"lock_timeout = '300ms'"}
statement_command=${command/"statement_timeout = '60s'"/"statement_timeout = '1s'"}

psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At \
  -c "BEGIN" \
  -c "LOCK TABLE public.business_events IN ACCESS EXCLUSIVE MODE" \
  -c "SELECT pg_sleep(30) /* hourly-holder-table */" \
  -c "ROLLBACK" >"$output_directory/holder-table" 2>&1 &
holder=$!
wait_for_holder hourly-holder-table
set +e
psql "$database_url" -X -q -v ON_ERROR_STOP=1 -c "$lock_command" >"$output_directory/run-lock" 2>&1
status_lock=$?
psql "$database_url" -X -q -v ON_ERROR_STOP=1 -c "$statement_command" >"$output_directory/run-statement" 2>&1
status_statement=$?
set -e
release_holder hourly-holder-table "$holder"
if [ "$status_lock" -ne 0 ] || [ "$status_statement" -ne 0 ]; then
  cat "$output_directory/run-lock" "$output_directory/run-statement" "$output_directory/holder-table"
  echo "error: the job's command did not return after its own timeout" >&2
  exit 1
fi

runs=$(q -c "SELECT coalesce(string_agg(status || ':' || coalesce(error_code, '-') || ':' || run_trigger, ',' ORDER BY id), '') FROM public.context_scorecard_runs")
report=$(q -c "SELECT concat_ws('|', s->'report'->>'kind', s->>'consecutive_failures', (s->'report'->>'run_id')::bigint = (SELECT max(id) FROM public.context_scorecard_runs), (s->'report'->>'failing_since')::timestamptz = (SELECT min(as_of) FROM public.context_scorecard_runs), s->'report'->>'message' LIKE 'Context system hourly check failing since % Perth on % (57014): 2 failed runs in a row. No good run is stored yet.', position('the newest run failed (57014), 2 in a row' IN s->'lane'->>'note') > 0) FROM (SELECT public.context_scorecard_run_status() AS s) x")
receipt=$(q -c "SELECT public.context_scorecard_record_receipt('rayleigh', (SELECT id FROM public.context_scorecard_runs ORDER BY as_of DESC, id DESC LIMIT 1), '{}')->>'kind'")
q -c "DELETE FROM public.context_scorecard_runs"
left=$(q -c "SELECT (SELECT count(*) FROM public.context_scorecard_runs) + (SELECT count(*) FROM public.context_scorecard_receipts)")
if [ "$runs" != "failed:55P03:cron,failed:57014:cron" ]; then
  echo "error: expected two failed cron runs (55P03 then 57014); got runs '${runs}'" >&2
  exit 1
fi
if [ "$report" != "failing|2|t|t|t|t" ] || [ "$receipt" != "failing" ]; then
  echo "error: the failing hours were not reported to the reader; got report '${report}' receipt '${receipt}'" >&2
  exit 1
fi
if [ "$left" != "0" ]; then
  echo "error: ${left} rows outlived the script" >&2
  exit 1
fi
echo "hourly scorecard concurrent sessions passed"
