BEGIN;
-- Re-establish our objects after any earlier contract rollback (rule 17).
\ir ../../../migrations/20261117215101_group_claim_crew.sql
DO $$ BEGIN
  IF current_setting('lock_timeout')<>'5s' OR current_setting('statement_timeout')<>'2min' THEN
    RAISE EXCEPTION 'ZZTEST users index build timeouts missing'; END IF;
END $$;
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
  regressions text[] := '{}';
  BEGIN
  grp := pg_temp.zztest_group_fixture();
  UPDATE public.feature_flags SET enabled=true WHERE flag_name='group_work_order_v1';
  DELETE FROM public.group_work_order_time_entries WHERE group_id=grp;
  DELETE FROM public.group_work_order_participants WHERE group_id=grp;
  INSERT INTO public.users(id,org_id,role,name) VALUES(d,org,'crew','ZZTEST missing crew'),(inactive,org,'crew','ZZTEST inactive crew');
  INSERT INTO public.trade_rates(id,org_id,user_id,hourly_rate,effective_from) VALUES(gen_random_uuid(),org,d,20,'2026-01-01');
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date) VALUES(gen_random_uuid(),job,a,'2026-11-16'),(gen_random_uuid(),job,b,'2026-11-16'),(gen_random_uuid(),job,c,'2026-11-16');
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
  -- A stray historical clock is not a booking and cannot enroll or reset approval.
  INSERT INTO public.job_events(id,job_id,user_id,event_type) VALUES(gen_random_uuid(),job,d,'clock.clock_on');
  UPDATE public.group_work_orders SET claim_state='waiting_approval',claim_deadline_at=now()-interval '1 hour' WHERE id=grp;
  SELECT claim_deadline_at INTO deadline FROM public.group_work_orders WHERE id=grp;
  failed:=false;
  BEGIN PERFORM public.group_claim_update_crew(grp,d,'sync');
  EXCEPTION WHEN check_violation THEN failed:=SQLERRM='group_not_on_job'; END;
  IF NOT failed OR public.group_claim_on_job(job,d)
    OR EXISTS(SELECT 1 FROM public.group_work_order_participants WHERE group_id=grp AND user_id=d)
    OR EXISTS(SELECT 1 FROM public.group_work_orders WHERE id=grp
      AND (claim_state<>'waiting_approval' OR claim_deadline_at IS DISTINCT FROM deadline)) THEN
    regressions:=array_append(regressions,'clock without live booking enrolls or resets approval'); END IF;
  DELETE FROM public.group_work_order_participants WHERE group_id=grp AND user_id=d;
  -- liveAssignment compares both status and role without regard to capitals.
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status)
    VALUES(gen_random_uuid(),job,d,'2026-11-16','CaNcElLeD');
  UPDATE public.job_assignments SET role='ObSeRvEr' WHERE job_id=job AND user_id=b;
  DELETE FROM public.group_work_order_participants WHERE group_id=grp AND user_id=b;
  IF public.group_claim_on_job(job,d) OR public.group_claim_on_job(job,b) THEN
    regressions:=array_append(regressions,'mixed-case cancelled or observer booking admitted'); END IF;
  PERFORM public.group_claim_update_crew(grp,a,'sync');
  IF EXISTS(SELECT 1 FROM public.group_work_order_participants WHERE group_id=grp AND user_id IN (b,d)) THEN
    regressions:=array_append(regressions,'sync admitted cancelled clock or observer'); END IF;
  -- Cancelled and observer bookings are not shown as allocated or self-added.
  INSERT INTO public.group_work_order_participants(group_id,user_id) VALUES(grp,b),(grp,d)
    ON CONFLICT(group_id,user_id) DO NOTHING;
  UPDATE public.job_assignments SET added_by='self',self_added_status='added',self_added_at=now(),is_lead=false WHERE job_id=job AND user_id=d;
  IF EXISTS(SELECT 1 FROM public.group_claim_crew_sources(grp) WHERE user_id IN (b,d) AND how IN ('allocated','added_self')) THEN
    regressions:=array_append(regressions,'mixed-case dead booking shown as live provenance'); END IF;
  DELETE FROM public.group_work_order_participants WHERE group_id=grp AND user_id IN (b,d);
  UPDATE public.job_assignments SET role='installer' WHERE job_id=job AND user_id=b;
  UPDATE public.job_assignments SET status=NULL,added_by='office',self_added_status=NULL,self_added_at=NULL WHERE job_id=job AND user_id=d;
  -- Sync, clock retries and joins keep the exact waiting approval/deadline.
  UPDATE public.group_work_orders SET claim_state='waiting_approval',claim_deadline_at=deadline WHERE id=grp;
  PERFORM public.group_claim_update_crew(grp,a,'sync');
  IF NOT EXISTS(SELECT 1 FROM public.group_work_order_participants WHERE group_id=grp AND user_id=d)
    OR EXISTS(SELECT 1 FROM public.group_work_orders WHERE id=grp
      AND (claim_state<>'waiting_approval' OR claim_deadline_at IS DISTINCT FROM deadline)) THEN
    regressions:=array_append(regressions,'automatic addition resets approval'); END IF;
  DELETE FROM public.group_work_order_participants WHERE group_id=grp AND user_id=d;
  UPDATE public.group_work_orders SET claim_state='waiting_approval',claim_deadline_at=deadline WHERE id=grp;
  PERFORM public.group_claim_update_crew(grp,d,'join');
  IF EXISTS(SELECT 1 FROM public.group_work_orders WHERE id=grp
      AND (claim_state<>'waiting_approval' OR claim_deadline_at IS DISTINCT FROM deadline)) THEN
    regressions:=array_append(regressions,'join resets approval'); END IF;
  -- Office cancellation after a clock cannot re-enroll on either join or sync.
  UPDATE public.job_assignments SET status='cancelled' WHERE job_id=job AND user_id=d;
  DELETE FROM public.group_work_order_participants WHERE group_id=grp AND user_id=d;
  failed:=false;
  BEGIN PERFORM public.group_claim_update_crew(grp,d,'join');
  EXCEPTION WHEN check_violation THEN failed:=SQLERRM='group_not_on_job'; END;
  IF NOT failed THEN regressions:=array_append(regressions,'cancelled clock retry joins again'); END IF;
  DELETE FROM public.group_work_order_participants WHERE group_id=grp AND user_id=d;
  PERFORM public.group_claim_update_crew(grp,a,'sync');
  IF EXISTS(SELECT 1 FROM public.group_work_order_participants WHERE group_id=grp AND user_id=d) THEN
    regressions:=array_append(regressions,'cancelled clock re-enrolled by another member'); END IF;
  IF cardinality(regressions)>0 THEN RAISE EXCEPTION 'ZZTEST switch-on regressions: %',array_to_string(regressions,'; '); END IF;
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
    OR EXISTS(SELECT 1 FROM public.group_work_order_crew(ARRAY[job]) WHERE user_id=d)
    OR (SELECT count(*) FROM public.group_work_order_events WHERE group_id=grp AND action='leave_claim')<>1 THEN
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
INSERT INTO public.trade_rates(id,org_id,user_id,hourly_rate,effective_from)
SELECT gen_random_uuid(), '00000000-0000-0000-0000-000000000001',md5('ZZTEST claim plan user '||n)::uuid,1,'2026-01-01'
FROM generate_series(1,2000) n;
INSERT INTO public.trade_invoices(id,org_id,user_id,status,created_at,gst_on,super_rate,super_amount,gross_earned,net_pay,subtotal_ex,gst,total_inc,super_basis,invoice_number)
SELECT md5('ZZTEST claim plan invoice '||n)::uuid,'00000000-0000-0000-0000-000000000001',
  md5('ZZTEST claim plan user '||n)::uuid,'acknowledged',now(),false,.12,0,0,0,0,0,0,'employer_12_v2','ZZTEST-CLAIM-PLAN-'||n
