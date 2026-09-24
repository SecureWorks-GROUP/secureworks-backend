-- P1b behaviour contract, on recorded fixtures of the rows the design names
-- (sms.md section 10, read 23 Sep 2026 06:33Z; INTEGRATION X18). Job numbers,
-- GHL message ids and GHL contact ids are as recorded; where the design gives
-- no contact id the fixture uses a synthetic label. No customer names. Times
-- are the recorded message times and the job creation times the design states.
--   R14  XyDhsX5IZ9kaS2XxPEzr, oS67q2BCAyhbIl4SjihH  pre-job texts: bound to
--        SWF-261431 on its creation; SWF-261448's window covers them too, so
--        they reopen with both candidates (relink); Luna may then place them.
--   R18  GCMPdVbyRdUuvBIzrXSv, 9uyM8hkpScFvGqjU9gRN  patio then decking: the
--        7 Apr text reopens when SWD-26071 is created; the 774 line does not
--        decide patio against decking.
--   R17  K96MNiYqLzNhENhginhN, zZP3HOml9Po5Cq23UHYE  unplaced option-quote
--        texts: never re-asked unless a named event fires; a new job whose
--        window covers them is such an event, once.
--   R1   pffXnIL1v2FTaKnz4DHm  in review with two quotes: a third quote job
--        joins its candidates; it stays in review, still live.
--   R8   uQQ42WwGWSnz0Ccvs5Go  lead text placed by a job 20 days later, not 34.
--   R15  vylm5LHmbChCfgZLawc2  3 Jul, SWF-261209 created 14 Aug: stays before
--        any job, and the job insert does not even look at it (X18).
--   Never moved: direct, thread, content_ref and party placements; rows
--   outside the window.
--   Audit I9: a job with no contact reconsiders nothing.
--   Holding job, attribution lane off, and a failing reconsideration never
--   fail the job insert.

-- 1. R14: bound on the first quote's creation, reopened on the second's.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; j31 uuid:=gen_random_uuid(); j48 uuid:=gen_random_uuid();
 e1 public.business_events; e2 public.business_events; e3 public.business_events; fresh public.business_events;
 r jsonb; n integer;
