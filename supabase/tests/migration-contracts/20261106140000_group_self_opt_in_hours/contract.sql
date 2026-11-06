-- A crew member logs hours for any day on the job and every one counts;
-- someone off the crew cannot log hours; booked office staff who never joined
-- do not hold the split, but anyone on the crew does. Synthetic records
-- only; rolled back.
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  office uuid := 'f1060000-0000-4000-8000-0000000000a1';
  crew_a uuid := 'f1060000-0000-4000-8000-0000000000a2';
  crew_b uuid := 'f1060000-0000-4000-8000-0000000000a3';
  outsider uuid := 'f1060000-0000-4000-8000-0000000000a4';
  job uuid := 'f1060000-0000-4000-8000-000000000111';
  wo uuid := 'f1060000-0000-4000-8000-000000000311';
  grp uuid := 'f1060000-0000-4000-8000-000000000211';
  refused text;
BEGIN
  INSERT INTO public.users(id,org_id,name,role) VALUES
    (office,org,'Synthetic Office','ops_manager'),(crew_a,org,'Crew Synthetic A','crew'),
    (crew_b,org,'Crew Synthetic B','crew'),(outsider,org,'Outside Synthetic','crew')
    ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES(job,org,'patio','quoted','SYN-SELF-OPT-IN');
  INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items,special_instructions)
    VALUES(wo,org,job,'SYN-SELF-OPT-IN-WO','job','draft',1000,'[]','Synthetic self opt-in proof');
  UPDATE public.work_orders SET status='approved',approved_by=office WHERE id=wo;
  INSERT INTO public.group_work_orders(id,org_id,job_id,work_order_id,share_token,pay_basis)
    VALUES(grp,org,job,wo,'synthetic-self-opt-in-token','gross_v1');
  -- Crew A is booked for one day; crew B opted in with no booking at all.
  -- The office person is booked to watch the job and never joined.
  INSERT INTO public.group_work_order_participants(group_id,user_id) VALUES(grp,crew_a),(grp,crew_b);
  INSERT INTO public.trade_rates(id,org_id,user_id,hourly_rate,effective_from) VALUES
    (gen_random_uuid(),org,crew_a,50,'2026-01-01'),(gen_random_uuid(),org,crew_b,55,'2026-01-01'),
    (gen_random_uuid(),org,office,60,'2026-01-01');
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status) VALUES
    (gen_random_uuid(),job,crew_a,'2026-10-19','scheduled'),
    (gen_random_uuid(),job,office,'2026-10-19','scheduled');

  -- Any day on the job, booked or not.
  BEGIN
    INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours) VALUES
      (grp,crew_a,'2026-10-21','07:00','15:30',30,8),(grp,crew_b,'2026-10-20','07:00','15:30',30,8);
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'a crew member''s hours on an unbooked day refused: %', SQLERRM;
  END;

  -- Someone off the crew cannot log hours on it.
  refused := NULL;
  BEGIN
    INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours)
      VALUES(grp,outsider,'2026-10-20','07:00','15:30',30,8);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_hours_not_member' THEN
    RAISE EXCEPTION 'hours from someone off the crew not refused: %', refused;
  END IF;

  -- Every crew hour counts (both crew logged only unbooked days), and booked
  -- office staff do not hold the split. With no client sign-off yet, the
  -- split gets past hours and rates and stops at the sign-off.
  refused := NULL;
  BEGIN PERFORM public.project_group_work_order_split(grp);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_client_signoff_required' THEN
    RAISE EXCEPTION 'split did not count every crew hour: %', refused;
  END IF;

  -- A booked trade who has not joined is still named.
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status)
    VALUES(gen_random_uuid(),job,outsider,'2026-10-20','scheduled');
  refused := NULL;
  BEGIN PERFORM public.project_group_work_order_split(grp);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM; END;
  IF refused IS NULL OR refused NOT LIKE 'group_split_needs_hours%' || outsider::text || '%' THEN
    RAISE EXCEPTION 'booked trade off the crew not named: %', refused;
  END IF;
  UPDATE public.job_assignments SET status='cancelled' WHERE job_id=job AND user_id=outsider;

  -- Office staff who join the crew need hours like anyone.
  INSERT INTO public.group_work_order_participants(group_id,user_id) VALUES(grp,office);
  refused := NULL;
  BEGIN PERFORM public.project_group_work_order_split(grp);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM; END;
  IF refused IS NULL OR refused NOT LIKE 'group_split_needs_hours%' || office::text || '%' THEN
    RAISE EXCEPTION 'office crew member without hours not named: %', refused;
  END IF;
  DELETE FROM public.group_work_order_participants WHERE group_id=grp AND user_id=office;

END $$;
ROLLBACK;
