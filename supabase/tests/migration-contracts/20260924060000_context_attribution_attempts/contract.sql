-- A1-BE behaviour contract, on recorded fixtures of the rows the design names
-- (sms.md section 10, recorded 23 Sep 2026 06:33Z; job numbers and GHL ids as
-- recorded, no customer names):
--   R1   pffXnIL1v2FTaKnz4DHm  "I haven't received all three quotes as yet?"
--        one contact, two open fencing quotes SWF-261448 and SWF-261431.
--        Luna answers several: unplaced, both candidates kept, in the
--        not-yet-placed lane of both jobs, never asked again.
--   R17  K96MNiYqLzNhENhginhN (several) and zZP3HOml9Po5Cq23UHYE (undecided),
--        option quotes SWF-261421 and SWF-261422: both unplaced, shown once in
--        each job's lane, never re-asked unless a named event fires.
--   G-ATTR  a row the model cannot place makes one ask and rests.
--   cadence section 6 step 7: errors recorded against the row with backoff,
--   never failing the tick; attribution capped at 60 of the 400 daily calls.

-- 1. R1: several -> unplaced, one ask, then at rest.
BEGIN;
DO $$
DECLARE j48 uuid:=gen_random_uuid(); j31 uuid:=gen_random_uuid(); e public.business_events; eid uuid;
 a public.context_attribution_attempts; n integer;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES
 (j48,'00000000-0000-0000-0000-000000000001','quoted','fencing','SWF-261448','lYPee0K2DuQHXH2xHL1P'),
 (j31,'00000000-0000-0000-0000-000000000001','quoted','fencing','SWF-261431','lYPee0K2DuQHXH2xHL1P');
 INSERT INTO public.business_events(payload,contact_id,provider_message_id,direction,event_at)
 VALUES('{"body":"I haven''t received all three quotes as yet?","line":"fencing"}','lYPee0K2DuQHXH2xHL1P',
  'ghl:pffXnIL1v2FTaKnz4DHm','inbound','2026-09-23T04:35:00Z') RETURNING * INTO e;
 IF e.attribution_status<>'pending_luna' THEN RAISE EXCEPTION 'R1 fixture: two open fencing quotes must go to review, got %',e.attribution_status; END IF;
 eid:=e.id;
 -- The candidate list the placement track stores at review time (P1a).
 UPDATE public.business_events SET candidate_job_ids=ARRAY[j48,j31] WHERE id=eid;
 SELECT count(*) INTO n FROM public.context_attribution_due(200) WHERE id=eid;
 IF n<>1 THEN RAISE EXCEPTION 'R1: a never-asked pending row must be due'; END IF;
 e:=public.attribute_context_event_with_luna(eid,NULL,NULL,'several');
 IF e.attribution_status<>'unplaced' OR e.job_id IS NOT NULL OR e.attributed_at IS NOT NULL
  OR e.candidate_job_ids IS DISTINCT FROM ARRAY[j48,j31] OR e.metadata->>'luna_outcome'<>'several'
 THEN RAISE EXCEPTION 'R1: several must rest unplaced with both candidates, got % % % %',e.attribution_status,e.job_id,e.candidate_job_ids,e.metadata; END IF;
 SELECT * INTO a FROM public.context_attribution_attempts WHERE event_id=eid;
 IF a.attempts<>1 OR a.outcome<>'several' OR a.next_at IS NOT NULL OR a.asks_on_date<>1 OR a.last_code IS NOT NULL
 THEN RAISE EXCEPTION 'R1: one ask recorded, got %',to_jsonb(a); END IF;
 -- In the not-yet-placed lane of both jobs, once each.
 SELECT count(*) INTO n FROM public.context_unplaced_for_job(j48) WHERE id=eid;
 IF n<>1 THEN RAISE EXCEPTION 'R1: missing from SWF-261448 lane'; END IF;
 SELECT count(*) INTO n FROM public.context_unplaced_for_job(j31) WHERE id=eid;
 IF n<>1 THEN RAISE EXCEPTION 'R1: missing from SWF-261431 lane'; END IF;
 -- At rest: not due, not re-run by the bucket, not answerable again.
 SELECT count(*) INTO n FROM public.context_attribution_due(200) WHERE id=eid;
 IF n<>0 THEN RAISE EXCEPTION 'R1: an unplaced row must never be offered again'; END IF;
 PERFORM public.rerun_context_attribution(1000,NULL);
 SELECT * INTO e FROM public.business_events WHERE id=eid;
 IF e.attribution_status<>'unplaced' THEN RAISE EXCEPTION 'R1: bucket re-run moved a resting row to %',e.attribution_status; END IF;
 BEGIN
  PERFORM public.attribute_context_event_with_luna(eid,j48,0.95,'job');
  RAISE EXCEPTION 'R1: a resting row accepted a second answer';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'event is not pending Luna' THEN RAISE; END IF;
 END;
