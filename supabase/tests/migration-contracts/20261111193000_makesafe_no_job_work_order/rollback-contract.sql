-- After the down migration a make-safe is treated like every other job type
-- again, the rule and the retirement are gone, and the record of what was
-- removed is kept.
BEGIN;
DO $$
DECLARE
  v_safe uuid := gen_random_uuid();
  v_wo uuid;
BEGIN
  ASSERT to_regprocedure('public.job_type_never_gets_job_work_order(text)') IS NULL,
    'the down migration drops the rule';
  ASSERT to_regprocedure('public.retire_blank_makesafe_job_work_orders()') IS NULL,
    'the down migration drops the retirement';
  ASSERT to_regclass('public.job_work_order_retired_drafts') IS NOT NULL,
    'the down migration keeps the record of what was removed';
  ASSERT (SELECT description NOT LIKE '%make-safe%' AND enabled IS NOT TRUE FROM public.feature_flags
          WHERE flag_name = 'job_work_order_all_types_v1'),
    'the switch has its earlier description and is still off';

  INSERT INTO public.jobs (id, org_id, type, status, job_number)
    VALUES (v_safe, '00000000-0000-0000-0000-000000000001', 'makesafe', 'scheduled', 'ZZTEST-MSNOWO-RB-1');
  ASSERT NOT EXISTS (SELECT 1 FROM public.work_orders WHERE job_id = v_safe AND kind = 'job'),
    'the switch off: a make-safe opens nothing, as before';

  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_work_order_all_types_v1';
  v_wo := public.ensure_job_work_order_draft(v_safe, 'manual');
  ASSERT v_wo IS NOT NULL AND (SELECT status = 'draft' AND agreed_labour_ex IS NULL
                               FROM public.work_orders WHERE id = v_wo),
    'the switch on: a make-safe opens a blank draft again';
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
    VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'makesafe', 'scheduled', 'ZZTEST-MSNOWO-RB-2')
    RETURNING id INTO v_safe;
  ASSERT (SELECT count(*) = 1 FROM public.work_orders WHERE job_id = v_safe AND kind = 'job' AND origin = 'job_approved'),
    'the switch on: the job trigger opens a make-safe its blank draft again';
  ASSERT has_function_privilege('service_role', 'public.apply_active_job_work_orders(uuid[])', 'EXECUTE')
     AND has_function_privilege('service_role', 'public.preview_active_job_work_orders()', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.apply_active_job_work_orders(uuid[])', 'EXECUTE'),
    'the backfill keeps its grants';
END $$;
ROLLBACK;
