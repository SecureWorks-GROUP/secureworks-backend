-- 1. A booking adds installers only (role crew or lead_installer). An ops
--    manager or estimator who is only booked is not group crew and the split
--    does not wait on them; one who is on the group still counts. An office
--    removal still wins over a booking.
-- 2. An open group on a cancelled job is closed only when nothing on it
--    could be owed. Synthetic records only; rolled back.
-- The first check is the break target.
BEGIN;

-- Fixture-only: the client sign-off is not what this proves. Restored by the
-- rollback below.
CREATE OR REPLACE FUNCTION public.group_client_signoff_counts(p_job uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  office uuid := 'f1111730-0000-4000-8000-0000000000a1';
  crew_a uuid := 'f1111730-0000-4000-8000-0000000000a2';
  lead_b uuid := 'f1111730-0000-4000-8000-0000000000a3';
  ops_booked uuid := 'f1111730-0000-4000-8000-0000000000a4';
  ops_member uuid := 'f1111730-0000-4000-8000-0000000000a5';
  est_booked uuid := 'f1111730-0000-4000-8000-0000000000a6';
  job uuid := 'f1111730-0000-4000-8000-000000000101';
  wo uuid := 'f1111730-0000-4000-8000-000000000301';
  grp uuid := 'f1111730-0000-4000-8000-000000000201';
  -- Cancelled jobs: c1 closes; c2 hours, c3 touched this week, c4 a booked
  -- day that has come, c5 archived, c6 a signature: all stay open.
  c1 uuid := 'f1111730-0000-4000-8000-000000000111';
  c2 uuid := 'f1111730-0000-4000-8000-000000000112';
  c3 uuid := 'f1111730-0000-4000-8000-000000000113';
  c4 uuid := 'f1111730-0000-4000-8000-000000000114';
  c5 uuid := 'f1111730-0000-4000-8000-000000000115';
  c6 uuid := 'f1111730-0000-4000-8000-000000000116';
  g1 uuid := 'f1111730-0000-4000-8000-000000000211';
  g2 uuid := 'f1111730-0000-4000-8000-000000000212';
  g3 uuid := 'f1111730-0000-4000-8000-000000000213';
  g4 uuid := 'f1111730-0000-4000-8000-000000000214';
  g5 uuid := 'f1111730-0000-4000-8000-000000000215';
  g6 uuid := 'f1111730-0000-4000-8000-000000000216';
  today date := (now() AT TIME ZONE 'Australia/Perth')::date;
  n int;
  crew uuid[];
  split jsonb;
  refused text;
  closed jsonb;
BEGIN
  INSERT INTO public.users(id,org_id,name,role) VALUES
    (office,org,'Synthetic Office','admin'),(crew_a,org,'Crew Synthetic A','crew'),
    (lead_b,org,'Lead Synthetic B','lead_installer'),(ops_booked,org,'Ops Synthetic Booked','ops_manager'),
    (ops_member,org,'Ops Synthetic Member','ops_manager'),(est_booked,org,'Estimator Synthetic','estimator')
    ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
    (job,org,'patio','quoted','SYN-CREW-ROLES-1'),
    (c1,org,'patio','quoted','SYN-CREW-ROLES-C1'),(c2,org,'patio','quoted','SYN-CREW-ROLES-C2'),
    (c3,org,'patio','quoted','SYN-CREW-ROLES-C3'),(c4,org,'patio','quoted','SYN-CREW-ROLES-C4'),
    (c5,org,'patio','quoted','SYN-CREW-ROLES-C5'),(c6,org,'patio','quoted','SYN-CREW-ROLES-C6');
  -- Fixture-only approver, restored with the whole transaction below.
  UPDATE public.work_order_settings SET approver_user_ids=ARRAY[office] WHERE id=1;
  INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items,special_instructions)
    VALUES(wo,org,job,'SYN-CREW-ROLES-WO-1','job','draft',1000,'[]','Synthetic crew roles proof');
  n := 0;
  FOR job, grp IN SELECT * FROM unnest(ARRAY[job,c1,c2,c3,c4,c5,c6], ARRAY[grp,g1,g2,g3,g4,g5,g6]) LOOP
    n := n + 1;
    IF n > 1 THEN
      INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items,special_instructions)
        VALUES(gen_random_uuid(),org,job,'SYN-CREW-ROLES-WO-'||n,'job','draft',1000,'[]','Synthetic crew roles proof');
    END IF;
    UPDATE public.jobs SET status = 'accepted' WHERE id = job;
    UPDATE public.work_orders SET status='approved',approved_by=office,approved_via='session' WHERE job_id = job;
    INSERT INTO public.group_work_orders(id,org_id,job_id,work_order_id,share_token,pay_basis)
      SELECT grp,org,job,w.id,'synthetic-crew-roles-token-'||n,'gross_v1' FROM public.work_orders w WHERE w.job_id = job;
  END LOOP;
  job := 'f1111730-0000-4000-8000-000000000101';
  grp := 'f1111730-0000-4000-8000-000000000201';

  INSERT INTO public.group_work_order_participants(group_id,user_id) VALUES(grp,crew_a),(grp,ops_member);
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status,role) VALUES
    (gen_random_uuid(),job,crew_a,'2026-10-19','scheduled','lead_installer'),
    (gen_random_uuid(),job,lead_b,'2026-10-19','scheduled','lead_installer'),
    (gen_random_uuid(),job,ops_booked,'2026-10-19','scheduled','lead_installer'),
    (gen_random_uuid(),job,ops_member,'2026-10-19','scheduled','lead_installer'),
    (gen_random_uuid(),job,est_booked,'2026-10-19','scheduled','lead_installer'),
    (gen_random_uuid(),job,office,'2026-10-19','scheduled','lead_installer');

  -- 1. Bookings add the two installers; the ops manager on the group stays.
  SELECT array_agg(c.user_id ORDER BY c.user_id) INTO crew FROM public.group_work_order_crew(ARRAY[job]) c;
  IF crew IS DISTINCT FROM (SELECT array_agg(u ORDER BY u) FROM unnest(ARRAY[crew_a,lead_b,ops_member]) u) THEN
    RAISE EXCEPTION 'crew-roles: a booked office role was put on the group (crew %)', crew;
  END IF;

  -- The split waits on people on the group, never on a booked office role.
  INSERT INTO public.group_work_order_participants(group_id,user_id) VALUES(grp,lead_b);
  INSERT INTO public.trade_rates(id,org_id,user_id,hourly_rate,effective_from) VALUES
    (gen_random_uuid(),org,crew_a,50,'2026-01-01'),(gen_random_uuid(),org,lead_b,50,'2026-01-01'),
    (gen_random_uuid(),org,ops_member,50,'2026-01-01');
  INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours) VALUES
    (grp,crew_a,'2026-10-19','07:00','15:00',0,8),(grp,lead_b,'2026-10-19','07:00','11:00',0,4);
  refused := NULL;
  BEGIN PERFORM public.group_work_order_write_split(grp, false);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM; END;
  IF refused IS DISTINCT FROM 'group_split_needs_hours: ' || ops_member::text THEN
    RAISE EXCEPTION 'crew-roles: the split did not wait on the member alone: %', refused;
  END IF;
  INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours) VALUES
    (grp,ops_member,'2026-10-19','07:00','11:00',0,4);
  split := public.group_work_order_write_split(grp, false);
  IF jsonb_array_length(split->'shares') <> 3 THEN
    RAISE EXCEPTION 'crew-roles: a booked office role held or joined the split: %', split;
  END IF;

  -- An office removal still wins over an installer's booking.
  PERFORM public.remove_group_work_order_participant(grp, lead_b, office);
  SELECT array_agg(c.user_id ORDER BY c.user_id) INTO crew FROM public.group_work_order_crew(ARRAY[job]) c;
  IF crew IS DISTINCT FROM (SELECT array_agg(u ORDER BY u) FROM unnest(ARRAY[crew_a,ops_member]) u) THEN
    RAISE EXCEPTION 'crew-roles: a removed installer was put back by the booking (crew %)', crew;
  END IF;
  IF (SELECT count(*) FROM public.job_assignments WHERE job_id = job AND status = 'scheduled') <> 6 THEN
    RAISE EXCEPTION 'crew-roles: bookings were changed';
  END IF;

  -- 2. Cancelled jobs. Dates hang off the run's clock on both sides.
  INSERT INTO public.group_work_order_participants(group_id,user_id) VALUES(g1,crew_a),(g2,crew_a);
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status,role) VALUES
    (gen_random_uuid(),c1,crew_a,today + 30,'scheduled','lead_installer'),   -- a day not reached
    (gen_random_uuid(),c1,lead_b,today - 3,'cancelled','lead_installer'),    -- a cancelled booking
    (gen_random_uuid(),c1,office,today - 3,'scheduled','observer'),          -- watching only
    (gen_random_uuid(),c2,crew_a,today + 30,'scheduled','lead_installer'),
    (gen_random_uuid(),c4,crew_a,today,'scheduled','lead_installer');        -- a day that has come
  INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours)
    VALUES(g2,crew_a,today + 30,'07:00','11:00',0,4);
  INSERT INTO public.group_work_order_signatures(group_id,signer_kind,user_id,signer_name,signature_png,signed_via,captured_by_user_id)
    VALUES(g6,'crew',crew_a,'Crew Synthetic A','data:image/png;base64,iVBORw0KGgo=','on_site',crew_a);
  UPDATE public.jobs SET status = 'cancelled', updated_at = now() - interval '8 days' WHERE id IN (c1,c2,c4,c6);
  UPDATE public.jobs SET status = 'cancelled', updated_at = now() - interval '6 days' WHERE id = c3;
  UPDATE public.jobs SET status = 'archived', updated_at = now() - interval '60 days' WHERE id = c5;

  closed := public.close_group_work_orders_on_cancelled_jobs();
  IF closed->'closed' IS DISTINCT FROM jsonb_build_array(jsonb_build_object('group_id', g1, 'job_id', c1)) THEN
    RAISE EXCEPTION 'cancelled-close: wrong groups closed: %', closed;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.group_work_orders
       WHERE id = g1 AND status = 'void' AND voided_at IS NOT NULL AND void_reason = 'Job cancelled')
     OR NOT EXISTS (SELECT 1 FROM public.group_work_order_events
       WHERE group_id = g1 AND job_id = c1 AND action = 'void_group' AND actor_user_id IS NULL
         AND detail->>'automatic' = 'true') THEN
    RAISE EXCEPTION 'cancelled-close: the close was not recorded';
  END IF;
  IF (SELECT count(*) FROM public.group_work_orders WHERE id IN (grp,g2,g3,g4,g5,g6) AND status = 'open') <> 6 THEN
    RAISE EXCEPTION 'cancelled-close: a group that could be owed, or on a live or archived job, was closed: %',
      (SELECT jsonb_agg(id) FROM public.group_work_orders WHERE id IN (grp,g2,g3,g4,g5,g6) AND status <> 'open');
  END IF;
  IF (SELECT count(*) FROM public.group_work_order_time_entries WHERE group_id = g2) <> 1
     OR (SELECT count(*) FROM public.group_work_order_participants WHERE group_id = g1) <> 1 THEN
    RAISE EXCEPTION 'cancelled-close: hours or members were changed';
  END IF;
  -- A second run finds nothing, and a closed group stays closed.
  closed := public.close_group_work_orders_on_cancelled_jobs();
  IF jsonb_array_length(closed->'closed') <> 0
     OR (SELECT count(*) FROM public.group_work_order_events WHERE group_id = g1 AND action = 'void_group') <> 1 THEN
    RAISE EXCEPTION 'cancelled-close: a second run closed again: %', closed;
  END IF;

  IF has_function_privilege('authenticated', 'public.close_group_work_orders_on_cancelled_jobs()', 'execute')
     OR has_function_privilege('anon', 'public.close_group_work_orders_on_cancelled_jobs()', 'execute')
     OR NOT has_function_privilege('service_role', 'public.close_group_work_orders_on_cancelled_jobs()', 'execute')
     OR has_function_privilege('authenticated', 'public.group_work_order_crew(uuid[])', 'execute')
     OR NOT has_function_privilege('service_role', 'public.group_work_order_crew(uuid[])', 'execute') THEN
    RAISE EXCEPTION 'crew-roles: access changed';
  END IF;
END $$;
ROLLBACK;
