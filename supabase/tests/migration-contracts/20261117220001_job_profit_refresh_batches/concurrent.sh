#!/usr/bin/env bash
set -euo pipefail
case_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
: "${CONTRACT_DATABASE_URL:?disposable runner database required}"
cleanup() {
 psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DELETE FROM public.job_profit_dirty WHERE job_id IN ('ffffffff-ffff-4fff-8fff-ffffffffff01','ffffffff-ffff-4fff-8fff-ffffffffff02','ffffffff-ffff-4fff-8fff-ffffffffff03');
DELETE FROM public.job_cost_events_stored WHERE job_id IN ('ffffffff-ffff-4fff-8fff-ffffffffff01','ffffffff-ffff-4fff-8fff-ffffffffff02','ffffffff-ffff-4fff-8fff-ffffffffff03');
DELETE FROM public.job_revenue_events_stored WHERE job_id IN ('ffffffff-ffff-4fff-8fff-ffffffffff01','ffffffff-ffff-4fff-8fff-ffffffffff02','ffffffff-ffff-4fff-8fff-ffffffffff03');
DELETE FROM public.job_profit_stored WHERE job_id IN ('ffffffff-ffff-4fff-8fff-ffffffffff01','ffffffff-ffff-4fff-8fff-ffffffffff02','ffffffff-ffff-4fff-8fff-ffffffffff03');
DELETE FROM public.jobs WHERE id IN ('ffffffff-ffff-4fff-8fff-ffffffffff01','ffffffff-ffff-4fff-8fff-ffffffffff02','ffffffff-ffff-4fff-8fff-ffffffffff03');
DELETE FROM public.organisations WHERE id='f0210000-0000-4000-8000-000000000010';
SQL
}
trap cleanup EXIT
psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$case_dir/batches.sql"
psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT public.job_profit_mark('ffffffff-ffff-4fff-8fff-ffffffffff01','cost');
SQL
before=$(psql "$CONTRACT_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 -c "SELECT md5(string_agg(to_jsonb(s)::text,',' ORDER BY job_id)) FROM public.job_profit_stored s")
if output=$(psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$case_dir/timeout.sql" 2>&1); then
 echo 'FU21 expected statement timeout did not occur' >&2
 exit 1
fi
if ! [[ "$output" == *'canceling statement due to statement timeout'* ]]; then
 printf '%s\n' "$output" >&2
 exit 1
fi
after=$(psql "$CONTRACT_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 -c "SELECT md5(string_agg(to_jsonb(s)::text,',' ORDER BY job_id)) FROM public.job_profit_stored s")
[[ "$before" == "$after" ]] || { echo 'FU21 timeout changed committed store' >&2; exit 1; }
psql "$CONTRACT_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SET statement_timeout='120s';
DO $unchanged$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.job_profit_dirty WHERE job_id='ffffffff-ffff-4fff-8fff-ffffffffff01') THEN
  RAISE EXCEPTION 'FU21 timeout consumed dirty mark'; END IF;
END $unchanged$;
SELECT public.job_profit_refresh('ffffffff-ffff-4fff-8fff-ffffffffff01');
DO $retried$ BEGIN
 IF EXISTS(SELECT 1 FROM public.job_profit_dirty WHERE job_id='ffffffff-ffff-4fff-8fff-ffffffffff01') THEN
  RAISE EXCEPTION 'FU21 timeout retry failed'; END IF;
END $retried$;
SET statement_timeout=0;
DO $deadline$ BEGIN
 BEGIN PERFORM public.job_profit_refresh('ffffffff-ffff-4fff-8fff-ffffffffff01'); RAISE EXCEPTION 'FU21 unlimited refresh survived';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'job_profit_refresh_requires_timeout_120s_or_less' THEN RAISE; END IF; END;
END $deadline$;
SELECT 'PASS: FU21 timeout cancels atomically, keeps dirty mark, retries, and refuses an unlimited caller' AS result;
SQL
