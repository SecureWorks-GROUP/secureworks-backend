#!/usr/bin/env bash
set -euo pipefail
: "${CONTRACT_DATABASE_URL:?local contract database required}"
case "$CONTRACT_DATABASE_URL" in
  postgresql://*@127.0.0.1:*/*|postgresql://*@localhost:*/*) ;;
  *) echo 'local database required' >&2; exit 2 ;;
esac

# Independent sessions race on the same booking. Holding the first transaction
# after its insert makes the other wait for commit before checking current truth.
record() {
  psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL ROLE service_role;
SELECT (public.record_visit_outcome(
  '{"booking_key":"contract-concurrent", "contact_id":"ghl-concurrent", "scoper_user_id":"5862cf1d-0a3b-4836-8fd1-d69f95aa2f73", "scoper_name":"Nithin", "visit_start":"2026-09-15T10:00:00+08:00", "outcome":"happened", "quote_owed":true}',
  '5862cf1d-0a3b-4836-8fd1-d69f95aa2f73')).id;
SELECT pg_sleep(0.2);
COMMIT;
SQL
}
record &
first_pid=$!
record &
second_pid=$!
wait "$first_pid"
wait "$second_pid"
psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM public.visit_outcomes WHERE booking_key = 'contract-concurrent') <> 1 THEN
    RAISE EXCEPTION 'contract: concurrent double tap created duplicates';
  END IF;
END $$;
SQL