BEGIN
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Could you quote the side and back fence?","line":"fencing"}','lYPee0K2DuQHXH2xHL1P','ghl:XyDhsX5IZ9kaS2XxPEzr','sms','inbound','2026-09-16T03:00:00Z')
 RETURNING * INTO e1;
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"And a separate price for the front","line":"fencing"}','lYPee0K2DuQHXH2xHL1P','ghl:oS67q2BCAyhbIl4SjihH','sms','inbound','2026-09-16T03:05:00Z')
 RETURNING * INTO e2;
 IF e1.attribution_status IS DISTINCT FROM 'admin_bucket' OR e2.attribution_status IS DISTINCT FROM 'admin_bucket' THEN RAISE EXCEPTION 'R14 fixture: pre-job texts must start in the bucket'; END IF;

 -- First quote, 17 Sep: window 18 Aug to 17 Sep covers 16 Sep; one candidate.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at)
 VALUES(j31,org,'quoted','fencing','SWF-261431','lYPee0K2DuQHXH2xHL1P','2026-09-17T02:00:00Z');
 SELECT * INTO e1 FROM public.business_events WHERE id=e1.id;
 SELECT * INTO e2 FROM public.business_events WHERE id=e2.id;
 IF e1.job_id IS DISTINCT FROM j31 OR e1.attribution_status IS DISTINCT FROM 'single_open' OR e2.job_id IS DISTINCT FROM j31 OR e2.attribution_status IS DISTINCT FROM 'single_open'
 THEN RAISE EXCEPTION 'R14: not bound to SWF-261431 on its creation, got % % / % %',e1.attribution_status,e1.job_id,e2.attribution_status,e2.job_id; END IF;
 IF coalesce(e1.metadata->>'capture_mode','live') IS DISTINCT FROM 'live' OR e1.metadata ? 'capture_mode_before'
  OR e1.metadata->'placement_reconsidered'->>'reason' IS DISTINCT FROM 'job_created' OR e1.metadata->'placement_reconsidered'->>'job_id' IS DISTINCT FROM j31::text
  OR e1.metadata->'placement_reconsidered'->>'from_status' IS DISTINCT FROM 'admin_bucket'
 THEN RAISE EXCEPTION 'R14: first bind must keep live and record the placement, got %',e1.metadata; END IF;

 -- A 20 Aug text: inside SWF-261431's window, outside SWF-261448's (22 Aug on).
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"When could someone come out?"}','lYPee0K2DuQHXH2xHL1P','ghl:p1b-r14-20aug','sms','inbound','2026-08-20T03:00:00Z')
 RETURNING * INTO e3;
 UPDATE public.business_events SET job_id=j31,attribution_status='single_open',attribution_step=3,match_method='contact_id',match_status='matched' WHERE id=e3.id;

 -- Second quote, 21 Sep: window 22 Aug to 21 Sep covers 16 Sep. Both 16 Sep
 -- texts go back to review with both quotes; the 20 Aug text stays.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at)
 VALUES(j48,org,'quoted','fencing','SWF-261448','lYPee0K2DuQHXH2xHL1P','2026-09-21T02:00:00Z');
 SELECT * INTO e1 FROM public.business_events WHERE id=e1.id;
 SELECT * INTO e2 FROM public.business_events WHERE id=e2.id;
 SELECT * INTO e3 FROM public.business_events WHERE id=e3.id;
 IF e1.job_id IS NOT NULL OR e1.attribution_status IS DISTINCT FROM 'pending_luna' OR e1.attribution_step IS DISTINCT FROM 5 OR e1.candidate_job_ids IS DISTINCT FROM ARRAY[j31,j48]
  OR e2.job_id IS NOT NULL OR e2.attribution_status IS DISTINCT FROM 'pending_luna' OR e2.candidate_job_ids IS DISTINCT FROM ARRAY[j31,j48]
 THEN RAISE EXCEPTION 'R14: 16 Sep texts must reopen with both quotes, got % % % / % %',e1.attribution_status,e1.job_id,e1.candidate_job_ids,e2.attribution_status,e2.candidate_job_ids; END IF;
 IF e1.metadata->>'placement_rule' IS DISTINCT FROM 'reopen_new_job' OR e1.metadata->>'capture_mode' IS DISTINCT FROM 'relink'
  OR e1.metadata->>'capture_mode_before' IS DISTINCT FROM 'live'
  OR e1.metadata->'placement_reconsidered'->>'job_id' IS DISTINCT FROM j48::text OR e1.metadata->'placement_reconsidered'->>'from_job_id' IS DISTINCT FROM j31::text
  OR e1.metadata->'placement_reconsidered'->>'from_status' IS DISTINCT FROM 'single_open'
  OR e1.attributed_at IS NOT NULL OR e1.match_method IS DISTINCT FROM 'none' OR e1.match_status IS DISTINCT FROM 'unresolved'
 THEN RAISE EXCEPTION 'R14: reopen not recorded, got %',e1.metadata; END IF;
 IF e3.job_id IS DISTINCT FROM j31 OR e3.attribution_status IS DISTINCT FROM 'single_open' OR e3.metadata ? 'placement_reconsidered'
 THEN RAISE EXCEPTION 'R14: a 20 Aug text outside SWF-261448''s window moved, got % %',e3.attribution_status,e3.job_id; END IF;
 -- Shown once in each quote's not-yet-placed lane.
 SELECT count(*) INTO n FROM public.context_unplaced_for_job(j31) WHERE id IN (e1.id,e2.id);
 IF n<>2 THEN RAISE EXCEPTION 'R14: reopened texts missing from the SWF-261431 lane (%)',n; END IF;
 SELECT count(*) INTO n FROM public.context_unplaced_for_job(j48) WHERE id IN (e1.id,e2.id);
 IF n<>2 THEN RAISE EXCEPTION 'R14: reopened texts missing from the SWF-261448 lane (%)',n; END IF;

 -- At most once per event: a second call for the same job moves nothing.
 r:=public.context_reconsider_contact('lYPee0K2DuQHXH2xHL1P','2026-08-22T02:00:00Z','job_created',j48);
 IF (r->>'seen')::int IS DISTINCT FROM 0 OR (r->>'reopened')::int IS DISTINCT FROM 0 OR (r->>'placed')::int IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'R14: second call was not a no-op: %',r; END IF;

 -- Luna may choose the new job: the guard reads the stored list.
 e1:=public.attribute_context_event_with_luna(e1.id,j48,0.9,'job');
 IF e1.job_id IS DISTINCT FROM j48 OR e1.attribution_status IS DISTINCT FROM 'luna' THEN RAISE EXCEPTION 'R14: Luna could not place on SWF-261448, got %',e1.attribution_status; END IF;
 -- A reopened text placed later never wakes an extraction read on its own.
 IF (public.context_job_cadence(j48)->>'waking_count')::int IS DISTINCT FROM 0
 THEN RAISE EXCEPTION 'R14: a relinked text woke SWF-261448: %',public.context_job_cadence(j48); END IF;
 -- Control: a fresh customer text placed by Luna the same way does wake it.
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"I haven''t received all three quotes as yet?","line":"fencing"}','lYPee0K2DuQHXH2xHL1P','ghl:pffXnIL1v2FTaKnz4DHm','sms','inbound','2026-09-23T04:35:00Z')
 RETURNING * INTO fresh;
 IF fresh.attribution_status IS DISTINCT FROM 'pending_luna' THEN RAISE EXCEPTION 'R14 control: fresh text not in review'; END IF;
 fresh:=public.attribute_context_event_with_luna(fresh.id,j48,0.9,'job');
 IF (public.context_job_cadence(j48)->>'waking_count')::int IS DISTINCT FROM 1
 THEN RAISE EXCEPTION 'R14 control: a live text placed by Luna must wake SWF-261448: %',public.context_job_cadence(j48); END IF;
