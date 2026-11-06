BEGIN;
-- Only the crew read may change. Money, locks, sign-off and freeze remain
-- byte-identical to the installed predecessor, including any later amendment.
DO $check$
DECLARE body text := pg_get_functiondef('public.group_work_order_write_split(uuid,boolean)'::regprocedure);
previous text;
BEGIN
 SELECT b.body INTO previous FROM public.migration_contract_group_crew_before b;
 IF replace(body, $new$
  -- One population for automatic membership, readiness and both split modes.
  -- Explicit members remain obligations; a watching allocation adds nobody.
  SELECT string_agg(crew.user_id::text, ',' ORDER BY crew.user_id::text COLLATE "C")
    INTO v_needs_hours
  FROM public.group_work_order_crew(ARRAY[v_job]) crew
  WHERE NOT EXISTS (
    SELECT 1 FROM group_wo_entries e WHERE e.user_id = crew.user_id
  );
$new$, $old$
  -- Every participant, and every installer currently assigned to the job,
  -- needs a counting hour. An assigned person who has not joined is named
  -- the same way. Office removes a participant only before the freeze.
  SELECT string_agg(missing.user_id, ',' ORDER BY missing.user_id COLLATE "C")
    INTO v_needs_hours
  FROM (
    SELECT p.user_id::text AS user_id
    FROM public.group_work_order_participants p
    WHERE p.group_id = p_group_id
      AND NOT EXISTS (
        SELECT 1 FROM group_wo_entries e WHERE e.user_id = p.user_id
      )
    UNION
    SELECT DISTINCT a.user_id::text
    FROM public.job_assignments a
    WHERE a.job_id = v_job
      AND COALESCE(to_jsonb(a)->>'status', '') IS DISTINCT FROM 'cancelled'
      AND COALESCE(to_jsonb(a)->>'role', '') IS DISTINCT FROM 'observer'
      AND COALESCE(to_jsonb(a)->>'is_ghost', 'false') IS DISTINCT FROM 'true'
      AND NOT EXISTS (
        SELECT 1 FROM group_wo_entries e WHERE e.user_id = a.user_id
      )
  ) missing;
$old$) IS DISTINCT FROM previous THEN
  RAISE EXCEPTION 'group-crew: split changed outside the crew read';
 END IF;
 IF has_function_privilege('anon','public.group_work_order_crew(uuid[])','execute')
 OR has_function_privilege('authenticated','public.group_work_order_crew(uuid[])','execute')
 OR NOT has_function_privilege('service_role','public.group_work_order_crew(uuid[])','execute') THEN
  RAISE EXCEPTION 'group-crew: function access changed';
 END IF;
END $check$;

DO $fixtures$
DECLARE
 org uuid := 'f0600830-0000-4000-8000-000000000001';
 job uuid := 'f0600830-0000-4000-8000-000000000101';
 grp uuid := 'f0600830-0000-4000-8000-000000000201';
 crew_a uuid := 'f0600830-0000-4000-8000-00000000000a';
 crew_b uuid := 'f0600830-0000-4000-8000-00000000000b';
 office_installer uuid := 'f0600830-0000-4000-8000-00000000000c';
 watching_admin uuid := 'f0600830-0000-4000-8000-00000000000d';
 explicit_member uuid := 'f0600830-0000-4000-8000-00000000000e';
 ghost uuid := 'f0600830-0000-4000-8000-00000000000f';
 observer uuid := 'f0600830-0000-4000-8000-000000000010';
 cancelled uuid := 'f0600830-0000-4000-8000-000000000011';
 foreign_user uuid := 'f0600830-0000-4000-8000-000000000012';
 wo uuid;
 actual uuid[];
 expected uuid[];
 freeze_mode boolean;