END $$;
ROLLBACK;

-- 2. R17: several and undecided on two option quotes: both rest, each once per lane.
BEGIN;
DO $$
DECLARE j21 uuid:=gen_random_uuid(); j22 uuid:=gen_random_uuid(); e1 public.business_events; e2 public.business_events; n integer;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES
 (j21,'00000000-0000-0000-0000-000000000001','quoted','fencing','SWF-261421','r17-contact'),
 (j22,'00000000-0000-0000-0000-000000000001','quoted','fencing','SWF-261422','r17-contact');
 INSERT INTO public.business_events(payload,contact_id,provider_message_id,direction,event_at)
 VALUES('{"body":"Confirms receipt of both quote emails","line":"fencing"}','r17-contact','ghl:K96MNiYqLzNhENhginhN','inbound','2026-09-15T02:00:00Z')
 RETURNING * INTO e1;
 INSERT INTO public.business_events(payload,contact_id,provider_message_id,direction,event_at)
 VALUES('{"body":"Neighbour prefers the taller option","line":"fencing"}','r17-contact','ghl:zZP3HOml9Po5Cq23UHYE','inbound','2026-09-17T02:00:00Z')
 RETURNING * INTO e2;
 IF e1.attribution_status<>'pending_luna' OR e2.attribution_status<>'pending_luna' THEN RAISE EXCEPTION 'R17 fixture: both must go to review'; END IF;
 UPDATE public.business_events SET candidate_job_ids=ARRAY[j21,j22] WHERE id IN (e1.id,e2.id);
 e1:=public.attribute_context_event_with_luna(e1.id,NULL,NULL,'several');
 e2:=public.attribute_context_event_with_luna(e2.id,NULL,0.4,'undecided');
 IF e1.attribution_status<>'unplaced' OR e1.metadata->>'luna_outcome'<>'several'
  OR e2.attribution_status<>'unplaced' OR e2.metadata->>'luna_outcome'<>'undecided'
 THEN RAISE EXCEPTION 'R17: both must rest unplaced with their answer recorded'; END IF;
 SELECT count(*) INTO n FROM public.context_unplaced_for_job(j21) WHERE id IN (e1.id,e2.id);
 IF n<>2 THEN RAISE EXCEPTION 'R17: SWF-261421 lane shows % of 2',n; END IF;
 SELECT count(*) INTO n FROM public.context_unplaced_for_job(j22) WHERE id IN (e1.id,e2.id);
 IF n<>2 THEN RAISE EXCEPTION 'R17: SWF-261422 lane shows % of 2',n; END IF;
 SELECT count(*) INTO n FROM public.context_attribution_due(200) WHERE id IN (e1.id,e2.id);
 IF n<>0 THEN RAISE EXCEPTION 'R17: resting rows re-asked'; END IF;
 SELECT count(*) INTO n FROM public.context_attribution_attempts WHERE event_id IN (e1.id,e2.id) AND attempts=1 AND next_at IS NULL;
 IF n<>2 THEN RAISE EXCEPTION 'R17: expected one recorded ask each'; END IF;
END $$;
ROLLBACK;