END $$;
ROLLBACK;

-- 2. R18: patio estimate question before SWP-26056 exists; decking promise on
-- 7 Apr to 774 while SWP-26056 is the only job; SWD-26071 created 11 Apr
-- (window 12 Mar to 11 Apr) reopens both, and the patio line does not decide.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; p uuid:=gen_random_uuid(); d uuid:=gen_random_uuid();
 e1 public.business_events; e2 public.business_events;
BEGIN
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Roughly what would a patio estimate be?","line":"patio"}','r18-contact','ghl:GCMPdVbyRdUuvBIzrXSv','sms','inbound','2026-04-02Z') RETURNING * INTO e1;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(p,org,'quoted','patio','SWP-26056','r18-contact','2026-04-03Z');
 SELECT * INTO e1 FROM public.business_events WHERE id=e1.id;
 IF e1.job_id IS DISTINCT FROM p OR e1.attribution_status IS DISTINCT FROM 'single_open' THEN RAISE EXCEPTION 'R18: first text not bound to SWP-26056 on its creation'; END IF;
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Thanks for the decking promise","line":"patio"}','r18-contact','ghl:9uyM8hkpScFvGqjU9gRN','sms','inbound','2026-04-07Z') RETURNING * INTO e2;
 IF e2.job_id IS DISTINCT FROM p OR e2.attribution_status IS DISTINCT FROM 'single_open' THEN RAISE EXCEPTION 'R18: 7 Apr text must link to the only candidate SWP-26056'; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(d,org,'quoted','decking','SWD-26071','r18-contact','2026-04-11Z');
 SELECT * INTO e1 FROM public.business_events WHERE id=e1.id;
 SELECT * INTO e2 FROM public.business_events WHERE id=e2.id;
 IF e2.job_id IS NOT NULL OR e2.attribution_status IS DISTINCT FROM 'pending_luna' OR e2.candidate_job_ids IS DISTINCT FROM ARRAY[p,d]
 THEN RAISE EXCEPTION 'R18: 7 Apr text must reopen with SWP-26056 and SWD-26071 (line never decides patio against decking), got % % %',e2.attribution_status,e2.job_id,e2.candidate_job_ids; END IF;
 IF e1.job_id IS NOT NULL OR e1.attribution_status IS DISTINCT FROM 'pending_luna' OR e1.candidate_job_ids IS DISTINCT FROM ARRAY[p,d]
 THEN RAISE EXCEPTION 'R18: 2 Apr text is inside SWD-26071''s window too and must reopen, got % %',e1.attribution_status,e1.candidate_job_ids; END IF;
 -- Luna places the decking thanks on SWD-26071.
 e2:=public.attribute_context_event_with_luna(e2.id,d,0.9,'job');
 IF e2.job_id IS DISTINCT FROM d THEN RAISE EXCEPTION 'R18: Luna could not place the decking text on SWD-26071'; END IF;
END $$;
ROLLBACK;

