-- After the down: the fence flag, the helper and the combined view are gone;
-- the patio auto-group (flag, view, office-fee helper) is still there.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regclass('public.v_group_coverage') IS NOT NULL
     OR to_regprocedure('public.group_work_order_labour_outside_pool(jsonb)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name='group_work_order_auto_fence_v1') THEN
    RAISE EXCEPTION 'rollback left V8 fence objects behind';
  END IF;
  IF to_regclass('public.v_patio_group_coverage') IS NULL
     OR to_regprocedure('public.group_work_order_line_is_office_fee(text,text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name='group_work_order_auto_patio_v1') THEN
    RAISE EXCEPTION 'rollback took the patio auto-group with it';
  END IF;
END $$;