-- 3. The job outcome: a confident pick places the row; below 0.8 it rests.
BEGIN;
DO $$
DECLARE ja uuid:=gen_random_uuid(); jb uuid:=gen_random_uuid(); e public.business_events; eid uuid; n integer;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES
 (ja,'00000000-0000-0000-0000-000000000001','quoted','fencing','A1-PICK-A','a1-pick'),
 (jb,'00000000-0000-0000-0000-000000000001','quoted','fencing','A1-PICK-B','a1-pick');
 INSERT INTO public.business_events(payload,contact_id,direction,thread_key) VALUES('{"body":"About the colorbond one","line":"fencing"}','a1-pick','inbound','a1-thread') RETURNING * INTO e;
 IF e.attribution_status<>'pending_luna' THEN RAISE EXCEPTION 'pick fixture must go to review'; END IF;
 e:=public.attribute_context_event_with_luna(e.id,ja,0.92,'job');
 IF e.attribution_status<>'luna' OR e.job_id<>ja OR e.attribution_confidence<>0.92 OR e.attributed_at IS NULL OR e.metadata->>'luna_outcome'<>'job'
 THEN RAISE EXCEPTION 'confident pick not placed: % %',e.attribution_status,e.metadata; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.event_threads WHERE thread_key='a1-thread' AND job_id=ja) THEN RAISE EXCEPTION 'thread binding lost on the job path'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_attribution_attempts WHERE event_id=e.id AND outcome='job' AND attempts=1) THEN RAISE EXCEPTION 'job answer not recorded'; END IF;
 -- Below the floor: honestly unknown beats confidently wrong.
 INSERT INTO public.business_events(payload,contact_id,direction) VALUES('{"body":"Is it booked in?","line":"fencing"}','a1-pick','inbound') RETURNING * INTO e;
 eid:=e.id;
 e:=public.attribute_context_event_with_luna(eid,jb,0.6,'job');
 IF e.attribution_status<>'unplaced' OR e.job_id IS NOT NULL OR e.metadata->>'luna_outcome'<>'undecided'
  OR (e.metadata->'luna_below_floor'->>'job_id')::uuid<>jb OR (e.metadata->'luna_below_floor'->>'confidence')::numeric<>0.6
 THEN RAISE EXCEPTION 'below-floor pick must rest as undecided, got % %',e.attribution_status,e.metadata; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_attribution_attempts WHERE event_id=eid AND outcome='undecided') THEN RAISE EXCEPTION 'below-floor answer not recorded'; END IF;
 -- A job that is not the contact's candidate is refused, and nothing is written.
 INSERT INTO public.business_events(payload,contact_id,direction) VALUES('{"body":"Another one","line":"fencing"}','a1-pick','inbound') RETURNING * INTO e;
 BEGIN
  PERFORM public.attribute_context_event_with_luna(e.id,gen_random_uuid(),0.99,'job');
  RAISE EXCEPTION 'non-candidate job accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'job is not a contact candidate' THEN RAISE; END IF; END;
 SELECT count(*) INTO n FROM public.context_attribution_attempts WHERE event_id=e.id;
 IF n<>0 THEN RAISE EXCEPTION 'a refused answer wrote an attempt'; END IF;
END $$;
ROLLBACK;

-- 4. Bad calls are refused before anything is read or written.
BEGIN;
DO $$
DECLARE j uuid:=gen_random_uuid(); e public.business_events; x record;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES
 (j,'00000000-0000-0000-0000-000000000001','quoted','fencing','A1-BAD-A','a1-bad'),
 (gen_random_uuid(),'00000000-0000-0000-0000-000000000001','quoted','fencing','A1-BAD-B','a1-bad');
 INSERT INTO public.business_events(payload,contact_id) VALUES('{"body":"Bad calls","line":"fencing"}','a1-bad') RETURNING * INTO e;
 FOR x IN SELECT * FROM (VALUES
  (NULL::uuid,NULL::numeric,NULL::text,'invalid attribution outcome'),
  (NULL,NULL,'maybe','invalid attribution outcome'),
  (NULL,0.9,'job','job outcome needs a job'),
  (j,0.9,'several','several or undecided names no job'),
  (j,NULL,'job','invalid confidence'),
  (j,1.5,'job','invalid confidence')) AS t(job,conf,outcome,msg) LOOP
  BEGIN
   PERFORM public.attribute_context_event_with_luna(e.id,x.job,x.conf,x.outcome);
   RAISE EXCEPTION 'bad call accepted: % % %',x.job,x.conf,x.outcome;
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>x.msg THEN RAISE; END IF; END;
 END LOOP;
 BEGIN
  PERFORM public.record_attribution_error(e.id,'Customer said: the gate is broken');
  RAISE EXCEPTION 'free text accepted as an error code';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'invalid attribution error code' THEN RAISE; END IF; END;
 BEGIN
  PERFORM public.record_attribution_error(gen_random_uuid(),'model_timeout');
  RAISE EXCEPTION 'unknown event accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'event not found' THEN RAISE; END IF; END;
 IF EXISTS(SELECT 1 FROM public.context_attribution_attempts WHERE event_id=e.id) THEN RAISE EXCEPTION 'bad calls wrote an attempt'; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 IF e.attribution_status<>'pending_luna' THEN RAISE EXCEPTION 'bad calls moved the row'; END IF;
 -- Attribution lane off: no answer, and no row is due.
 UPDATE public.automation_switches SET attribution=false WHERE id=1;
 BEGIN
  PERFORM public.attribute_context_event_with_luna(e.id,NULL,NULL,'undecided');
  RAISE EXCEPTION 'answer accepted with the lane off';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'attribution disabled' THEN RAISE; END IF; END;
 IF EXISTS(SELECT 1 FROM public.context_attribution_due(200)) THEN RAISE EXCEPTION 'rows due with the lane off'; END IF;
