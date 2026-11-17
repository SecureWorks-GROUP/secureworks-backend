-- The runner has just run the down migration against the forward stack (no pg_cron).
\set ON_ERROR_STOP on
-- 1. The trigger the daily-digest job calls is still there, with its grants.
DO $$
BEGIN
  IF to_regprocedure('public.trigger_daily_digest_action(text)') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the digest trigger was removed';
  END IF;
  IF has_function_privilege('anon', 'public.trigger_daily_digest_action(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trigger_daily_digest_action(text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.trigger_daily_digest_action(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rollback contract: the digest trigger grants changed';
  END IF;
END $$;

-- 2. Re-running the rollback is a no-op, and the migration applies again after it.
\ir ../../../rollbacks/20261117150000_daily_digest_build_cron_down.sql
BEGIN;
\ir ../../../migrations/20261117150000_daily_digest_build_cron.sql
DO $$
BEGIN
  IF obj_description('public.trigger_daily_digest_action(text)'::regprocedure, 'pg_proc') NOT LIKE '20261117150000:%' THEN
    RAISE EXCEPTION 'rollback contract: the migration did not apply again';
  END IF;
END $$;
ROLLBACK;
