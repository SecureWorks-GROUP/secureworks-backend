-- After the down: the door, the record trigger and its install functions are gone; the record table is kept.
DO $$ BEGIN
  IF to_regprocedure('public.set_work_order_cap_start(uuid,text,date,date,text)') IS NOT NULL
     OR to_regprocedure('public.work_order_cap_settings_record()') IS NOT NULL
     OR to_regprocedure('public.install_work_order_cap_start_record()') IS NOT NULL
     OR to_regprocedure('public.remove_work_order_cap_start_record()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'work_order_cap_settings_record') THEN
    RAISE EXCEPTION 'ZZTEST cap start door survived rollback';
  END IF;
  IF to_regclass('public.work_order_cap_start_changes') IS NULL
     OR to_regclass('public.work_order_cap_settings') IS NULL THEN
    RAISE EXCEPTION 'ZZTEST rollback dropped the record or the settings';
  END IF;
END $$;
-- A re-apply over the kept record works, inside a transaction thrown away.
BEGIN;
\ir ../../../migrations/20261118194100_work_order_cap_start_set.sql
ROLLBACK;
SELECT 'FU49-9b cap start set rollback passed' AS result;
