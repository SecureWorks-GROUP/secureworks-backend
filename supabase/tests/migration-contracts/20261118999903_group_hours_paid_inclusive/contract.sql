BEGIN;
SET LOCAL statement_timeout = '60s';
-- Rule 17: rebuild the function when an earlier contract dropped it. An old
-- body that is present is NOT healed here: that is the gap this contract
-- exists to catch (the break proof stands it back up).
SELECT to_regprocedure('public.group_work_order_hours_paid_budget(text,numeric)') IS NULL
  AS hours_budget_missing \gset
\if :hours_budget_missing
\ir pre_hours_paid_budget.sql
\ir ../../../migrations/20261118999903_group_hours_paid_inclusive.sql
\endif

DO $budget$
DECLARE failed boolean := false;
/* block */ BEGIN
  -- The inclusive branch: an hourly payment uses up its gross.
  IF public.group_work_order_hours_paid_budget('inclusive_12_112_v1', 100) IS DISTINCT FROM 100
     OR public.group_work_order_hours_paid_budget('inclusive_12_112_v1', 672.4) IS DISTINCT FROM 672.4
     OR public.group_work_order_hours_paid_budget('inclusive_12_112_v1', 0.005) IS DISTINCT FROM 0.01
     OR public.group_work_order_hours_paid_budget('inclusive_12_112_v1', 0) IS DISTINCT FROM 0
     OR public.group_work_order_hours_paid_budget('inclusive_12_112_v1', NULL) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'P1-13.4 hours budget: an inclusive group must count an hourly payment at its gross';
  END IF;
  -- Every other basis exactly as 20261106160000.
  IF public.group_work_order_hours_paid_budget('gross_v1', 100) IS DISTINCT FROM 100
     OR public.group_work_order_hours_paid_budget('all_in_12_6_v1', 100) IS DISTINCT FROM 106
     OR public.group_work_order_hours_paid_budget('all_in_12_v2', 100) IS DISTINCT FROM 112
     OR public.group_work_order_hours_paid_budget('all_in_12_v2', 0) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'P1-13.4 hours budget: the existing bases must not move';
  END IF;
  -- An unknown basis still refuses.
  BEGIN
    PERFORM public.group_work_order_hours_paid_budget('zz_unknown_basis', 100);
  EXCEPTION WHEN OTHERS THEN
    IF position('group_pay_basis_unsupported' IN SQLERRM) = 0 THEN RAISE; END IF;
    failed := true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'P1-13.4 hours budget: an unknown basis must still refuse'; END IF;
  IF has_function_privilege('anon', 'public.group_work_order_hours_paid_budget(text,numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.group_work_order_hours_paid_budget(text,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P1-13.4 hours budget: execute must stay service_role only';
  END IF;
END $budget$;

-- Where the registered stack holds the paid-hours total, an inclusive group
-- with no hourly pay on its job reads 0, not an error.
SELECT to_regprocedure('public.group_work_order_hours_paid_total(uuid,text)') IS NOT NULL AS hours_total_present \gset
\if :hours_total_present
DO $total$
/* block */ BEGIN
  IF public.group_work_order_hours_paid_total('99903000-0000-4000-8000-000000000001', 'inclusive_12_112_v1') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'P1-13.4 hours budget: a job with no hourly pay must read 0 on the inclusive basis';
  END IF;
END $total$;
\endif

SELECT 'PASS P1-13.4 hours budget: inclusive counts hourly pay at its gross; other bases unchanged';
ROLLBACK;
