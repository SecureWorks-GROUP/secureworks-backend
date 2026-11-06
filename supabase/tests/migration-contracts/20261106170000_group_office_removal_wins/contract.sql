-- The office removes two booked people the owner did not name for the group:
-- their bookings stop making them crew for that group, the split no longer
-- waits on their hours, the removal records who and when, and the office can
-- reverse it. Synthetic records only; rolled back.
-- The first check is the break target.
BEGIN;

-- Fixture-only: the client sign-off is not what this proves. Restored by the
-- rollback below.
CREATE OR REPLACE FUNCTION public.group_client_signoff_counts(p_job uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  office uuid := 'f1061700-0000-4000-8000-0000000000a1';
  crew_a uuid := 'f1061700-0000-4000-8000-0000000000a2';
  crew_b uuid := 'f1061700-0000-4000-8000-0000000000a3';
  booked_c uuid := 'f1061700-0000-4000-8000-0000000000a4';
  booked_d uuid := 'f1061700-0000-4000-8000-0000000000a5';
  job uuid := 'f1061700-0000-4000-8000-000000000111';
  wo uuid := 'f1061700-0000-4000-8000-000000000311';
  grp uuid := 'f1061700-0000-4000-8000-000000000211';
  crew uuid[];
  split jsonb;
  refused text;
BEGIN
  INSERT INTO public.users(id,org_id,name,role) VALUES
    (office,org,'Synthetic Office','admin'),(crew_a,org,'Crew Synthetic A','crew'),
    (crew_b,org,'Crew Synthetic B','crew'),(booked_c,org,'Crew Synthetic C','crew'),
    (booked_d,org,'Crew Synthetic D','lead_installer')
    ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES(job,org,'patio','quoted','SYN-OFFICE-REMOVAL-1');
  INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items,special_instructions)
    VALUES(wo,org,job,'SYN-OFFICE-REMOVAL-WO-1','job','draft',1000,'[]','Synthetic office removal proof');
  -- Fixture-only approver, restored with the whole transaction below.
  UPDATE public.work_order_settings SET approver_user_ids=ARRAY[office] WHERE id=1;
  UPDATE public.work_orders SET status='approved',approved_by=office,approved_via='session' WHERE id=wo;
  INSERT INTO public.group_work_orders(id,org_id,job_id,work_order_id,share_token,pay_basis)
    VALUES(grp,org,job,wo,'synthetic-office-removal-token-1','gross_v1');
  INSERT INTO public.group_work_order_participants(group_id,user_id) VALUES(grp,crew_a),(grp,crew_b);
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status,role) VALUES
    (gen_random_uuid(),job,crew_a,'2026-10-19','scheduled','lead_installer'),
    (gen_random_uuid(),job,crew_b,'2026-10-19','scheduled','lead_installer'),
    (gen_random_uuid(),job,booked_c,'2026-10-19','scheduled','lead_installer'),
    (gen_random_uuid(),job,booked_d,'2026-10-20','scheduled','lead_installer');
  INSERT INTO public.trade_rates(id,org_id,user_id,hourly_rate,effective_from) VALUES
    (gen_random_uuid(),org,crew_a,50,'2026-01-01'),(gen_random_uuid(),org,crew_b,50,'2026-01-01'),
    (gen_random_uuid(),org,booked_d,50,'2026-01-01');
  INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours) VALUES
    (grp,crew_a,'2026-10-19','07:00','15:00',0,8),(grp,crew_b,'2026-10-19','07:00','11:00',0,4);

  -- Booked, not named: they are crew until the office removes them.
  SELECT array_agg(c.user_id ORDER BY c.user_id) INTO crew FROM public.group_work_order_crew(ARRAY[job]) c;
  IF crew IS DISTINCT FROM (SELECT array_agg(u ORDER BY u) FROM unnest(ARRAY[crew_a,crew_b,booked_c,booked_d]) u) THEN
    RAISE EXCEPTION 'office-removal: starting crew is wrong: %', crew;
  END IF;

  -- 1. The office removes both; their bookings stay, the removal wins.
  PERFORM public.remove_group_work_order_participant(grp, booked_c, office);
  PERFORM public.remove_group_work_order_participant(grp, booked_d, office);
  SELECT array_agg(c.user_id ORDER BY c.user_id) INTO crew FROM public.group_work_order_crew(ARRAY[job]) c;
  IF crew IS DISTINCT FROM (SELECT array_agg(u ORDER BY u) FROM unnest(ARRAY[crew_a,crew_b]) u) THEN
    RAISE EXCEPTION 'office-removal: a removed booking still holds the group (crew %)', crew;
  END IF;
  refused := NULL;
  BEGIN split := public.group_work_order_write_split(grp, false);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM; END;
  IF refused IS NOT NULL OR jsonb_array_length(split->'shares') <> 2 THEN
    RAISE EXCEPTION 'office-removal: a removed booking still holds the group (split %, %)', refused, split;
  END IF;
  IF (SELECT count(*) FROM public.job_assignments WHERE job_id = job AND status = 'scheduled') <> 4 THEN
    RAISE EXCEPTION 'office-removal: bookings were changed';
  END IF;

  -- Recorded with who and when.
  IF (SELECT count(*) FROM public.group_work_order_crew_removals
      WHERE group_id = grp AND job_id = job AND removed_by = office AND removed_at IS NOT NULL
        AND restored_at IS NULL AND user_id IN (booked_c, booked_d)) <> 2 THEN
    RAISE EXCEPTION 'office-removal: removal not recorded with who and when';
  END IF;

  -- 2. The office reverses one: back on the group and required again.
  PERFORM public.restore_group_work_order_participant(grp, booked_d, office);
  IF NOT EXISTS (SELECT 1 FROM public.group_work_order_participants WHERE group_id = grp AND user_id = booked_d)
     OR NOT EXISTS (SELECT 1 FROM public.group_work_order_crew_removals
       WHERE group_id = grp AND user_id = booked_d AND restored_by = office AND restored_at IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM public.group_work_order_events
       WHERE group_id = grp AND action = 'restore_participant' AND actor_user_id = office
         AND detail->>'user_id' = booked_d::text) THEN
    RAISE EXCEPTION 'office-removal: restore not recorded';
  END IF;
  refused := NULL;
  BEGIN PERFORM public.group_work_order_write_split(grp, false);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_split_needs_hours: ' || booked_d::text THEN
    RAISE EXCEPTION 'office-removal: a restored member is not required again: %', refused;
  END IF;
  refused := NULL;
  BEGIN PERFORM public.restore_group_work_order_participant(grp, booked_d, office);
  EXCEPTION WHEN no_data_found THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_removal_not_found' THEN
    RAISE EXCEPTION 'office-removal: restore without a removal was not refused: %', refused;
  END IF;

  -- Removed a second time: a fresh record beside the reversed one.
  PERFORM public.remove_group_work_order_participant(grp, booked_d, office);
  IF (SELECT count(*) FROM public.group_work_order_crew_removals WHERE group_id = grp AND user_id = booked_d) <> 2 THEN
    RAISE EXCEPTION 'office-removal: second removal not recorded';
  END IF;

  -- 3. After the freeze neither removal nor restore moves anyone.
  PERFORM public.group_work_order_write_split(grp, true);
  refused := NULL;
  BEGIN PERFORM public.restore_group_work_order_participant(grp, booked_c, office);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_split_frozen' THEN
    RAISE EXCEPTION 'office-removal: restore after the freeze was not refused: %', refused;
  END IF;

  -- 4. A void group's removal holds nobody off the job's bookings.
  UPDATE public.group_work_orders SET status = 'void' WHERE id = grp;
  SELECT array_agg(c.user_id ORDER BY c.user_id) INTO crew FROM public.group_work_order_crew(ARRAY[job]) c;
  IF NOT (crew @> ARRAY[booked_c, booked_d]) THEN
    RAISE EXCEPTION 'office-removal: a void group''s removal still holds bookings off: %', crew;
  END IF;

  IF has_table_privilege('authenticated', 'public.group_work_order_crew_removals', 'SELECT')
     OR has_table_privilege('anon', 'public.group_work_order_crew_removals', 'SELECT')
     OR has_table_privilege('service_role', 'public.group_work_order_crew_removals', 'INSERT')
     OR has_function_privilege('authenticated', 'public.restore_group_work_order_participant(uuid,uuid,uuid)', 'execute')
     OR NOT has_function_privilege('service_role', 'public.restore_group_work_order_participant(uuid,uuid,uuid)', 'execute') THEN
    RAISE EXCEPTION 'office-removal: access changed';
  END IF;
END $$;
ROLLBACK;