-- 3. R17: two option quotes; both texts rest unplaced. Nothing re-asks them
-- until a named event: another customer's job, a job with no customer and a
-- holding job are not events; a new job for this customer whose window covers
-- them is, once.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; j21 uuid:=gen_random_uuid(); j22 uuid:=gen_random_uuid(); j3 uuid:=gen_random_uuid();
 e1 public.business_events; e2 public.business_events; before_at timestamptz; r jsonb; n integer;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
 (j21,org,'quoted','fencing','SWF-261421','r17-contact','2026-09-10Z'),(j22,org,'quoted','fencing','SWF-261422','r17-contact','2026-09-10Z');
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Confirming receipt of both quote emails"}','r17-contact','ghl:K96MNiYqLzNhENhginhN','sms','inbound','2026-09-15Z') RETURNING * INTO e1;
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"The neighbour prefers the lower one"}','r17-contact','ghl:zZP3HOml9Po5Cq23UHYE','sms','inbound','2026-09-17Z') RETURNING * INTO e2;
 e1:=public.attribute_context_event_with_luna(e1.id,NULL,NULL,'several');
 e2:=public.attribute_context_event_with_luna(e2.id,NULL,NULL,'undecided');
 IF e1.attribution_status IS DISTINCT FROM 'unplaced' OR e2.attribution_status IS DISTINCT FROM 'unplaced' THEN RAISE EXCEPTION 'R17 fixture: both must rest unplaced'; END IF;
 before_at:=e1.attribution_checked_at;
 -- Not events.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
 (gen_random_uuid(),org,'quoted','fencing','P1B-R17-OTHER','r17-someone-else','2026-09-18Z'),
 (gen_random_uuid(),org,'processing','makesafe','P1B-R17-NOCONTACT',NULL,'2026-09-18Z');
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at,metadata)
 VALUES(gen_random_uuid(),org,'quoted','fencing','P1B-R17-HOLDING','r17-contact','2026-09-18Z','{"do_not_schedule":true}');
 IF (SELECT count(*) FROM public.business_events WHERE id IN (e1.id,e2.id) AND attribution_status='unplaced')<>2
  OR (SELECT attribution_checked_at FROM public.business_events WHERE id=e1.id) IS DISTINCT FROM before_at
 THEN RAISE EXCEPTION 'R17: a non-event touched a resting text'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_attribution_due(200) WHERE id IN (e1.id,e2.id)) THEN RAISE EXCEPTION 'R17 fixture: resting texts must not be due'; END IF;
 -- The named event: a third job for this customer, window 19 Aug to 18 Sep.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(j3,org,'quoted','fencing','P1B-R17-THIRD','r17-contact','2026-09-18T01:00:00Z');
 SELECT * INTO e1 FROM public.business_events WHERE id=e1.id;
 SELECT * INTO e2 FROM public.business_events WHERE id=e2.id;
 -- (SWF-261421 and SWF-261422 share a creation time, so compare as sets.)
 IF e1.attribution_status IS DISTINCT FROM 'pending_luna' OR NOT (e1.candidate_job_ids @> ARRAY[j21,j22,j3] AND cardinality(e1.candidate_job_ids)=3)
  OR e2.attribution_status IS DISTINCT FROM 'pending_luna' OR NOT (e2.candidate_job_ids @> ARRAY[j21,j22,j3] AND cardinality(e2.candidate_job_ids)=3)
 THEN RAISE EXCEPTION 'R17: the new job must reopen both once with all three, got % % / % %',e1.attribution_status,e1.candidate_job_ids,e2.attribution_status,e2.candidate_job_ids; END IF;
 IF e1.metadata->'placement_reconsidered'->>'from_status' IS DISTINCT FROM 'unplaced' OR e1.metadata->>'luna_outcome' IS DISTINCT FROM 'several' OR e1.metadata->>'capture_mode' IS DISTINCT FROM 'relink'
 THEN RAISE EXCEPTION 'R17: reopen from rest not recorded, got %',e1.metadata; END IF;
 -- The changed candidate list makes the ask allowed again.
 SELECT count(*) INTO n FROM public.context_attribution_due(200) WHERE id IN (e1.id,e2.id);
 IF n<>2 THEN RAISE EXCEPTION 'R17: reopened texts are not due for an ask (%)',n; END IF;
 -- Answered again as undecided, they rest; the same event never reopens them twice.
 e1:=public.attribute_context_event_with_luna(e1.id,NULL,NULL,'undecided');
 r:=public.context_reconsider_contact('r17-contact','2026-08-19Z','job_created',j3);
 SELECT * INTO e1 FROM public.business_events WHERE id=e1.id;
 IF e1.attribution_status IS DISTINCT FROM 'unplaced' OR (r->>'reopened')::int IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'R17: the same event reopened a text twice: % %',e1.attribution_status,r; END IF;
END $$;
ROLLBACK;

-- 4. R1: in review with two open quotes; a third quote job (the customer asked
-- for three) joins its candidates. It stays in review and stays live.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; j31 uuid:=gen_random_uuid(); j48 uuid:=gen_random_uuid(); j3 uuid:=gen_random_uuid();
 e public.business_events;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
 (j31,org,'quoted','fencing','SWF-261431','lYPee0K2DuQHXH2xHL1P','2026-09-17T02:00:00Z'),
 (j48,org,'quoted','fencing','SWF-261448','lYPee0K2DuQHXH2xHL1P','2026-09-21T02:00:00Z');
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"I haven''t received all three quotes as yet?","line":"fencing"}','lYPee0K2DuQHXH2xHL1P',
  'ghl:pffXnIL1v2FTaKnz4DHm','sms','inbound','2026-09-23T04:35:00Z') RETURNING * INTO e;
 IF e.attribution_status IS DISTINCT FROM 'pending_luna' OR e.candidate_job_ids IS DISTINCT FROM ARRAY[j31,j48] THEN RAISE EXCEPTION 'R1 fixture: review with both quotes'; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at)
 VALUES(j3,org,'quoted','fencing','P1B-R1-THIRD','lYPee0K2DuQHXH2xHL1P','2026-09-23T05:00:00Z');
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 IF e.attribution_status IS DISTINCT FROM 'pending_luna' OR e.job_id IS NOT NULL OR e.candidate_job_ids IS DISTINCT FROM ARRAY[j31,j48,j3]
 THEN RAISE EXCEPTION 'R1: third quote must join the stored candidates, got % %',e.attribution_status,e.candidate_job_ids; END IF;
 IF coalesce(e.metadata->>'capture_mode','live')<>'live' OR e.metadata->'placement_candidates_widened'->>'job_id' IS DISTINCT FROM j3::text
 THEN RAISE EXCEPTION 'R1: a widened review row must stay live and record the widening, got %',e.metadata; END IF;
