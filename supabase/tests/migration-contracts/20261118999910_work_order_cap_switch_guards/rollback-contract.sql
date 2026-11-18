-- After the down: no preview, and the door clears the date whatever the switch.
DO $$ BEGIN
  IF to_regprocedure('public.work_order_cap_start_preview(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST rollback left the preview';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.set_work_order_cap_start(uuid,text,date,date,text)'::regprocedure)
     LIKE '%clear_while_on%' THEN
    RAISE EXCEPTION 'ZZTEST rollback left the clear refusal';
  END IF;
END $$;
BEGIN;
\ir ../../../migrations/20261118999910_work_order_cap_switch_guards.sql
ROLLBACK;
SELECT 'FU49-9b cap switch guards rollback passed' AS result;
