BEGIN;
DO $check$ BEGIN
 IF to_regprocedure('public.job_profit_stored_compare(uuid[])') IS NOT NULL THEN RAISE EXCEPTION 'rollback left id compare'; END IF;
 IF to_regprocedure('public.job_profit_stored_compare(integer)') IS NULL THEN RAISE EXCEPTION 'rollback removed company compare'; END IF;
 IF to_regprocedure('public.job_profit_refresh_due()') IS NOT NULL
  OR to_regprocedure('public.job_profit_refresh_install()') IS NOT NULL THEN RAISE EXCEPTION 'rollback left entry point'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='job_profit_changed') THEN RAISE EXCEPTION 'rollback left trigger'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.job_profit_change_events WHERE job_id='ffffffff-ffff-4fff-8fff-ffffffffff45' AND reason='rollback_fixture') THEN RAISE EXCEPTION 'rollback lost pending evidence'; END IF;
 IF to_regprocedure('public.job_profit_refresh_many(uuid[])') IS NULL THEN RAISE EXCEPTION 'rollback removed existing writer'; END IF;
END $check$;
SELECT 'PASS: rollback removes only this install and retains queued evidence and existing writer' AS result;
ROLLBACK;
