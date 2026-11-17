BEGIN;
\ir ../20261117171901_group_inclusive_pay_basis/fixture.sql
DO $$ DECLARE
  grp uuid;
  office uuid := 'f1171901-0000-4000-8000-000000000001';
  a uuid := 'f1171901-0000-4000-8000-000000000002';
  b uuid := 'f1171901-0000-4000-8000-000000000003';
  c uuid := 'f1171901-0000-4000-8000-000000000004';
  d uuid := 'f1171901-0000-4000-8000-000000000005';
  inactive uuid := 'f1171901-0000-4000-8000-000000000006';
  job uuid := 'f1171901-0000-4000-8000-000000000101';
  org uuid := '00000000-0000-0000-0000-000000000001';
  failed boolean;
  deadline timestamptz;
  ev_count integer;
  BEGIN
  grp := pg_temp.zztest_group_fixture();
  DELETE FROM public.group_work_order_time_entries WHERE group_id=grp;
  DELETE FROM public.group_work_order_participants WHERE group_id=grp;
  INSERT INTO public.users(id,org_id,role,name) VALUES(d,org,'crew','ZZTEST missing crew'),(inactive,org,'crew','ZZTEST inactive crew');
  INSERT INTO public.trade_rates(org_id,user_id,hourly_rate,effective_from) VALUES(org,d,20,'2026-01-01');
  INSERT INTO public.job_assignments(job_id,user_id,scheduled_date) VALUES(job,a,'2026-11-16'),(job,b,'2026-11-16'),(job,c,'2026-11-16');
  -- Switch off: no mutation, including a direct privileged RPC call.
  failed:=false;
  BEGIN PERFORM public.group_claim_update_crew(grp,a,'sync');
  EXCEPTION WHEN check_violation THEN failed:=SQLERRM='group_claim_disabled'; END;
  IF NOT failed OR EXISTS(SELECT 1 FROM public.group_work_order_participants WHERE group_id=grp) THEN
    RAISE EXCEPTION 'ZZTEST off wrote crew'; END IF;
  UPDATE public.feature_flags SET enabled=true WHERE flag_name='group_claim_flow_v1';
  PERFORM public.group_claim_update_crew(grp,a,'sync');
  IF (SELECT count(*) FROM public.group_work_order_participants WHERE group_id=grp)<>3 THEN
    RAISE EXCEPTION 'ZZTEST booked crew not enrolled'; END IF;
  UPDATE public.job_assignments SET added_by='self',self_added_status='added',self_added_at=now(),is_lead=false
    WHERE job_id=job AND user_id=a;
  IF NOT EXISTS(SELECT 1 FROM public.group_claim_crew_sources(grp) WHERE user_id=a AND how='added_self') THEN
    RAISE EXCEPTION 'ZZTEST self-added provenance missing'; END IF;
  -- No allocation, clock or invitation cannot claim pay.
  failed:=false;
  BEGIN PERFORM public.group_claim_update_crew(grp,d,'join');
  EXCEPTION WHEN check_violation THEN failed:=SQLERRM='group_not_on_job'; END;
  IF NOT failed THEN RAISE EXCEPTION 'ZZTEST off-job join accepted'; END IF;
  INSERT INTO public.job_events(job_id,user_id,event_type) VALUES(job,d,'clock.clock_on');
  PERFORM public.group_claim_update_crew(grp,d,'sync');
  IF NOT EXISTS(SELECT 1 FROM public.group_work_order_participants WHERE group_id=grp AND user_id=d) THEN
    RAISE EXCEPTION 'ZZTEST clock-only crew not enrolled'; END IF;
  DELETE FROM public.group_work_order_participants WHERE group_id=grp AND user_id=d;
  DELETE FROM public.job_events WHERE job_id=job AND user_id=d;
  UPDATE public.group_work_orders SET claim_state='waiting_approval',claim_deadline_at=now()-interval '1 hour' WHERE id=grp;
  PERFORM public.group_claim_update_crew(grp,a,'name',ARRAY[d]);
  IF NOT EXISTS(SELECT 1 FROM public.group_work_order_participants WHERE group_id=grp AND user_id=d AND named_by=a AND named_at IS NOT NULL)
    OR (SELECT claim_state FROM public.group_work_orders WHERE id=grp)<>'waiting_hours' THEN
    RAISE EXCEPTION 'ZZTEST named crew or reset missing'; END IF;
  SELECT claim_deadline_at INTO deadline FROM public.group_work_orders WHERE id=grp;
  IF deadline<now()+interval '47 hours' THEN RAISE EXCEPTION 'ZZTEST deadline not reset'; END IF;
  SELECT count(*) INTO ev_count FROM public.group_work_order_events WHERE group_id=grp;
  PERFORM public.group_claim_update_crew(grp,a,'name',ARRAY[d]);
  PERFORM public.group_claim_update_crew(grp,d,'join');
  IF (SELECT count(*) FROM public.group_work_order_events WHERE group_id=grp)<>ev_count THEN
    RAISE EXCEPTION 'ZZTEST retry duplicated audit'; END IF;
  -- Missing/inactive and foreign-company profiles never gain membership.
  failed:=false;
  BEGIN PERFORM public.group_claim_update_crew(grp,a,'name',ARRAY[inactive]);
  EXCEPTION WHEN check_violation THEN failed:=SQLERRM='group_person_not_a_trade'; END;
  IF NOT failed THEN RAISE EXCEPTION 'ZZTEST inactive accepted'; END IF;
  UPDATE public.users SET org_id='00000000-0000-0000-0000-000000000002' WHERE id=d;
  failed:=false;
  BEGIN PERFORM public.group_claim_update_crew(grp,a,'name',ARRAY[d]);
  EXCEPTION WHEN check_violation THEN failed:=SQLERRM='group_person_not_a_trade'; END;
  IF NOT failed THEN RAISE EXCEPTION 'ZZTEST foreign-company accepted'; END IF;
  UPDATE public.users SET org_id=org WHERE id=d;
  IF EXISTS(SELECT 1 FROM public.group_claim_search_trades(a,'ZZTEST') WHERE user_id=inactive)
    OR (SELECT count(*) FROM public.group_claim_search_trades(a,'Z'))<>0
    OR (SELECT count(*) FROM public.group_claim_search_trades(a,'ZZTEST'))>10 THEN
    RAISE EXCEPTION 'ZZTEST search admits inactive/short or over limit'; END IF;
  PERFORM public.group_claim_update_crew(grp,d,'leave');
  PERFORM public.group_claim_update_crew(grp,d,'leave');
  IF EXISTS(SELECT 1 FROM public.group_work_order_participants WHERE group_id=grp AND user_id=d)
    OR EXISTS(SELECT 1 FROM public.group_work_order_crew(ARRAY[job]) WHERE user_id=d) THEN
    RAISE EXCEPTION 'ZZTEST departed person still required'; END IF;
  INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours)
    VALUES(grp,a,'2026-11-16','07:00','08:00',0,1);
  failed:=false;
  BEGIN PERFORM public.group_claim_update_crew(grp,a,'leave');
  EXCEPTION WHEN check_violation THEN failed:=SQLERRM='group_has_hours'; END;
  IF NOT failed OR NOT EXISTS(SELECT 1 FROM public.group_work_order_participants WHERE group_id=grp AND user_id=a) THEN
    RAISE EXCEPTION 'ZZTEST hours lost through leave'; END IF;
  -- Hand edit by office wins, and retry cannot silently restore that person.
  PERFORM public.remove_group_work_order_participant(grp,c,office);
  PERFORM public.group_claim_update_crew(grp,a,'sync');
  IF EXISTS(SELECT 1 FROM public.group_work_order_participants WHERE group_id=grp AND user_id=c) THEN
    RAISE EXCEPTION 'ZZTEST office removal lost'; END IF;
  failed:=false;
  BEGIN PERFORM public.group_claim_update_crew(grp,a,'name',ARRAY[c]);
  EXCEPTION WHEN check_violation THEN failed:=SQLERRM='group_member_removed_by_office'; END;
  IF NOT failed THEN RAISE EXCEPTION 'ZZTEST office removal bypassed'; END IF;
  UPDATE public.group_work_orders SET split_frozen_at=now() WHERE id=grp;
  failed:=false;
  BEGIN PERFORM public.group_claim_update_crew(grp,b,'leave');
  EXCEPTION WHEN check_violation THEN failed:=SQLERRM='group_split_frozen'; END;
  IF NOT failed THEN RAISE EXCEPTION 'ZZTEST frozen crew changed'; END IF;
