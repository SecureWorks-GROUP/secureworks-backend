-- The runner has just run the down migration against the forward stack.
-- 1. Every workshop table and the cron trigger are gone; the debt desk's
--    settings (an earlier migration) are untouched.
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'debt_ws_settings', 'debt_ws_log', 'debt_ws_suggestions', 'debt_ws_states',
    'debt_ws_sends', 'debt_ws_statements', 'debt_ws_jan_lists'
  ] LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      RAISE EXCEPTION 'rollback contract: % is still there', v_table;
    END IF;
  END LOOP;
  IF to_regprocedure('public.trigger_debt_ws_jan_list(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: the Jan list trigger is still there';
  END IF;
  IF to_regclass('public.debt_desk_settings') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the rollback removed debt_desk_settings';
  END IF;
END $$;

-- 2. Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261008170000_debt_workshop_down.sql

-- 3. The forward migration applies again cleanly after a rollback.
BEGIN;
\ir ../../../migrations/20261008170000_debt_workshop.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM public.debt_ws_settings) <> 1 THEN
    RAISE EXCEPTION 'rollback contract: re-apply after rollback did not seed settings';
  END IF;
  IF (SELECT company_aliases->>'4d7121e3-89d5-4021-8880-ce9e8c4f1a91'
        FROM public.debt_ws_settings WHERE id = 1)
     IS DISTINCT FROM '96abb9b3-89d5-4021-8880-ce9e8c4f1a91' THEN
    RAISE EXCEPTION 'rollback contract: re-apply after rollback did not seed the company aliases';
  END IF;
END $$;
ROLLBACK;