END $$;
ROLLBACK;

-- 5. R8 and R15: the lead window, and a job insert that looks at nothing
-- outside it.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; inside uuid:=gen_random_uuid(); j09 uuid:=gen_random_uuid();
 e1 public.business_events; e2 public.business_events; e15 public.business_events; checked timestamptz;
BEGIN
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Any response?"}','cS6dKRalWMgthDS9mELw','ghl:uQQ42WwGWSnz0Ccvs5Go','sms','inbound','2026-09-21T10:46:00Z') RETURNING * INTO e1;
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Any response?"}','r8-late-contact','sms','inbound','2026-09-21T10:46:00Z') RETURNING * INTO e2;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
 (inside,org,'draft','fencing','R8-INSIDE-30D','cS6dKRalWMgthDS9mELw','2026-10-11T02:00:00Z'),
 (gen_random_uuid(),org,'draft','fencing','R8-OUTSIDE-30D','r8-late-contact','2026-10-25T02:00:00Z');
 SELECT * INTO e1 FROM public.business_events WHERE id=e1.id;
 SELECT * INTO e2 FROM public.business_events WHERE id=e2.id;
 IF e1.job_id IS DISTINCT FROM inside OR e1.attribution_status IS DISTINCT FROM 'single_open'
  OR coalesce(e1.metadata->>'capture_mode','live') IS DISTINCT FROM 'live' OR e1.metadata ? 'capture_mode_before'
 THEN RAISE EXCEPTION 'R8: a job 20 days later must take the lead text without a relink stamp, got % % %',e1.attribution_status,e1.job_id,e1.metadata; END IF;
 IF e2.job_id IS NOT NULL OR e2.attribution_status IS DISTINCT FROM 'admin_bucket' OR e2.metadata ? 'placement_reconsidered'
 THEN RAISE EXCEPTION 'R8: a job 34 days later touched the lead text'; END IF;
 -- R15 (X18): 3 Jul text, SWF-261209 created 14 Aug (window 15 Jul to 14 Aug).
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl_sms_cache_backfill','{"body":"About the shared fence with next door"}','r15-contact','ghl:vylm5LHmbChCfgZLawc2','sms','inbound','2026-07-03T02:00:00Z')
 RETURNING * INTO e15;
 checked:=e15.attribution_checked_at;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(j09,org,'quoted','fencing','SWF-261209','r15-contact','2026-08-14T02:00:00Z');
 SELECT * INTO e15 FROM public.business_events WHERE id=e15.id;
 IF e15.job_id IS NOT NULL OR e15.attribution_status IS DISTINCT FROM 'admin_bucket' OR e15.attribution_checked_at IS DISTINCT FROM checked
 THEN RAISE EXCEPTION 'R15: the 3 Jul text must stay before any job, untouched, got % % (checked % -> %)',e15.attribution_status,e15.job_id,checked,e15.attribution_checked_at; END IF;
END $$;
ROLLBACK;

-- 5b. Path (a) 90-day guard: a reviewed lead-window text stays live, so Luna
-- placing it on the new job wakes one extraction read.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; old uuid:=gen_random_uuid(); j uuid:=gen_random_uuid();
 e public.business_events;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at,completed_at)
 VALUES(old,org,'complete','fencing','P1B-GUARD-OLD','p1b-guard','2026-06-01Z','2026-07-15Z');
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Can you quote the side fence?"}','p1b-guard','ghl:p1b-guard-01aug','sms','inbound','2026-08-01Z')
 RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status IS DISTINCT FROM 'admin_bucket'
 THEN RAISE EXCEPTION '90-day guard fixture: text must start before any job, got % %',e.attribution_status,e.job_id; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at)
 VALUES(j,org,'quoted','fencing','P1B-GUARD-NEW','p1b-guard','2026-08-10Z');
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 IF e.job_id IS NOT NULL OR e.attribution_status IS DISTINCT FROM 'pending_luna' OR e.attribution_step IS DISTINCT FROM 5
  OR e.metadata->>'placement_rule' IS DISTINCT FROM 'review_recent_other_job'
  OR coalesce(e.metadata->>'capture_mode','live') IS DISTINCT FROM 'live' OR e.metadata ? 'capture_mode_before'
 THEN RAISE EXCEPTION '90-day guard: path (a) must send the text to review and keep live, got % % %',e.attribution_status,e.job_id,e.metadata; END IF;
 e:=public.attribute_context_event_with_luna(e.id,j,0.9,'job');
 IF e.job_id IS DISTINCT FROM j OR e.attribution_status IS DISTINCT FROM 'luna'
  OR coalesce(e.metadata->>'capture_mode','live') IS DISTINCT FROM 'live'
 THEN RAISE EXCEPTION '90-day guard: Luna must place the live text on the new job, got % % %',e.attribution_status,e.job_id,e.metadata; END IF;
 IF (public.context_job_cadence(j)->>'waking_count')::int IS DISTINCT FROM 1
 THEN RAISE EXCEPTION '90-day guard: the new job must wake on its reviewed lead-window text: %',public.context_job_cadence(j); END IF;
