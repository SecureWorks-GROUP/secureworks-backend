DO $$ BEGIN
  IF to_regprocedure('public.work_order_cap_scope(uuid[])') IS NOT NULL
     OR to_regclass('public.work_order_cap_settings') IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST cap scope survived rollback';
  END IF;
END $$;
-- The forward pre-image check verifies both restored guard bodies.
BEGIN;
\ir ../../../migrations/20261118193817_work_order_cap_start_date.sql
ROLLBACK;
SELECT 'FU49-9b work order cap start date rollback passed' AS result;
