DO $$ BEGIN
  IF to_regprocedure('public.work_order_backed_billed(uuid[],uuid[])') IS NOT NULL OR
     to_regprocedure('public.work_order_backed_line(text,text)') IS NOT NULL OR
     to_regprocedure('public.work_order_backed_invoice(text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST billed helpers survived rollback';
  END IF;
END $$;
-- The forward pre-image check verifies every restored body.
BEGIN;
\ir ../../../migrations/20261118153101_work_order_backed_billed.sql
ROLLBACK;
SELECT 'P1-05.9 shared billed room rollback passed' AS result;