END $$;
ROLLBACK;

-- 6. Never moved: direct, thread, content_ref and party placements inside the window.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid();
 d public.business_events; t public.business_events; h public.business_events; pt public.business_events;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(a,org,'quoted','fencing','P1B-KEEP-A1','p1b-keep','2026-09-01Z');
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"About P1B-KEEP-A1, can you start Monday?"}','p1b-keep','ghl:p1b-keep-direct','sms','inbound','2026-09-05Z') RETURNING * INTO d;
 INSERT INTO public.event_threads(thread_key,job_id,bound_by) VALUES('outlook:p1b-keep-thread',a,'ladder');
 INSERT INTO public.business_events(source,payload,contact_id,thread_key,channel,direction,event_at)
 VALUES('monitor-inbox','{"body":"Re: the fence"}','p1b-keep','outlook:p1b-keep-thread','email','inbound','2026-09-06Z') RETURNING * INTO t;
 -- Content reference (P2) and party (P3) placements are not contact rules either.
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"I only see one price"}','p1b-keep','sms','inbound','2026-09-07Z') RETURNING * INTO h;
 UPDATE public.business_events SET job_id=a,attribution_status='content_ref',match_method='content_ref' WHERE id=h.id;
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"The neighbour here, about our side"}','p1b-keep','sms','inbound','2026-09-08Z') RETURNING * INTO pt;
 UPDATE public.business_events SET job_id=a,attribution_status='party',match_method='party' WHERE id=pt.id;
 IF d.attribution_status IS DISTINCT FROM 'direct' OR t.attribution_status IS DISTINCT FROM 'thread' THEN RAISE EXCEPTION 'keep fixture: got % %',d.attribution_status,t.attribution_status; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(b,org,'quoted','fencing','P1B-KEEP-B2','p1b-keep','2026-09-10Z');
 IF EXISTS(SELECT 1 FROM public.business_events WHERE id IN (d.id,t.id,h.id,pt.id) AND (job_id IS DISTINCT FROM a OR metadata ? 'placement_reconsidered'))
 THEN RAISE EXCEPTION 'keep: a direct, thread, content_ref or party placement was moved by a new job'; END IF;
END $$;
ROLLBACK;

-- 6b. Review findings: the window ends at the job's creation; a repeat call
-- never re-moves a row the ladder placed for this job event; a non-GHL email
-- placed on A by a contact rule reopens with A and B (rule 7); the eligibility
-- test refuses direct, thread and automated rows (it is applied again under
-- the lock).
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid();
 p uuid:=gen_random_uuid(); f uuid:=gen_random_uuid(); late public.business_events; sl public.business_events; em public.business_events; r jsonb;
