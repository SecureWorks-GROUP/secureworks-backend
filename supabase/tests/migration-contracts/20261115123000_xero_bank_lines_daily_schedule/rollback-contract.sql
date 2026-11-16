-- The runner has just run the down migration against the forward stack (no pg_cron).
\set ON_ERROR_STOP on
-- 1. The trigger is back at its 20261103170000 body, comment and grants.
DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.trigger_xero_sync_action(text)'::regprocedure)
       <> 'eeb40769f7c49507f7180e5a453fadcd' THEN
    RAISE EXCEPTION 'rollback contract: the trigger body is not the 20261103170000 one';
  END IF;
  IF obj_description('public.trigger_xero_sync_action(text)'::regprocedure, 'pg_proc') NOT LIKE '20261103170000:%' THEN
    RAISE EXCEPTION 'rollback contract: the trigger comment does not name 20261103170000 again';
  END IF;
  IF has_function_privilege('anon', 'public.trigger_xero_sync_action(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trigger_xero_sync_action(text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.trigger_xero_sync_action(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rollback contract: the trigger grants changed';
  END IF;
END $$;

-- 2. Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261115123000_xero_bank_lines_daily_schedule_down.sql
DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.trigger_xero_sync_action(text)'::regprocedure)
       <> 'eeb40769f7c49507f7180e5a453fadcd' THEN
    RAISE EXCEPTION 'rollback contract: a second rollback changed the trigger';
  END IF;
END $$;

-- 3. The forward migration applies again cleanly after a rollback.
BEGIN;
\ir ../../../migrations/20261115123000_xero_bank_lines_daily_schedule.sql
DO $$
BEGIN
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.trigger_xero_sync_action(text)'::regprocedure)
       NOT LIKE '%sync_bank_transactions%' THEN
    RAISE EXCEPTION 'rollback contract: the migration did not apply again';
  END IF;
END $$;
ROLLBACK;