BEGIN
 INSERT INTO public.users(id,org_id,name,role) VALUES
 (crew_a,org,'Fixture A','crew'),(crew_b,org,'Fixture B','crew'),
 (office_installer,org,'Fixture installer','ops_manager'),
 (watching_admin,org,'Fixture watcher','admin'),(explicit_member,org,'Fixture member','admin'),
 (ghost,org,'Fixture ghost','crew'),(observer,org,'Fixture observer','crew'),
 (cancelled,org,'Fixture cancelled','crew'),
 (foreign_user,'f0600830-0000-4000-8000-000000000002','Fixture other org','crew');
 INSERT INTO public.jobs(id,org_id,type,status,job_number)
 VALUES(job,org,'fencing','quoted','ZZTEST-SE-20261106-73');
 INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items,special_instructions)
 VALUES(gen_random_uuid(),org,job,'ZZTEST-SE-20261106-73','job','draft',100,'[]','Synthetic crew contract')
 RETURNING id INTO wo;
 -- Fixture-only authority, restored with the entire transaction below.
 UPDATE public.work_order_settings SET approver_user_ids=ARRAY[office_installer] WHERE id=1;
 UPDATE public.work_orders SET status='approved',approved_by=office_installer,approved_via='session' WHERE id=wo;
 INSERT INTO public.group_work_orders(id,org_id,job_id,work_order_id,share_token)
 VALUES(grp,org,job,wo,repeat('f',48));
 INSERT INTO public.group_work_order_participants(group_id,user_id)
 VALUES(grp,crew_a),(grp,crew_b),(grp,office_installer),(grp,explicit_member);
 INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status,role,is_ghost) VALUES
 (gen_random_uuid(),job,crew_a,'2026-01-10',NULL,'lead_installer',false),
 (gen_random_uuid(),job,crew_b,'2026-01-10','scheduled','lead_installer',false),
 (gen_random_uuid(),job,office_installer,'2026-01-10','scheduled','lead_installer',false),
 (gen_random_uuid(),job,watching_admin,'2026-01-10','scheduled','lead_installer',false),
 (gen_random_uuid(),job,ghost,'2026-01-10','scheduled','lead_installer',true),
 (gen_random_uuid(),job,observer,'2026-01-10','scheduled','observer',false),
 (gen_random_uuid(),job,cancelled,'2026-01-10','cancelled','lead_installer',false),
 (gen_random_uuid(),job,foreign_user,'2026-01-10','scheduled','lead_installer',false);
 SELECT array_agg(user_id ORDER BY user_id) INTO actual FROM public.group_work_order_crew(ARRAY[job]);
 SELECT array_agg(id ORDER BY id) INTO expected FROM unnest(ARRAY[crew_a,crew_b,office_installer,explicit_member]) id;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'group-crew: canonical population mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM public.group_work_order_crew(NULL))
 OR EXISTS(SELECT 1 FROM public.group_work_order_crew(ARRAY[]::uuid[])) THEN
  RAISE EXCEPTION 'group-crew: empty input read other jobs';
 END IF;
 -- Retained explicit membership is not erased by a missing allocation.
 DELETE FROM public.group_work_order_participants WHERE group_id=grp AND user_id=explicit_member;
 INSERT INTO public.trade_rates(id,org_id,user_id,hourly_rate,effective_from)
 VALUES(gen_random_uuid(),org,crew_a,10,'2026-01-01'),(gen_random_uuid(),org,crew_b,10,'2026-01-01'),(gen_random_uuid(),org,office_installer,10,'2026-01-01');
 INSERT INTO public.group_work_order_time_entries
 (group_id,user_id,work_date,start_time,finish_time,break_minutes,hours)
 VALUES(grp,crew_a,'2026-01-10','08:00','09:00',0,1),
       (grp,crew_b,'2026-01-10','08:00','09:00',0,1);
 BEGIN
  PERFORM public.group_work_order_write_split(grp,true);
  RAISE EXCEPTION 'group-crew: missing installer hours passed';
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM IS DISTINCT FROM 'group_split_needs_hours: ' || office_installer::text THEN
   RAISE EXCEPTION 'group-crew: missing installer not named: %',SQLERRM;
  END IF;
 END;
 INSERT INTO public.group_work_order_time_entries
 (group_id,user_id,work_date,start_time,finish_time,break_minutes,hours)
 VALUES(grp,office_installer,'2026-01-10','08:00','09:00',0,1);
 -- Watching/ghost/observer/foreign allocations must not invent hours blockers.
 -- The real sign-off gate remains the next refusal in BOTH projection/freeze.
 FOREACH freeze_mode IN ARRAY ARRAY[false,true] LOOP
  BEGIN
   PERFORM public.group_work_order_write_split(grp,freeze_mode);
   RAISE EXCEPTION 'group-crew: split passed without sign-off';
  EXCEPTION WHEN check_violation THEN
   IF SQLERRM IS DISTINCT FROM 'group_client_signoff_required' THEN
    RAISE EXCEPTION 'group-crew: expected sign-off guard, got %',SQLERRM;
   END IF;
  END;
 END LOOP;
 IF (SELECT split_frozen_at FROM public.group_work_orders WHERE id=grp) IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.group_work_order_shares WHERE group_id=grp) THEN
  RAISE EXCEPTION 'group-crew: refused split wrote frozen shares';
 END IF;
END $fixtures$;
ROLLBACK;