END $$;
ROLLBACK;

-- 5. Errors: recorded against the row, backoff 30 min then the next Perth day
-- (at most 2 asks a Perth day), then the next day again; a changed candidate
-- list re-allows an ask at once.
BEGIN;
DO $$
DECLARE ja uuid:=gen_random_uuid(); jb uuid:=gen_random_uuid(); jc uuid:=gen_random_uuid(); e public.business_events; eid uuid;
 r jsonb; n integer; t0 timestamptz:=clock_timestamp(); tomorrow timestamptz; asked_at timestamptz; expected_second timestamptz;
BEGIN
 tomorrow:=(date_trunc('day',t0 AT TIME ZONE 'Australia/Perth')+interval '1 day') AT TIME ZONE 'Australia/Perth';
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES
 (ja,'00000000-0000-0000-0000-000000000001','quoted','fencing','A1-ERR-A','a1-err'),
 (jb,'00000000-0000-0000-0000-000000000001','quoted','fencing','A1-ERR-B','a1-err');
 INSERT INTO public.business_events(payload,contact_id,direction) VALUES('{"body":"Which quote is cheaper?","line":"fencing"}','a1-err','inbound') RETURNING * INTO e;
 eid:=e.id;
 r:=public.record_attribution_error(eid,'model_timeout');
 IF (r->>'attempts')::int<>1 OR (r->>'next_at')::timestamptz NOT BETWEEN t0+interval '29 minutes' AND clock_timestamp()+interval '31 minutes'
  OR r->>'outcome'<>'error' OR r->>'last_code'<>'model_timeout'
 THEN RAISE EXCEPTION 'first error must back off 30 minutes, got %',r; END IF;
 SELECT count(*) INTO n FROM public.context_attribution_due(200) WHERE id=eid;
 IF n<>0 THEN RAISE EXCEPTION 'row in backoff offered'; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=eid;
 IF e.attribution_status<>'pending_luna' THEN RAISE EXCEPTION 'an error moved the row'; END IF;
 -- Backoff over: due again.
 UPDATE public.context_attribution_attempts SET next_at=clock_timestamp()-interval '1 second' WHERE event_id=eid;
 SELECT count(*) INTO n FROM public.context_attribution_due(200) WHERE id=eid;
 IF n<>1 THEN RAISE EXCEPTION 'row past its backoff not offered'; END IF;
 -- Second ask the same Perth day: at most two asks, so wait until the next
 -- Perth day, or 2 hours if that is later (after 22:00 Perth the 2-hour
 -- attempt backoff extends past midnight).
 r:=public.record_attribution_error(eid,'rpc_error');
 SELECT last_at INTO asked_at FROM public.context_attribution_attempts WHERE event_id=eid;
 expected_second:=greatest(asked_at+interval '2 hours',
  (date_trunc('day',asked_at AT TIME ZONE 'Australia/Perth')+interval '1 day') AT TIME ZONE 'Australia/Perth');
 IF (r->>'attempts')::int<>2 OR (r->>'asks_on_date')::int<>2 OR (r->>'next_at')::timestamptz IS DISTINCT FROM expected_second
 THEN RAISE EXCEPTION 'second ask today must wait until the later of 2 hours and the next Perth day, got % (want %)',r,expected_second; END IF;
 -- A later day: the third consecutive failure also waits for the next Perth day.
 UPDATE public.context_attribution_attempts SET asks_date=asks_date-1,next_at=clock_timestamp()-interval '1 second' WHERE event_id=eid;
 r:=public.record_attribution_error(eid,'model_timeout');
 IF (r->>'attempts')::int<>3 OR (r->>'asks_on_date')::int<>1 OR (r->>'next_at')::timestamptz<>tomorrow
 THEN RAISE EXCEPTION 'third failure must wait for the next Perth day, got %',r; END IF;
 -- Its candidate list changes (a new job for the contact): asked again at once, counts restart.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES
 (jc,'00000000-0000-0000-0000-000000000001','quoted','fencing','A1-ERR-C','a1-err');
 -- Since P1a the list is stored at review time; the sibling reopen (P1b)
 -- rewrites it when a new job for the contact is created. Do that here.
 UPDATE public.business_events SET candidate_job_ids=ARRAY[ja,jb,jc] WHERE id=eid AND candidate_job_ids IS NOT NULL;
 SELECT count(*) INTO n FROM public.context_attribution_due(200) WHERE id=eid;
 IF n<>1 THEN RAISE EXCEPTION 'changed candidate list not re-offered'; END IF;
 r:=public.record_attribution_error(eid,'model_timeout');
 IF (r->>'attempts')::int<>1 OR (r->>'asks_on_date')::int<>1 THEN RAISE EXCEPTION 'changed candidates must restart counts, got %',r; END IF;
 -- After errors the row can still be answered and rests.
 UPDATE public.context_attribution_attempts SET next_at=NULL WHERE event_id=eid;
 e:=public.attribute_context_event_with_luna(eid,NULL,NULL,'undecided');
 IF e.attribution_status<>'unplaced' THEN RAISE EXCEPTION 'answer after errors not recorded'; END IF;
 -- Oldest first.
 INSERT INTO public.business_events(payload,contact_id,occurred_at) VALUES('{"body":"older","line":"fencing"}','a1-err','2026-01-01Z'),('{"body":"newer","line":"fencing"}','a1-err','2026-02-01Z');
 IF (SELECT string_agg(payload->>'body',',') FROM public.context_attribution_due(2) WHERE contact_id='a1-err')<>'older,newer'
 THEN RAISE EXCEPTION 'due rows not oldest first'; END IF;
