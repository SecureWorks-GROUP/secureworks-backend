-- Additional job work orders (20261119090000): a second work order on a job is
-- its own sealed record, approved only through approve_additional_work_order,
-- which adds its amount to the job's main work order as an amount change.
\ir ../../../migrations/20261119090000_additional_job_work_orders.sql
BEGIN;
\ir fixture.sql
DO $$
DECLARE
  main uuid := 'ee190000-0000-4000-8000-000000000201';
  extra uuid := 'ee190000-0000-4000-8000-000000000301';
  lonely uuid := 'ee190000-0000-4000-8000-000000000302';
  office uuid := 'ee190000-0000-4000-8000-000000000001';
  crew uuid := 'ee190000-0000-4000-8000-000000000002';
  org uuid := '00000000-0000-0000-0000-000000000001';
  stamp timestamptz; r jsonb; main_seal text;
BEGIN
  SELECT sealed_content_hash INTO main_seal FROM public.work_orders WHERE id = main;

  -- Created only as a draft.
  BEGIN
    INSERT INTO public.work_orders(org_id,job_id,wo_number,kind,status,title,agreed_labour_ex,approved_by,approved_at,sealed_content_hash)
    VALUES (org,'ee190000-0000-4000-8000-000000000101','WO-ZZTEST-R1-9','additional','approved','ZZTEST',1,office,now(),'x');
    RAISE EXCEPTION 'approved insert accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- Not approved by a plain write.
  BEGIN
    UPDATE public.work_orders SET status='approved', approved_by=office, approved_at=now(), sealed_content_hash='x' WHERE id = extra;
    RAISE EXCEPTION 'direct approval accepted';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;

  -- A crew member cannot approve.
  SELECT updated_at INTO stamp FROM public.work_orders WHERE id = extra;
  BEGIN
    PERFORM public.approve_additional_work_order(extra, crew, 'session', stamp, org);
    RAISE EXCEPTION 'crew approval accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- A stale read is refused.
  BEGIN
    PERFORM public.approve_additional_work_order(extra, office, 'session', stamp - interval '1 second', org);
    RAISE EXCEPTION 'stale approval accepted';
  EXCEPTION WHEN SQLSTATE 'WO409' THEN NULL; END;

  -- No approved main work order: refused.
  SELECT updated_at INTO stamp FROM public.work_orders WHERE id = lonely;
  BEGIN
    PERFORM public.approve_additional_work_order(lonely, office, 'session', stamp, org);
    RAISE EXCEPTION 'approval without a main work order accepted';
  EXCEPTION WHEN SQLSTATE 'WO412' THEN NULL; END;

  -- Approve: sealed, and the amount is added to the main work order.
  SELECT updated_at INTO stamp FROM public.work_orders WHERE id = extra;
  r := public.approve_additional_work_order(extra, office, 'session', stamp, org);
  IF r->>'status' <> 'approved' OR (r->>'main_work_order_id')::uuid <> main
     OR r->>'amount_change_id' IS NULL OR r->>'sealed_content_hash' IS NULL THEN
    RAISE EXCEPTION 'approval shape wrong: %', r;
  END IF;
  IF public.work_order_amount_change_total(main) <> 352 THEN
    RAISE EXCEPTION 'main work order change total % not 352', public.work_order_amount_change_total(main);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.work_orders WHERE id = main AND agreed_labour_ex = 80 AND sealed_content_hash = main_seal) THEN
    RAISE EXCEPTION 'the main work order itself changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.work_order_amount_changes WHERE id = (r->>'amount_change_id')::uuid
                 AND work_order_id = main AND from_ex = 80 AND to_ex = 432 AND reason LIKE 'Additional work order WO-ZZTEST-R1-2:%') THEN
    RAISE EXCEPTION 'amount change row wrong';
  END IF;

  -- Sealed: no edit, no delete, no second approval.
  BEGIN
    UPDATE public.work_orders SET agreed_labour_ex = 1 WHERE id = extra;
    RAISE EXCEPTION 'sealed edit accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    DELETE FROM public.work_orders WHERE id = extra;
    RAISE EXCEPTION 'sealed delete accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM public.approve_additional_work_order(extra, office, 'session', now(), org);
    RAISE EXCEPTION 'second approval accepted';
  EXCEPTION WHEN check_violation OR SQLSTATE 'WO409' THEN NULL; END;

  -- Still one main work order a job; an additional one never takes its place.
  IF public.job_live_work_order_id('ee190000-0000-4000-8000-000000000101') <> main THEN
    RAISE EXCEPTION 'job_live_work_order_id moved off the main work order';
  END IF;

  -- Trades read only crew work orders directly.
  IF (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polname = 'work_orders_job_kind_hidden_from_clients')
     NOT LIKE '%kind = ''crew''%' THEN
    RAISE EXCEPTION 'client policy not narrowed to crew';
  END IF;

  -- Job cost close counts it with the job's own.
  IF position('w.kind IN (''job'', ''additional'')' IN pg_get_functiondef('public.job_cost_close(uuid[], date)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'job_cost_close not patched';
  END IF;
END $$;
ROLLBACK;
