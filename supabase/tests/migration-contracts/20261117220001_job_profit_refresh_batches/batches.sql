\set ON_ERROR_STOP on
SET statement_timeout='120s';
INSERT INTO public.organisations(id,name) VALUES('f0210000-0000-4000-8000-000000000010','ZZTEST batch organisation');
INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata,pricing_json,created_at)
SELECT ('ffffffff-ffff-4fff-8fff-ffffffffff0'||n)::uuid,
 'f0210000-0000-4000-8000-000000000010','complete','fencing','ZZTEST-FU21-PAGE-'||n,'{}','{}','2026-06-01'
FROM generate_series(1,3) n;
BEGIN;
SELECT public.job_profit_refresh_all('ffffffff-ffff-4fff-8fff-ffffffffff00',2) AS first_page \gset
COMMIT;
SELECT :'first_page'::jsonb->>'next_after' AS next_after \gset
DO $locks$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory') THEN
  RAISE EXCEPTION 'FU21 batch commit retained advisory locks'; END IF;
END $locks$;
BEGIN;
SELECT public.job_profit_refresh_all(:'next_after'::uuid,2) AS last_page \gset
COMMIT;
SELECT set_config('fu21.last_page',:'last_page',false);
DO $last$ DECLARE r jsonb:=current_setting('fu21.last_page')::jsonb; BEGIN
 IF r->>'done'<>'true' OR r->>'refreshed'<>'1' OR r->>'next_after'<>'ffffffff-ffff-4fff-8fff-ffffffffff03' THEN
  RAISE EXCEPTION 'FU21 last page skipped or repeated jobs: %',r; END IF;
 IF EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory')
  OR (SELECT count(*) FROM public.job_profit_stored WHERE job_number LIKE 'ZZTEST-FU21-PAGE-%')<>3 THEN
  RAISE EXCEPTION 'FU21 three jobs not committed without retained locks'; END IF;
END $last$;
SELECT 'PASS: FU21 two transactions fill three jobs and release batch advisory locks' AS result;