END $$;
ROLLBACK;

-- 6. Attribution sub-budget: 60 of the day's 400 calls; other phases unaffected.
BEGIN;
DO $$
DECLARE d date:=(clock_timestamp() AT TIME ZONE 'Australia/Perth')::date; r jsonb; n integer;
BEGIN
 DELETE FROM public.context_model_call_reservations WHERE run_date=d;
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,reserved_at)
  SELECT d,g,'attribution',clock_timestamp() FROM generate_series(1,59) g;
 r:=public.reserve_context_model_call('attribution',NULL,NULL);
 IF r->>'outcome'<>'reserved' OR (r->>'ordinal')::int<>60 THEN RAISE EXCEPTION 'the 60th attribution call must be reserved, got %',r; END IF;
 r:=public.reserve_context_model_call('attribution',NULL,NULL);
 IF r->>'outcome'<>'attribution_budget' OR (r->>'limit')::int<>60 THEN RAISE EXCEPTION 'the 61st attribution call must be refused, got %',r; END IF;
 SELECT count(*) INTO n FROM public.context_model_call_reservations WHERE run_date=d;
 IF n<>60 THEN RAISE EXCEPTION 'a refused call reserved a slot'; END IF;
 r:=public.reserve_context_model_call('bucket',NULL,NULL);
 IF r->>'outcome'<>'reserved' OR (r->>'ordinal')::int<>61 THEN RAISE EXCEPTION 'other phases must not share the attribution budget, got %',r; END IF;
 -- The 400 cap still holds for every phase.
 DELETE FROM public.context_model_call_reservations WHERE run_date=d;
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,reserved_at)
  SELECT d,g,'bucket',clock_timestamp() FROM generate_series(1,400) g;
 r:=public.reserve_context_model_call('attribution',NULL,NULL);
 IF r->>'outcome'<>'cap' THEN RAISE EXCEPTION 'daily cap lost, got %',r; END IF;
 -- Yesterday's calls do not count against today.
 DELETE FROM public.context_model_call_reservations WHERE run_date=d;
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,reserved_at)
  SELECT d-1,g,'attribution',clock_timestamp() FROM generate_series(1,60) g;
 r:=public.reserve_context_model_call('attribution',NULL,NULL);
 IF r->>'outcome'<>'reserved' THEN RAISE EXCEPTION 'yesterday counted against today, got %',r; END IF;