BEGIN
 -- A job inserted with a backdated creation (5 Sep) after a 10 Sep text was
 -- placed on the only job then known: the 10 Sep text is after the new job's
 -- creation, outside its lead window, and stays.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(a,org,'quoted','fencing','P1B-LATE-A','p1b-late','2026-09-01Z');
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Any update?"}','p1b-late','ghl:p1b-late-10sep','sms','inbound','2026-09-10Z') RETURNING * INTO late;
 IF late.job_id IS DISTINCT FROM a THEN RAISE EXCEPTION 'late fixture: expected single_open on A'; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(b,org,'quoted','fencing','P1B-LATE-B','p1b-late','2026-09-05Z');
 SELECT * INTO late FROM public.business_events WHERE id=late.id;
 IF late.job_id IS DISTINCT FROM a OR late.attribution_status IS DISTINCT FROM 'single_open'
 THEN RAISE EXCEPTION 'window: a text after the new job''s creation was moved, got % %',late.attribution_status,late.job_id; END IF;

 -- Two jobs created together: the ladder places a fencing-line text on the
 -- fencing job by line; a repeat call for the patio job does not re-move it.
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Fence and patio please","line":"fencing"}','p1b-line','ghl:p1b-line-1sep','sms','inbound','2026-09-01Z') RETURNING * INTO sl;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
 (p,org,'quoted','patio','P1B-LINE-P','p1b-line','2026-09-05Z'),(f,org,'quoted','fencing','P1B-LINE-F','p1b-line','2026-09-05Z');
 SELECT * INTO sl FROM public.business_events WHERE id=sl.id;
 IF sl.job_id IS DISTINCT FROM f OR sl.attribution_status IS DISTINCT FROM 'single_line'
 THEN RAISE EXCEPTION 'line fixture: expected single_line on the fencing job, got % %',sl.attribution_status,sl.job_id; END IF;
 r:=public.context_reconsider_contact('p1b-line','2026-08-06Z','job_created',p);
 SELECT * INTO sl FROM public.business_events WHERE id=sl.id;
 IF sl.job_id IS DISTINCT FROM f OR (r->>'reopened')::int IS DISTINCT FROM 0
 THEN RAISE EXCEPTION 'once per event: a repeat call re-moved a row placed for the same job, got % %',sl.attribution_status,r; END IF;

 -- A non-GHL email placed single_open on A: rule 7 reopens with A and B.
 INSERT INTO public.business_events(source,payload,contact_id,thread_key,channel,direction,event_at)
 VALUES('monitor-inbox','{"body":"Re: fence quote"}','p1b-late','outlook:p1b-late-thread','email','inbound','2026-09-04Z') RETURNING * INTO em;
 UPDATE public.business_events SET job_id=a,attribution_status='single_open',attribution_step=3,match_method='contact_id',candidate_job_ids=NULL WHERE id=em.id;
 INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES('outlook:p1b-late-thread',a,'ladder',em.id);
 r:=public.context_reconsider_contact('p1b-late','2026-08-06Z','job_created',b);
 SELECT * INTO em FROM public.business_events WHERE id=em.id;
 IF em.job_id IS NOT NULL OR em.attribution_status IS DISTINCT FROM 'pending_luna' OR em.candidate_job_ids IS DISTINCT FROM ARRAY[a,b]
  OR em.metadata->>'capture_mode' IS DISTINCT FROM 'relink' OR (r->>'reopened')::int IS DISTINCT FROM 1 OR r ? 'kept_thread_bound'
 THEN RAISE EXCEPTION 'rule 7: a non-GHL email bound to A must reopen with A and B, got % % %',em.attribution_status,em.candidate_job_ids,r; END IF;

 -- The eligibility test itself (a clean single_open sibling, not the reopened row).
 em.job_id:=a; em.attribution_status:='single_open'; em.candidate_job_ids:=NULL; em.metadata:='{}'::jsonb;
 IF public.context_reconsider_eligible(ROW(em.*)::public.business_events,b) IS DISTINCT FROM true THEN RAISE EXCEPTION 'eligible: single_open row refused'; END IF;
 em.attribution_status:='direct'; IF public.context_reconsider_eligible(em,b) THEN RAISE EXCEPTION 'eligible: direct row accepted'; END IF;
 em.attribution_status:='thread'; IF public.context_reconsider_eligible(em,b) THEN RAISE EXCEPTION 'eligible: thread row accepted'; END IF;
 em.job_id:=NULL; em.attribution_status:='automated'; IF public.context_reconsider_eligible(em,b) THEN RAISE EXCEPTION 'eligible: automated row accepted'; END IF;
 em.attribution_status:='admin_bucket'; em.candidate_job_ids:=ARRAY[b]; IF public.context_reconsider_eligible(em,b) THEN RAISE EXCEPTION 'eligible: row already naming the job accepted'; END IF;
END $$;
ROLLBACK;

-- 7. Audit I9: a job with no customer reconsiders nothing (the old body re-ran
-- the whole bucket for every customer).
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; e public.business_events; checked timestamptz;
BEGIN
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Anyone there?"}','p1b-i9','sms','inbound',now()-interval '1 day') RETURNING * INTO e;
 checked:=e.attribution_checked_at;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(gen_random_uuid(),org,'processing','makesafe','P1B-I9-MAKESAFE',NULL,now());
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(gen_random_uuid(),org,'processing','makesafe','P1B-I9-BLANK','  ',now());
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 IF e.attribution_checked_at IS DISTINCT FROM checked OR e.attribution_status IS DISTINCT FROM 'admin_bucket'
 THEN RAISE EXCEPTION 'I9: a job with no customer re-ran another customer''s bucket (checked % -> %)',checked,e.attribution_checked_at; END IF;
END $$;
ROLLBACK;

-- 8. Attribution lane off: the job insert moves nothing, and the function says so.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; j uuid:=gen_random_uuid(); e public.business_events; r jsonb;
BEGIN
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Price for a colorbond fence?"}','p1b-lane','sms','inbound','2026-09-01Z') RETURNING * INTO e;
 UPDATE public.automation_switches SET attribution=false WHERE id=1;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(j,org,'quoted','fencing','P1B-LANE','p1b-lane','2026-09-05Z');
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 IF e.job_id IS NOT NULL OR e.attribution_status IS DISTINCT FROM 'admin_bucket' THEN RAISE EXCEPTION 'lane off: the job insert moved a text'; END IF;
 r:=public.context_reconsider_contact('p1b-lane','2026-08-06Z','job_created',j);
 IF r->>'outcome' IS DISTINCT FROM 'lane_off' THEN RAISE EXCEPTION 'lane off: outcome %',r; END IF;
 UPDATE public.automation_switches SET attribution=true WHERE id=1;
