BEGIN;
DO $rollback$
/* block */ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = to_regprocedure('public.group_work_order_hours_paid_total(uuid,text)'))
     IS DISTINCT FROM '88c6927c03ef2485b10d76859c6cf160' THEN
    RAISE EXCEPTION 'P1-13.4b rollback must restore the 20261106160000 hours_paid_total body';
  END IF;
  IF to_regprocedure('public.group_work_order_hours_paid_company_super(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'P1-13.4b rollback must drop the company-super helper';
  END IF;
  IF has_function_privilege('anon','public.group_work_order_hours_paid_total(uuid,text)','execute')
     OR NOT has_function_privilege('service_role','public.group_work_order_hours_paid_total(uuid,text)','execute') THEN
    RAISE EXCEPTION 'P1-13.4b rollback must keep hours_paid_total service_role only';
  END IF;
END $rollback$;
SELECT 'PASS P1-13.4b rollback: main body restored, helper dropped';
ROLLBACK;
