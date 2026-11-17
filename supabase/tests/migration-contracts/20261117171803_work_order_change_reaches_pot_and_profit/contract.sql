BEGIN;
\ir ../20261117171802_work_order_amount_changes/fixture.sql
DO $$ DECLARE wo uuid:='ee180000-0000-4000-8000-000000000201'; actor uuid:='ee180000-0000-4000-8000-000000000001'; crew uuid:='ee180000-0000-4000-8000-000000000002'; org uuid:='00000000-0000-0000-0000-000000000001'; grp uuid; r jsonb; total numeric;
BEGIN
  -- A synthetic crew member shares the changed pot.
  PERFORM public.change_work_order_amount(wo,2240,'ZZTEST initial pot',actor,org);
  INSERT INTO public.group_work_orders(org_id,job_id,work_order_id,share_token)
    VALUES(org,'ee180000-0000-4000-8000-000000000101',wo,'ZZTEST-pot-token') RETURNING id INTO grp;
  INSERT INTO public.group_work_order_participants(group_id,user_id) VALUES(grp,crew);
  INSERT INTO public.trade_rates(id,org_id,user_id,hourly_rate,effective_from) VALUES(gen_random_uuid(),org,crew,1,'2099-01-01');
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status) VALUES(gen_random_uuid(),'ee180000-0000-4000-8000-000000000101',crew,'2099-01-05','scheduled');
  INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours)
    VALUES(grp,crew,'2099-01-05','08:00','09:00',0,1);
  -- The real split gate needs confirmation newer than the synthetic hours.
  INSERT INTO public.job_client_signoffs(org_id,job_id,method,signed_name,happy,
    captured_by,captured_by_actor,capture_auth_source,capture_request_id,
    capture_payload_hash,confirmation_kind,confirmation_reference,client_confirmed_on,work_done)
    VALUES(org,'ee180000-0000-4000-8000-000000000101','office_on_behalf','ZZTEST client',true,
      actor,'user:'||actor::text,'jwt',gen_random_uuid(),'sha256:'||repeat('a',64),
      'written_confirmation','ZZTEST confirmation reference',CURRENT_DATE,'ZZTEST agreed work');
  r:=public.project_group_work_order_split(grp);
  SELECT sum((x->>'share_ex')::numeric) INTO total FROM jsonb_array_elements(r->'shares') x;
  IF total<>2240 THEN RAISE EXCEPTION 'initial pot incorrect: %',r; END IF;
  PERFORM public.change_work_order_amount(wo,2464,'ZZTEST larger pot',actor,org);
  r:=public.project_group_work_order_split(grp);
  SELECT sum((x->>'share_ex')::numeric) INTO total FROM jsonb_array_elements(r->'shares') x;
  IF total<>2464 THEN RAISE EXCEPTION 'changed pot incorrect: %',r; END IF;
  UPDATE public.group_work_orders SET approved_budget_ex=2000,budget_approved_by=actor,budget_approved_at=now(),budget_approval_reason='ZZTEST approved budget' WHERE id=grp;
  r:=public.project_group_work_order_split(grp);
  SELECT sum((x->>'share_ex')::numeric) INTO total FROM jsonb_array_elements(r->'shares') x;
  IF total<>2000 THEN RAISE EXCEPTION 'approved budget no longer wins: %',r; END IF;
  r:=public.change_work_order_amount(wo,2688,'ZZTEST unknown profit',actor,org);
  IF r->>'profit_before_ex' IS NOT NULL OR r->>'profit_after_ex' IS NOT NULL OR r->>'profit_basis'<>'not_known' THEN RAISE EXCEPTION 'unknown profit became zero'; END IF;
END $$;
-- The known-profit example waits on P0-09's canonical expected-profit source.
ROLLBACK;