END $$;
ROLLBACK;

-- 9. A failing reconsideration never fails the job insert, and moves nothing.
BEGIN;
CREATE OR REPLACE FUNCTION public.context_contact_jobs_at(p_contact_id text,p_at timestamptz)
RETURNS TABLE(job_id uuid,job_number text,type text,status text,basis text,created_at timestamptz,terminal_at timestamptz,terminal_time_source text)
LANGUAGE plpgsql STABLE AS $$ BEGIN RAISE EXCEPTION 'planted failure'; END $$;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; j uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Quote please"}','p1b-fail','sms','inbound','2026-09-01Z') RETURNING * INTO e;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(j,org,'quoted','fencing','P1B-FAIL','p1b-fail','2026-09-05Z');
 IF NOT EXISTS(SELECT 1 FROM public.jobs WHERE id=j) THEN RAISE EXCEPTION 'failure: the job insert failed'; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 IF e.job_id IS NOT NULL OR e.attribution_status IS DISTINCT FROM 'admin_bucket' THEN RAISE EXCEPTION 'failure: a partial reconsideration moved a text'; END IF;
 BEGIN
  PERFORM public.context_reconsider_contact('p1b-fail','2026-08-06Z','party_linked',j);
  RAISE EXCEPTION 'failure: an unknown reason was accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT LIKE 'context_reconsider_contact: unknown reason%' THEN RAISE; END IF;
 END;
END $$;
ROLLBACK;

-- 10. Structure: nothing reachable by the public key or a signed-in login;
-- re-apply is a no-op.
DO $$
DECLARE f text; role_name text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_reconsider_contact(text,timestamptz,text,uuid)','public.context_job_created_reconsider()',
  'public.context_reconsider_eligible(public.business_events,uuid)'] LOOP
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF has_function_privilege(role_name,f,'EXECUTE') THEN RAISE EXCEPTION '% can execute %',role_name,f; END IF;
  END LOOP;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.context_reconsider_contact(text,timestamptz,text,uuid)','EXECUTE')
 THEN RAISE EXCEPTION 'service_role cannot execute context_reconsider_contact'; END IF;
 IF has_function_privilege('service_role','public.context_reconsider_eligible(public.business_events,uuid)','EXECUTE')
 THEN RAISE EXCEPTION 'service_role can call the private eligibility helper'; END IF;
 IF (SELECT prosecdef FROM pg_proc WHERE oid='public.context_reconsider_contact(text,timestamptz,text,uuid)'::regprocedure) IS NOT TRUE
  OR (SELECT proconfig FROM pg_proc WHERE oid='public.context_reconsider_contact(text,timestamptz,text,uuid)'::regprocedure) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
 THEN RAISE EXCEPTION 'context_reconsider_contact must be SECURITY DEFINER with a fixed search_path'; END IF;
END $$;
-- Re-apply is a no-op. P1b's guard reads P1a's ladder body, so the re-apply
-- runs only while that body is live; a later registered ladder slice (P4
-- 20260925050000) replaces it and P1b's own three functions stay unchanged.
SELECT md5(prosrc)='fe50f14f4ab28d4d6c9dbb70bc85e7df' AS p1a_ladder_live
FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure \gset
\if :p1a_ladder_live
CREATE TEMP TABLE p1b_before AS SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN ('context_reconsider_contact','context_job_created_reconsider','context_reconsider_eligible');
\ir ../../../migrations/20260924160000_context_reconsider_contact.sql
DO $$
BEGIN
 IF (SELECT count(*) FROM p1b_before)<>3 THEN RAISE EXCEPTION 'expected 3 P1b functions, got %',(SELECT count(*) FROM p1b_before); END IF;
 IF EXISTS(SELECT 1 FROM p1b_before b LEFT JOIN pg_proc p ON p.oid=b.sig::regprocedure WHERE md5(p.prosrc) IS DISTINCT FROM b.md5)
 THEN RAISE EXCEPTION 'P1b re-apply changed a body'; END IF;
END $$;
DROP TABLE p1b_before;
\else
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_reconsider_contact(text,timestamptz,text,uuid)'::regprocedure)<>'5f9dbe883f0add7a6987f3ed265a08af'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_reconsider_eligible(public.business_events,uuid)'::regprocedure)<>'375857877700389aa8f6f730095b8800'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_created_reconsider()'::regprocedure)<>'2e199e27d38730e95bd5f2b0b8a9b165'
 THEN RAISE EXCEPTION 'P1b: a later slice changed a P1b body'; END IF;
END $$;
\endif