END $$;
ROLLBACK;

-- 7. Nothing is reachable by the public key or a signed-in login; the attempt
-- table and its writer are not writable by service_role directly.
DO $$
DECLARE f text; role_name text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.attribute_context_event_with_luna(uuid,uuid,numeric,text)','public.record_attribution_error(uuid,text)',
  'public.context_attribution_due(integer)','public.reserve_context_model_call(text,uuid,uuid)',
  'public.context_attribution_record_attempt(public.business_events,text,text)','public.context_attribution_candidate_hash(public.business_events)',
  'public.context_attribution_next_perth_day(timestamptz)'] LOOP
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF has_function_privilege(role_name,f,'EXECUTE') THEN RAISE EXCEPTION '% can execute %',role_name,f; END IF;
  END LOOP;
 END LOOP;
 IF has_function_privilege('service_role','public.context_attribution_record_attempt(public.business_events,text,text)','EXECUTE')
 THEN RAISE EXCEPTION 'service_role can call the private attempt writer'; END IF;
 FOREACH f IN ARRAY ARRAY['public.attribute_context_event_with_luna(uuid,uuid,numeric,text)','public.record_attribution_error(uuid,text)',
  'public.context_attribution_due(integer)','public.reserve_context_model_call(text,uuid,uuid)'] LOOP
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %',f; END IF;
 END LOOP;
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_table_privilege(role_name,'public.context_attribution_attempts','INSERT,UPDATE,DELETE,TRUNCATE')
  THEN RAISE EXCEPTION '% can write context_attribution_attempts',role_name; END IF;
 END LOOP;
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF has_table_privilege(role_name,'public.context_attribution_attempts','SELECT') THEN RAISE EXCEPTION '% can read attempts',role_name; END IF;
 END LOOP;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.context_attribution_attempts'::regclass) THEN RAISE EXCEPTION 'attempts RLS off'; END IF;
END $$;

-- 8. The deployed runtime's three-argument call keeps its behaviour (no pick ->
-- admin_bucket) and writes no attempt. Its body is the live one, or P1a's
-- (20260924140000: the guard reads the stored candidate list).
BEGIN;
DO $$
DECLARE ja uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.attribute_context_event_with_luna(uuid,uuid,numeric)')) NOT IN ('48eabf7e132092cd225ff5060ce58846','fde44559c43dcc770d1c42909f4adeaf','62ed28cbcf041d7cdcda298907a756fa')
 THEN RAISE EXCEPTION 'legacy Luna function changed'; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES
 (ja,'00000000-0000-0000-0000-000000000001','quoted','fencing','A1-LEG-A','a1-leg'),
 (gen_random_uuid(),'00000000-0000-0000-0000-000000000001','quoted','fencing','A1-LEG-B','a1-leg');
 INSERT INTO public.business_events(payload,contact_id) VALUES('{"body":"Legacy caller","line":"fencing"}','a1-leg') RETURNING * INTO e;
 e:=public.attribute_context_event_with_luna(e.id,NULL,0);
 IF e.attribution_status<>'admin_bucket' OR e.attribution_step<>6 OR e.metadata ? 'luna_outcome' THEN RAISE EXCEPTION 'legacy no-pick behaviour changed'; END IF;
 INSERT INTO public.business_events(payload,contact_id) VALUES('{"body":"Legacy pick","line":"fencing"}','a1-leg') RETURNING * INTO e;
 e:=public.attribute_context_event_with_luna(e.id,ja,0.6);
 IF e.attribution_status<>'luna' OR e.job_id<>ja THEN RAISE EXCEPTION 'legacy pick behaviour changed'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_attribution_attempts a JOIN public.business_events b ON b.id=a.event_id WHERE b.contact_id='a1-leg')
 THEN RAISE EXCEPTION 'legacy calls wrote attempts'; END IF;
END $$;
ROLLBACK;
