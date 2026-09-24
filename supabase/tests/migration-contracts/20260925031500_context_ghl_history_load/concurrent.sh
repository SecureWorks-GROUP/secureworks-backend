#!/usr/bin/env bash
set -euo pipefail
: "${CONTRACT_DATABASE_URL:?local contract database required}"
case "$CONTRACT_DATABASE_URL" in
  postgresql://*@127.0.0.1:*/*|postgresql://*@localhost:*/*) ;;
  *) echo 'local database required' >&2; exit 2 ;;
esac

# M4: two real history-load runs started at the same moment. The first holds
# its reservation open; the second must wait for it and then be refused
# (run_in_progress), never take the same remaining quota.
psql "$CONTRACT_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
DELETE FROM public.context_capture_runs WHERE source='ghl_history_load';
INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at,updated_at)
VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000001','in_progress','fencing','M4-CONC-1','m4ConcContact0001',now(),now());
SQL
out_a=$(mktemp); out_b=$(mktemp)
psql "$CONTRACT_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1 >"$out_a" <<'SQL' &
BEGIN;
SELECT public.reserve_ghl_history_run(20,'m4-first')->>'outcome';
SELECT pg_sleep(3);
COMMIT;
SQL
first=$!
sleep 1
psql "$CONTRACT_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1 >"$out_b" <<'SQL'
SELECT public.reserve_ghl_history_run(20,'m4-second')->>'outcome';
SQL
wait "$first"
a=$(grep -E '^(reserved|run_in_progress)$' "$out_a" || true)
b=$(grep -E '^(reserved|run_in_progress)$' "$out_b" || true)
rm -f "$out_a" "$out_b"
if [ "$a" != "reserved" ] || [ "$b" != "run_in_progress" ]; then
  echo "contract: concurrent reservations gave first=$a second=$b" >&2
  exit 1
fi
psql "$CONTRACT_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM public.context_capture_runs WHERE source='ghl_history_load')<>1
   OR (SELECT sum((counts->>'jobs_covered')::integer) FROM public.context_capture_runs WHERE source='ghl_history_load')<>1
  THEN RAISE EXCEPTION 'contract: the quota was reserved twice'; END IF;
END $$;
DELETE FROM public.context_capture_runs WHERE source='ghl_history_load';
DELETE FROM public.jobs WHERE job_number='M4-CONC-1';
SQL
