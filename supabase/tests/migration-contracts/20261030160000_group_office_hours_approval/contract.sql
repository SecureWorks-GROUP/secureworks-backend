-- The office approves a crew's hours on their behalf: attributed, reasoned,
-- refused for someone on the crew, a frozen split or a void group, and never
-- written as a crew signature. Synthetic records only; rolled back.
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  office uuid := '9913309f-35ae-4a71-8e1f-f704ecc526ea';
  henry uuid := 'f0310000-0000-4000-8000-0000000000aa';
  isaac uuid := 'f0310000-0000-4000-8000-0000000000ab';
  job uuid := 'f0310000-0000-4000-8000-000000000111';
  wo uuid := 'f0310000-0000-4000-8000-000000000311';
  grp uuid := 'f0310000-0000-4000-8000-000000000211';
  r jsonb; g record; refused text; n int;
BEGIN
  INSERT INTO public.users(id,org_id,name,role) VALUES
    (office,org,'Synthetic Office','ops_manager'),(henry,org,'Henry Synthetic','ops_manager'),
    (isaac,org,'Isaac Synthetic','crew') ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES(job,org,'patio','quoted','SYN-OFFICE-HOURS');
  INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items,special_instructions)
    VALUES(wo,org,job,'SYN-OFFICE-HOURS-WO','job','draft',1000,'[]','Synthetic office hours proof');
  UPDATE public.work_orders SET status='approved',approved_by=office WHERE id=wo;
  INSERT INTO public.group_work_orders(id,org_id,job_id,work_order_id,share_token,pay_basis,approved_budget_ex,budget_approved_by,budget_approved_at,budget_approval_reason)
    VALUES(grp,org,job,wo,'synthetic-office-hours-token','all_in_12_v2',1000,office,now(),'Synthetic owner budget');
  INSERT INTO public.group_work_order_participants(group_id,user_id) VALUES(grp,henry),(grp,isaac);
  INSERT INTO public.trade_rates(id,org_id,user_id,hourly_rate,effective_from) VALUES
    (gen_random_uuid(),org,henry,50,'2026-01-01'),(gen_random_uuid(),org,isaac,55,'2026-01-01');
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status) VALUES
    (gen_random_uuid(),job,henry,'2026-10-19','scheduled'),(gen_random_uuid(),job,isaac,'2026-10-19','scheduled');

  -- No hours yet: refused.
  refused := NULL;
  BEGIN PERFORM public.office_approve_group_hours(grp, office, 'Crew agreed on site');
  EXCEPTION WHEN check_violation THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_office_approval_no_hours' THEN RAISE EXCEPTION 'approval with no hours not refused: %', refused; END IF;

  INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours) VALUES
    (grp,henry,'2026-10-19','07:00','15:30',30,8),(grp,isaac,'2026-10-19','07:00','15:30',30,8);

  -- Someone on the crew cannot approve their own group, even with an office role.
  refused := NULL;
  BEGIN PERFORM public.office_approve_group_hours(grp, henry, 'Crew agreed on site');
  EXCEPTION WHEN insufficient_privilege THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_office_approver_on_crew' THEN RAISE EXCEPTION 'crew member approved own group: %', refused; END IF;

  -- A reason is required, and an approver must be named.
  refused := NULL;
  BEGIN PERFORM public.office_approve_group_hours(grp, office, '  ');
  EXCEPTION WHEN invalid_parameter_value THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_office_approval_reason_required' THEN RAISE EXCEPTION 'blank reason accepted: %', refused; END IF;
  refused := NULL;
  BEGIN PERFORM public.office_approve_group_hours(grp, NULL, 'Crew agreed on site');
  EXCEPTION WHEN invalid_parameter_value THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_office_approver_required' THEN RAISE EXCEPTION 'anonymous approval accepted: %', refused; END IF;
  SELECT * INTO g FROM public.group_work_orders WHERE id = grp;
  IF g.hours_office_approved_at IS NOT NULL THEN RAISE EXCEPTION 'a refused approval left a mark'; END IF;

  -- The office approves: recorded on the group and in the log, no crew signature.
  r := public.office_approve_group_hours(grp, office, 'Crew agreed on site, Henry off sick');
  SELECT * INTO g FROM public.group_work_orders WHERE id = grp;
  IF g.hours_office_approved_at IS NULL OR g.hours_office_approved_by <> office
     OR g.hours_office_approval_reason <> 'Crew agreed on site, Henry off sick' THEN
    RAISE EXCEPTION 'office approval not recorded: %', row_to_json(g);
  END IF;
  SELECT count(*) INTO n FROM public.group_work_order_events
   WHERE group_id = grp AND action = 'office_approve_hours' AND actor_user_id = office
     AND detail->>'reason' = 'Crew agreed on site, Henry off sick' AND jsonb_array_length(detail->'hours') = 2;
  IF n <> 1 THEN RAISE EXCEPTION 'office approval event missing (% rows)', n; END IF;
  SELECT count(*) INTO n FROM public.group_work_order_participants WHERE group_id = grp AND crew_signed_at IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'office approval wrote % crew signatures', n; END IF;

  -- Once the split is final the approval cannot be given or moved.
  INSERT INTO public.job_client_signoffs(job_id,method,waiver_reason,captured_by_actor,created_at)
    VALUES(job,'office_waiver','Synthetic office sign-off','user:'||office,clock_timestamp() + interval '1 second');
  PERFORM public.freeze_group_work_order_split(grp);
  refused := NULL;
  BEGIN PERFORM public.office_approve_group_hours(grp, office, 'Again after freeze');
  EXCEPTION WHEN check_violation THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_split_frozen' THEN RAISE EXCEPTION 'approval after freeze not refused: %', refused; END IF;

  -- Plain clients cannot call it.
  IF has_function_privilege('authenticated', 'public.office_approve_group_hours(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.office_approve_group_hours(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'office approval is callable by app clients';
  END IF;
END $$;
ROLLBACK;