FROM generate_series(1,2000) n;
INSERT INTO public.jobs(id,org_id,type,status,job_number)
SELECT md5('ZZTEST claim plan job '||n)::uuid,'00000000-0000-0000-0000-000000000001',
  'patio','draft','ZZTEST-CLAIM-PLAN-'||n FROM generate_series(2,2000) n;
INSERT INTO public.job_events(id,job_id,user_id,event_type)
SELECT gen_random_uuid(), CASE WHEN n=1 THEN 'f1171901-0000-4000-8000-000000000101'::uuid
  ELSE md5('ZZTEST claim plan job '||n)::uuid END,md5('ZZTEST claim plan user '||n)::uuid,'clock.clock_on'
FROM generate_series(1,2000) n;
INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date)
SELECT gen_random_uuid(), 'f1171901-0000-4000-8000-000000000101',md5('ZZTEST claim plan user '||n)::uuid,'2026-11-16'::date
FROM generate_series(1,2000) n;
ANALYZE public.users;
ANALYZE public.trade_rates;
ANALYZE public.trade_invoices;
ANALYZE public.job_events;
ANALYZE public.job_assignments;
-- Rule 16: assert the plan's behavior, not a particular index name.
DO $plans$ DECLARE
  query text;
  plan jsonb;
BEGIN
  FOREACH query IN ARRAY ARRAY[
$query$SELECT id FROM public.users WHERE id=md5('ZZTEST claim plan user 1')::uuid$query$,
$query$SELECT user_id FROM public.trade_rates
WHERE user_id=md5('ZZTEST claim plan user 1')::uuid AND effective_to IS NULL$query$,
$query$SELECT user_id FROM public.trade_invoices
WHERE user_id=md5('ZZTEST claim plan user 1')::uuid AND created_at>=now()-interval '8 weeks' AND status NOT IN ('draft','ops-reject')$query$,
$query$SELECT user_id FROM public.job_events
WHERE job_id='f1171901-0000-4000-8000-000000000101' AND user_id=md5('ZZTEST claim plan user 1')::uuid AND event_type='clock.clock_on'$query$,
$query$SELECT user_id FROM public.job_assignments
WHERE job_id='f1171901-0000-4000-8000-000000000101' AND user_id=md5('ZZTEST claim plan user 1')::uuid
 AND NOT coalesce(is_ghost,false) AND lower(coalesce(role,''))<>'observer' AND lower(coalesce(status,''))<>'cancelled'$query$
  ] LOOP
    EXECUTE 'EXPLAIN (ANALYZE,COSTS OFF,TIMING OFF,FORMAT JSON) '||query INTO plan;
    RAISE NOTICE 'ZZTEST point-read plan: %',plan;
    IF jsonb_path_exists(plan,'$.** ? (@."Node Type" == "Seq Scan")')
      OR NOT jsonb_path_exists(plan,'$.** ? (@."Node Type" == "Index Scan" || @."Node Type" == "Index Only Scan" || @."Node Type" == "Bitmap Index Scan")')
      OR (plan->0->'Plan'->>'Actual Rows')::integer<>1 THEN
      RAISE EXCEPTION 'ZZTEST point read is not index bound to one row: %',query;
    END IF;
  END LOOP;
END $plans$;
-- Explain the actual function's SQL body, so this check cannot drift into a
-- separate search implementation. Assert plan behavior, never an index name.
DO $plan$ DECLARE
  query text;
  plan jsonb;
  BEGIN
  SELECT prosrc INTO query FROM pg_proc
    WHERE oid='public.group_claim_search_trades(uuid,text)'::regprocedure;
  query:=replace(query,'p_actor',quote_literal('f1171901-0000-4000-8000-000000000002')||'::uuid');
  query:=replace(query,'p_query',quote_literal('ZZTEST'));
  EXECUTE 'EXPLAIN (ANALYZE,COSTS OFF,TIMING OFF,FORMAT JSON) '||query INTO plan;
  RAISE NOTICE 'ZZTEST actual claim search plan: %',plan;
  IF jsonb_path_exists(plan,'$.** ? (@."Node Type" == "Seq Scan" && @."Relation Name" == "users")')
    OR (plan->0->'Plan'->>'Actual Rows')::integer<>10 THEN
    RAISE EXCEPTION 'ZZTEST claim search is not index bound with ten results';
  END IF;
END $plan$;
ROLLBACK;
\echo ZZTEST group claim crew: PASS
