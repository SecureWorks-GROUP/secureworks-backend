#!/usr/bin/env bash
# Two sessions against the saved job story's claim (20261009100000): while one
# session holds the first request in the queue (an asked request, which a claim
# takes first), a second worker's claim skips it and takes the next one at once,
# never waiting for it and never taking it twice (FOR UPDATE SKIP LOCKED). Every
# row is removed afterwards and the switch is put back off.
set -euo pipefail

database_url=${CONTRACT_DATABASE_URL:-}
if [ -z "$database_url" ]; then
  echo "error: CONTRACT_DATABASE_URL is required" >&2
  exit 2
fi
case "$database_url" in
  postgresql://*@127.0.0.1:*/*|postgres://*@127.0.0.1:*/*|postgresql://*@localhost:*/*|postgres://*@localhost:*/*)
    ;;
  *)
    echo "error: contract database must target localhost" >&2
    exit 2
    ;;
esac

output_directory=$(mktemp -d)
q() {
  psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At "$@"
}
cleanup() {
  q <<'SQL' >/dev/null 2>&1 || true
SET session_replication_role = replica;
DELETE FROM public.context_job_story_requests WHERE id IN ('5e100000-0000-4000-8000-000000000091', '5e100000-0000-4000-8000-000000000092');
DELETE FROM public.jobs WHERE id IN ('5e000000-0000-4000-8000-000000000091', '5e000000-0000-4000-8000-000000000092');
UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'context_job_story_text_v1';
SQL
  rm -rf "$output_directory"
}
trap cleanup EXIT

q <<'SQL'
SET session_replication_role = replica;
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'context_job_story_text_v1';
UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, metadata, created_at, updated_at)
VALUES ('5e000000-0000-4000-8000-000000000091', '00000000-0000-4000-8000-0000000000aa', 'SWF-ST091', 'scheduled', 'fencing', 'Client 91', '{}',
        '2026-09-01 01:00Z', '2026-09-01 01:00Z'),
       ('5e000000-0000-4000-8000-000000000092', '00000000-0000-4000-8000-0000000000aa', 'SWF-ST092', 'scheduled', 'fencing', 'Client 92', '{}',
        '2026-09-01 01:00Z', '2026-09-01 01:00Z');
DELETE FROM public.context_job_story_requests WHERE done_at IS NULL;
INSERT INTO public.context_job_story_requests (id, job_id, requested_by, reason, requested_at)
VALUES ('5e100000-0000-4000-8000-000000000091', '5e000000-0000-4000-8000-000000000091', 'user:5e0000ff-0000-4000-8000-000000000001', 'asked',
        now() - interval '2 minutes'),
       ('5e100000-0000-4000-8000-000000000092', '5e000000-0000-4000-8000-000000000092', 'luna-story-writer', 'job_changed',
        now() - interval '1 hour');
SQL

# Wait until the holding session is asleep, so its row lock is held.
wait_for_holder() {
  local i
  for i in $(seq 1 100); do
    if [ "$(q -c "SELECT count(*) FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND query LIKE '%story-claim-holder%' AND pid <> pg_backend_pid()")" -ge 1 ]; then
      return 0
    fi
    sleep 0.1
  done
  echo "error: the holding session never started" >&2
  exit 1
}

psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At \
  -c "BEGIN" \
  -c "SELECT id FROM public.context_job_story_requests WHERE id = '5e100000-0000-4000-8000-000000000091' FOR UPDATE" \
  -c "SELECT pg_sleep(30) /* story-claim-holder */" \
  -c "ROLLBACK" >"$output_directory/holder" 2>&1 &
holder=$!
wait_for_holder

# The second worker: the day's calls cleared inside its own transaction (so the
# budget is whatever this case says, not what earlier cases left), a 5-second
# ceiling (waiting on the held row would hit it), then the claim.
claimed=$(q -c "BEGIN" \
  -c "SET LOCAL statement_timeout = '5s'" \
  -c "DELETE FROM public.context_model_call_reservations WHERE run_date = (now() AT TIME ZONE 'Australia/Perth')::date" \
  -c "SELECT (public.context_job_story_claim(1) -> 'requests' -> 0 ->> 'request_id')" \
  -c "ROLLBACK")

q -c "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE query LIKE '%story-claim-holder%' AND pid <> pg_backend_pid()" >/dev/null
wait "$holder" || true

if [ "$claimed" != "5e100000-0000-4000-8000-000000000092" ]; then
  cat "$output_directory/holder"
  echo "error: a claim beside a held request did not take the next one (got '${claimed}')" >&2
  exit 1
fi
echo "story claim skips a held request: ok"