END $$;
-- Rule 16: retain actual plans on the built tables with a selective 2,000-person
-- ZZTEST population. No planner switches. The whole population rolls back.
INSERT INTO public.users(id,org_id,name,role)
SELECT md5('ZZTEST claim plan user '||n)::uuid,'00000000-0000-0000-0000-000000000001','ZZTEST plan crew','crew'
FROM generate_series(1,2000) n;
INSERT INTO public.trade_rates(org_id,user_id,hourly_rate,effective_from)
SELECT '00000000-0000-0000-0000-000000000001',md5('ZZTEST claim plan user '||n)::uuid,1,'2026-01-01'
FROM generate_series(1,2000) n;
INSERT INTO public.trade_invoices(id,org_id,user_id,status,created_at)
SELECT md5('ZZTEST claim plan invoice '||n)::uuid,'00000000-0000-0000-0000-000000000001',
  md5('ZZTEST claim plan user '||n)::uuid,'acknowledged',now()
FROM generate_series(1,2000) n;
INSERT INTO public.job_events(job_id,user_id,event_type)
SELECT 'f1171901-0000-4000-8000-000000000101',md5('ZZTEST claim plan user '||n)::uuid,'clock.clock_on'
FROM generate_series(1,2000) n;
INSERT INTO public.job_assignments(job_id,user_id,scheduled_date)
SELECT 'f1171901-0000-4000-8000-000000000101',md5('ZZTEST claim plan user '||n)::uuid,'2026-11-16'::date
FROM generate_series(1,2000) n;
ANALYZE public.users;
ANALYZE public.trade_rates;
ANALYZE public.trade_invoices;
ANALYZE public.job_events;
ANALYZE public.job_assignments;
EXPLAIN (ANALYZE,COSTS OFF,TIMING OFF) SELECT id FROM public.users WHERE id=md5('ZZTEST claim plan user 1')::uuid;
EXPLAIN (ANALYZE,COSTS OFF,TIMING OFF) SELECT user_id FROM public.trade_rates
WHERE user_id=md5('ZZTEST claim plan user 1')::uuid AND effective_to IS NULL;
EXPLAIN (ANALYZE,COSTS OFF,TIMING OFF) SELECT user_id FROM public.trade_invoices
WHERE user_id=md5('ZZTEST claim plan user 1')::uuid AND created_at>=now()-interval '8 weeks' AND status NOT IN ('draft','ops-reject');
EXPLAIN (ANALYZE,COSTS OFF,TIMING OFF) SELECT user_id FROM public.job_events
WHERE job_id='f1171901-0000-4000-8000-000000000101' AND user_id=md5('ZZTEST claim plan user 1')::uuid AND event_type='clock.clock_on';
EXPLAIN (ANALYZE,COSTS OFF,TIMING OFF) SELECT user_id FROM public.job_assignments
WHERE job_id='f1171901-0000-4000-8000-000000000101' AND user_id=md5('ZZTEST claim plan user 1')::uuid
 AND NOT coalesce(is_ghost,false) AND coalesce(role,'')<>'observer' AND coalesce(status,'')<>'cancelled';
EXPLAIN (ANALYZE,COSTS OFF,TIMING OFF) SELECT u.id,u.name
FROM public.users a JOIN public.users u ON u.org_id=a.org_id
WHERE a.id='f1171901-0000-4000-8000-000000000002'
 AND strpos(lower(u.name),'zztest')>0 AND public.group_claim_active_trade(a.org_id,u.id)
ORDER BY u.name COLLATE "C",u.id LIMIT 10;
ROLLBACK;
\echo ZZTEST group claim crew: PASS
