-- After the down migration the 20261012130000 job work order surface is back:
-- no stamps, no automatic issue, and an approval names its approver again.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'work_orders' AND column_name IN ('quote_filled_at', 'hand_edited_at')) THEN
    RAISE EXCEPTION 'rollback: the fill and hand edit stamps must be removed';
  END IF;
  IF to_regprocedure('public.auto_issue_job_work_order(uuid, timestamptz)') IS NOT NULL
     OR to_regprocedure('public.trigger_job_work_order_auto_issue()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: the automatic issue door and sweep must be removed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_auto_issue_check') THEN
    RAISE EXCEPTION 'rollback: the automatic issue check must be removed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_work_order_auto_issue_v1') THEN
    RAISE EXCEPTION 'rollback: the automatic issue flag must be removed';
  END IF;
  IF to_regprocedure('public.approve_job_work_order(uuid, uuid, text, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'rollback: the approver''s door must remain';
  END IF;
END $$;

BEGIN;
INSERT INTO public.users (id, org_id, name, role) VALUES
  ('9913309f-35ae-4a71-8e1f-f704ecc526ea', '00000000-0000-0000-0000-000000000001', 'Shaun', 'ops_manager')
ON CONFLICT (id) DO NOTHING;
DO $$
DECLARE
  v_job uuid := gen_random_uuid();
  v_wo uuid;
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_job, '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'WOA-RB-1');
  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_job AND kind = 'job';
  UPDATE public.work_orders SET agreed_labour_ex = 500, special_instructions = 'Rear run' WHERE id = v_wo;
  BEGIN
    UPDATE public.work_orders SET approved_via = 'auto' WHERE id = v_wo;
    RAISE EXCEPTION 'rollback: approved_via auto must be refused again';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM public.approve_job_work_order(v_wo, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session',
    (SELECT updated_at FROM public.work_orders WHERE id = v_wo));
  IF (SELECT status FROM public.work_orders WHERE id = v_wo) <> 'approved' THEN
    RAISE EXCEPTION 'rollback: the approver''s approval must still seal a draft';
  END IF;
END $$;
ROLLBACK;
