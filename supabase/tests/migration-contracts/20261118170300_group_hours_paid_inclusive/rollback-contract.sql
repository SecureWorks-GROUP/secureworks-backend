BEGIN;
DO $rollback$
DECLARE failed boolean := false;
/* block */ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = to_regprocedure('public.group_work_order_hours_paid_budget(text,numeric)'))
     IS DISTINCT FROM 'ae305a17368f5384daed0b778b00ab26' THEN
    RAISE EXCEPTION 'P1-13.4 hours budget rollback must restore the 20261106160000 body';
  END IF;
  IF public.group_work_order_hours_paid_budget('all_in_12_v2', 100) IS DISTINCT FROM 112 THEN
    RAISE EXCEPTION 'P1-13.4 hours budget rollback must keep the existing bases';
  END IF;
END $rollback$;
SELECT 'PASS P1-13.4 hours budget rollback: original body restored';
ROLLBACK;
