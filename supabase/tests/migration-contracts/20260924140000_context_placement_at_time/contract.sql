-- P1a behaviour contract, on recorded fixtures of the rows the design names
-- (sms.md section 10, read 23 Sep 2026 06:33Z; sites.md S3 / INTEGRATION X18).
-- Job numbers, GHL message ids and GHL contact ids are as recorded; where the
-- design gives no contact id the fixture uses a synthetic label. No customer
-- names. Times are the recorded message times; job creation and terminal times
-- are the ones the design states, or a stated stand-in where it gives none.
--   R1   pffXnIL1v2FTaKnz4DHm  two open fencing quotes: review, both stored.
--   R8   uQQ42WwGWSnz0Ccvs5Go  lead with no job: bucket; placed only by a job
--        created within 30 days.
--   R9   1TPog9f79izPytVu8yoo  one live patio job: single_open.
--   R13  EofbCakVE65xUwRRuFwz  "$5,478": never SWF-261448; review with both.
--   R14  XyDhsX5IZ9kaS2XxPEzr, oS67q2BCAyhbIl4SjihH  pre-job texts: bound to
--        SWF-261431 on its creation; SWF-261448's window covers them too.
--   R15  vylm5LHmbChCfgZLawc2  3 Jul, SWF-261209 created 14 Aug: before any job.
--   R16  dvd0WacrDfhFfQk98jaq, uPDDdn56J01igbTGJmta  contactless archived sibling
--        found by phone; Luna may choose it because the guard reads the list.
--   R17  K96MNiYqLzNhENhginhN  option quotes: review, both stored.
--   R18  GCMPdVbyRdUuvBIzrXSv, 9uyM8hkpScFvGqjU9gRN  patio then decking.
--   R19  9uRGnxCcBouK6cqJ7bXN  Luna places on SWF-26357 from the stored list.
--   R20  39a7gwM1oRR1UQ7mT8YT  wrong customer, two jobs on one contact: never single_open.
--   R21  tQwnmPdIxfgiUToFat34  contact on another client's job; own job contactless.
--   R22  3QZnsoxzr83qUqGjWcml  contactless sibling only when phone or email matches.
--   R24  shell duplicate SWP-26270 beside SWP-26180: review, not a guess.
--   Finding 5: a GHL conversation is never a job thread.
--   Rule 5: the 90-day guard; terminal time source order.
--   Complete-then-archive: dates from the completion, not the later archive.
--   updated_at stamp: only when that clock entered the candidate or guard set.
--   Rule F: a closed job's old texts stay on it; a new job's texts stay on it.

-- 1. R1 and R13: two open fencing quotes for one contact.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; j31 uuid:=gen_random_uuid(); j48 uuid:=gen_random_uuid();
 e public.business_events; n integer;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
 (j31,org,'quoted','fencing','SWF-261431','lYPee0K2DuQHXH2xHL1P','2026-09-17T02:00:00Z'),
 (j48,org,'quoted','fencing','SWF-261448','lYPee0K2DuQHXH2xHL1P','2026-09-21T02:00:00Z');
 -- R1: inbound on the fencing line, both quotes live.
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"I haven''t received all three quotes as yet?","line":"fencing"}','lYPee0K2DuQHXH2xHL1P',
  'ghl:pffXnIL1v2FTaKnz4DHm','sms','inbound','2026-09-23T04:35:00Z') RETURNING * INTO e;
 IF e.attribution_status<>'pending_luna' OR e.attribution_step<>5 OR e.job_id IS NOT NULL
  OR e.candidate_job_ids IS DISTINCT FROM ARRAY[j31,j48] OR e.metadata->>'placement_rule'<>'review_several'
 THEN RAISE EXCEPTION 'R1: must go to review with both quotes stored, got % % % %',e.attribution_status,e.job_id,e.candidate_job_ids,e.metadata; END IF;
 SELECT count(*) INTO n FROM public.context_unplaced_for_job(j31) WHERE id=e.id;
 IF n<>1 THEN RAISE EXCEPTION 'R1: missing from the SWF-261431 lane'; END IF;
 SELECT count(*) INTO n FROM public.context_unplaced_for_job(j48) WHERE id=e.id;
 IF n<>1 THEN RAISE EXCEPTION 'R1: missing from the SWF-261448 lane'; END IF;
 -- R13: step 1 falls through; both quotes are candidates; never placed on SWF-261448.
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"I only see one price of $5,478","line":"fencing"}','lYPee0K2DuQHXH2xHL1P',
  'ghl:EofbCakVE65xUwRRuFwz','sms','inbound','2026-09-21T03:51:00Z') RETURNING * INTO e;
 IF e.attribution_step=1 OR e.job_id IS NOT NULL OR e.attribution_status<>'pending_luna'
  OR e.candidate_job_ids IS DISTINCT FROM ARRAY[j31,j48]
 THEN RAISE EXCEPTION 'R13: must reach review with both quotes, got % step % job % %',e.attribution_status,e.attribution_step,e.job_id,e.candidate_job_ids; END IF;
END $$;
ROLLBACK;

-- 2. R14: pre-job lead texts. Bound to SWF-261431 on its creation (window
-- 18 Aug to 17 Sep); SWF-261448's window (22 Aug to 21 Sep) also covers them,
-- so the at-time candidate set names both. Reopening them is slice P1b.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; j31 uuid:=gen_random_uuid(); j48 uuid:=gen_random_uuid();
 e1 public.business_events; e2 public.business_events; ids uuid[];
BEGIN
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl_sms_cache_backfill','{"body":"Could you quote the side and back fence?"}','lYPee0K2DuQHXH2xHL1P','ghl:XyDhsX5IZ9kaS2XxPEzr','sms','inbound','2026-09-16T03:00:00Z')
 RETURNING * INTO e1;
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl_sms_cache_backfill','{"body":"And a separate price for the front"}','lYPee0K2DuQHXH2xHL1P','ghl:oS67q2BCAyhbIl4SjihH','sms','inbound','2026-09-16T03:05:00Z')
 RETURNING * INTO e2;
 IF e1.attribution_status<>'admin_bucket' OR e1.metadata->>'placement_rule'<>'no_candidate_at_time' OR e2.attribution_status<>'admin_bucket'
 THEN RAISE EXCEPTION 'R14: pre-job texts must wait before any job, got % %',e1.attribution_status,e1.metadata; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at)
 VALUES(j31,org,'quoted','fencing','SWF-261431','lYPee0K2DuQHXH2xHL1P','2026-09-17T02:00:00Z');
 SELECT * INTO e1 FROM public.business_events WHERE id=e1.id;
 SELECT * INTO e2 FROM public.business_events WHERE id=e2.id;
 IF e1.job_id IS DISTINCT FROM j31 OR e1.attribution_status<>'single_open' OR e2.job_id IS DISTINCT FROM j31
 THEN RAISE EXCEPTION 'R14: not bound to SWF-261431 on its creation, got % %',e1.attribution_status,e1.job_id; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at)
 VALUES(j48,org,'quoted','fencing','SWF-261448','lYPee0K2DuQHXH2xHL1P','2026-09-21T02:00:00Z');
 SELECT array_agg(job_id ORDER BY created_at) INTO ids FROM public.context_contact_jobs_at('lYPee0K2DuQHXH2xHL1P','2026-09-16T03:00:00Z');
 IF ids IS DISTINCT FROM ARRAY[j31,j48] THEN RAISE EXCEPTION 'R14: 16 Sep candidates must be both quotes, got %',ids; END IF;
 -- Outside both windows (40 days before the first): no candidate.
 IF EXISTS(SELECT 1 FROM public.context_contact_jobs_at('lYPee0K2DuQHXH2xHL1P','2026-08-08T00:00:00Z'))
 THEN RAISE EXCEPTION 'R14: a message 40 days before any job found a candidate'; END IF;
END $$;
ROLLBACK;

-- 3. R15 (INTEGRATION X18): a 3 Jul text about a neighbour's fence, with the
-- sender's own job SWF-261209 created 14 Aug. The window (15 Jul to 14 Aug) does
-- not cover 3 Jul: before any job, never on SWF-261209. Today's open-jobs rule
-- would have put it there (the existing wrong row).
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; j09 uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at)
 VALUES(j09,org,'quoted','fencing','SWF-261209','r15-contact','2026-08-14T02:00:00Z');
 IF NOT EXISTS(SELECT 1 FROM public.context_contact_jobs('r15-contact') WHERE id=j09) THEN RAISE EXCEPTION 'R15 fixture: open-jobs rule should name SWF-261209'; END IF;
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl_sms_cache_backfill','{"body":"About the shared fence with next door"}','r15-contact','ghl:vylm5LHmbChCfgZLawc2','sms','inbound','2026-07-03T02:00:00Z')
 RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'admin_bucket' OR e.metadata->>'placement_rule'<>'no_candidate_at_time'
 THEN RAISE EXCEPTION 'R15: 3 Jul text must stay before any job, got % %',e.attribution_status,e.job_id; END IF;
 -- The bucket re-run leaves it there too.
 PERFORM public.rerun_context_attribution(1000,'r15-contact');
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'admin_bucket' THEN RAISE EXCEPTION 'R15: re-run placed the 3 Jul text on %',e.job_id; END IF;
END $$;
ROLLBACK;

-- 4. R8: a lead with no job chasing "Any response?". Bucketed; placed only when
-- a job is created within 30 days of the message.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; inside uuid:=gen_random_uuid(); outside uuid:=gen_random_uuid();
 e1 public.business_events; e2 public.business_events;
BEGIN
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Any response?"}','cS6dKRalWMgthDS9mELw','ghl:uQQ42WwGWSnz0Ccvs5Go','sms','inbound','2026-09-21T10:46:00Z')
 RETURNING * INTO e1;
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Any response?"}','r8-late-contact','sms','inbound','2026-09-21T10:46:00Z')
 RETURNING * INTO e2;
 IF e1.attribution_status<>'admin_bucket' OR e2.attribution_status<>'admin_bucket' THEN RAISE EXCEPTION 'R8: lead text must wait in the bucket'; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
 (inside,org,'draft','fencing','R8-INSIDE-30D','cS6dKRalWMgthDS9mELw','2026-10-11T02:00:00Z'),
 (outside,org,'draft','fencing','R8-OUTSIDE-30D','r8-late-contact','2026-10-25T02:00:00Z');
 SELECT * INTO e1 FROM public.business_events WHERE id=e1.id;
 SELECT * INTO e2 FROM public.business_events WHERE id=e2.id;
 IF e1.job_id IS DISTINCT FROM inside OR e1.attribution_status<>'single_open' THEN RAISE EXCEPTION 'R8: a job 20 days later must take the lead text, got % %',e1.attribution_status,e1.job_id; END IF;
 IF e2.job_id IS NOT NULL OR e2.attribution_status<>'admin_bucket' THEN RAISE EXCEPTION 'R8: a job 34 days later took the lead text'; END IF;
END $$;
ROLLBACK;

-- 5. R9: one live patio job, text to 774: single_open. An older job finished
-- well outside 90 days does not trip the guard.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; j41 uuid:=gen_random_uuid(); old uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at,completed_at,updated_at) VALUES
 (old,org,'complete','fencing','R9-OLD-FENCE','Oxqi7eCx2rGCsS0BXOH2','2025-11-01Z','2026-01-10Z','2026-09-01Z'),
 (j41,org,'scheduled','patio','SWP-26941','Oxqi7eCx2rGCsS0BXOH2','2026-08-20Z',NULL,now());
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"are the guys coming today?","line":"patio"}','Oxqi7eCx2rGCsS0BXOH2','ghl:1TPog9f79izPytVu8yoo','sms','inbound','2026-09-22T23:08:00Z')
 RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM j41 OR e.attribution_status<>'single_open' OR e.attribution_step<>3 OR e.candidate_job_ids IS NOT NULL
  OR e.metadata->>'placement_rule'<>'single_open' OR e.payload ? 'terminal_time_source'
 THEN RAISE EXCEPTION 'R9: must be single_open on SWP-26941 (completed_at, not updated_at, dates the old job), got % % %',e.attribution_status,e.job_id,e.payload; END IF;
END $$;
ROLLBACK;

-- 6. R16: patio SWP-26184 on the contact; fence SWF-26178 archived with no
-- contact, same phone. (a) archived after the texts: both candidates, Luna may
-- choose the archived fence job. (b) archived three weeks before the texts: the
-- 90-day guard sends it to review with both listed. A job outside the list is refused.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; patio uuid:=gen_random_uuid(); fence uuid:=gen_random_uuid();
 e public.business_events; e2 public.business_events;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,client_phone,created_at,updated_at) VALUES
 (fence,org,'archived','fencing','SWF-26178',NULL,'0412 345 678','2026-02-10Z','2026-09-20Z'),
 (patio,org,'quoted','patio','SWP-26184','r16-contact','+61412345678','2026-03-01Z',now());
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,channel,direction,payload,event_at)
 VALUES('job.status_changed','app/office','job',fence::text,'status','internal','{"changes":{"status":{"from":"complete","to":"archived"}}}','2026-06-01Z');
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"About the shared fence on the side"}','r16-contact','ghl:dvd0WacrDfhFfQk98jaq','sms','inbound','2026-05-20Z')
 RETURNING * INTO e;
 IF e.attribution_status<>'pending_luna' OR e.candidate_job_ids IS DISTINCT FROM ARRAY[fence,patio]
  OR e.metadata->'placement_contactless_job_ids'<>jsonb_build_array(fence) OR e.metadata->>'placement_rule'<>'review_several'
 THEN RAISE EXCEPTION 'R16a: contactless sibling must join as a candidate, got % % %',e.attribution_status,e.candidate_job_ids,e.metadata; END IF;
 BEGIN
  PERFORM public.attribute_context_event_with_luna(e.id,gen_random_uuid(),0.95,'job');
  RAISE EXCEPTION 'R16a: a job outside the stored list was accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'job is not a contact candidate' THEN RAISE; END IF; END;
 e:=public.attribute_context_event_with_luna(e.id,fence,0.9,'job');
 IF e.job_id IS DISTINCT FROM fence OR e.attribution_status<>'luna' THEN RAISE EXCEPTION 'R16a: Luna could not choose the archived fence job'; END IF;
 -- (b) texts three weeks after the fence job was archived.
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"The shared fence panel is loose"}','r16-contact','ghl:uPDDdn56J01igbTGJmta','sms','inbound','2026-06-22Z')
 RETURNING * INTO e2;
 IF e2.attribution_status<>'pending_luna' OR e2.metadata->>'placement_rule'<>'review_recent_other_job'
  OR e2.candidate_job_ids IS DISTINCT FROM ARRAY[patio,fence] OR e2.metadata->'placement_guard_job_ids'<>jsonb_build_array(fence)
  OR e2.payload ? 'terminal_time_source'
 THEN RAISE EXCEPTION 'R16b: the 90-day guard must list the archived fence job, got % % %',e2.attribution_status,e2.candidate_job_ids,e2.metadata; END IF;
 e2:=public.attribute_context_event_with_luna(e2.id,fence,0.85,'job');
 IF e2.job_id IS DISTINCT FROM fence THEN RAISE EXCEPTION 'R16b: guard job not choosable'; END IF;
END $$;
ROLLBACK;

-- 7. R17, R19, R24: several live candidates go to review with all stored; the
-- Luna pick is checked against that list.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; j21 uuid:=gen_random_uuid(); j22 uuid:=gen_random_uuid();
 j56 uuid:=gen_random_uuid(); j57 uuid:=gen_random_uuid(); shell uuid:=gen_random_uuid(); live uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
 (j21,org,'quoted','fencing','SWF-261421','r17-contact','2026-09-10Z'),(j22,org,'quoted','fencing','SWF-261422','r17-contact','2026-09-10T00:01:00Z'),
 (j56,org,'quoted','fencing','SWF-26356','r19-contact','2026-05-01Z'),(j57,org,'quoted','fencing','SWF-26357','r19-contact','2026-05-02Z'),
 (live,org,'accepted','patio','SWP-26180','r24-contact','2026-04-01Z'),(shell,org,'draft','patio','SWP-26270','r24-contact','2026-06-01Z');
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Confirms receipt of both quote emails","line":"fencing"}','r17-contact','ghl:K96MNiYqLzNhENhginhN','sms','inbound','2026-09-15T02:00:00Z')
 RETURNING * INTO e;
 IF e.attribution_status<>'pending_luna' OR e.candidate_job_ids IS DISTINCT FROM ARRAY[j21,j22] THEN RAISE EXCEPTION 'R17: both option quotes must be stored, got %',e.candidate_job_ids; END IF;
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"fencing only, no asbestos removal","line":"fencing"}','r19-contact','ghl:9uRGnxCcBouK6cqJ7bXN','sms','inbound','2026-05-26Z')
 RETURNING * INTO e;
 IF e.attribution_status<>'pending_luna' OR e.candidate_job_ids IS DISTINCT FROM ARRAY[j56,j57] THEN RAISE EXCEPTION 'R19: both jobs must be stored, got %',e.candidate_job_ids; END IF;
 e:=public.attribute_context_event_with_luna(e.id,j57,0.9,'job');
 IF e.job_id IS DISTINCT FROM j57 OR e.attribution_status<>'luna' THEN RAISE EXCEPTION 'R19: Luna pick of SWF-26357 refused'; END IF;
 -- R24: a draft shell beside a live job for one client. The booking-lane draft
 -- rule keeps the live job the only candidate, so the text is not guessed onto the shell.
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"When is the patio going up?","line":"patio"}','r24-contact','sms','inbound','2026-07-01Z') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM live OR e.attribution_status<>'single_open' THEN RAISE EXCEPTION 'R24 (draft shell): must stay on the live job, got % %',e.attribution_status,e.job_id; END IF;
 -- R24 as recorded (the shell is a scoped job too): both are candidates, review.
 UPDATE public.jobs SET status='quoted' WHERE id=shell;
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"When is the patio going up?","line":"patio"}','r24-contact','sms','inbound','2026-07-02Z') RETURNING * INTO e;
 IF e.attribution_status<>'pending_luna' OR e.candidate_job_ids IS DISTINCT FROM ARRAY[live,shell] THEN RAISE EXCEPTION 'R24: shell duplicate must go to review, got % %',e.attribution_status,e.candidate_job_ids; END IF;
END $$;
ROLLBACK;

-- 8. R18: patio estimate question before SWP-26056 exists; decking promise on
-- 7 Apr while SWP-26056 is the only job; SWD-26071 created 11 Apr (window
-- 12 Mar to 11 Apr) makes both candidates for 7 Apr. Reopening is slice P1b.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; p uuid:=gen_random_uuid(); d uuid:=gen_random_uuid();
 e1 public.business_events; e2 public.business_events; ids uuid[];
BEGIN
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Roughly what would a patio estimate be?"}','r18-contact','ghl:GCMPdVbyRdUuvBIzrXSv','sms','inbound','2026-04-02Z') RETURNING * INTO e1;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(p,org,'quoted','patio','SWP-26056','r18-contact','2026-04-03Z');
 SELECT * INTO e1 FROM public.business_events WHERE id=e1.id;
 IF e1.job_id IS DISTINCT FROM p OR e1.attribution_status<>'single_open' THEN RAISE EXCEPTION 'R18: first text not bound to SWP-26056 on its creation'; END IF;
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Thanks for the decking promise"}','r18-contact','ghl:9uyM8hkpScFvGqjU9gRN','sms','inbound','2026-04-07Z') RETURNING * INTO e2;
 IF e2.job_id IS DISTINCT FROM p OR e2.attribution_status<>'single_open' THEN RAISE EXCEPTION 'R18: 7 Apr text must link to the only candidate SWP-26056'; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(d,org,'quoted','decking','SWD-26071','r18-contact','2026-04-11Z');
 SELECT array_agg(job_id ORDER BY created_at) INTO ids FROM public.context_contact_jobs_at('r18-contact','2026-04-07Z');
 IF ids IS DISTINCT FROM ARRAY[p,d] THEN RAISE EXCEPTION 'R18: 7 Apr candidates must be SWP-26056 and SWD-26071, got %',ids; END IF;
 SELECT array_agg(job_id) INTO ids FROM public.context_contact_jobs_at('r18-contact','2026-02-20Z');
 IF ids IS NOT NULL THEN RAISE EXCEPTION 'R18: 20 Feb is outside both windows, got %',ids; END IF;
END $$;
ROLLBACK;

-- 9. Wrong-customer rows R20, R21, R22.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; j59 uuid:=gen_random_uuid(); j60 uuid:=gen_random_uuid();
 j67 uuid:=gen_random_uuid(); j68 uuid:=gen_random_uuid(); j78 uuid:=gen_random_uuid(); j99 uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 -- R20: the quote for another client sent to Greg's contact; two jobs on one contact.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
 (j59,org,'quoted','fencing','SWF-261459','5BFz2c6oUIgZuCSyKhFM','2026-09-20Z'),(j60,org,'quoted','fencing','SWF-261460','5BFz2c6oUIgZuCSyKhFM','2026-09-20T01:00:00Z');
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-proxy','{"body":"Please find your fencing quote attached","line":"fencing"}','5BFz2c6oUIgZuCSyKhFM','ghl:39a7gwM1oRR1UQ7mT8YT','sms','outbound','2026-09-21Z') RETURNING * INTO e;
 IF e.attribution_status IN ('single_open','single_line') OR e.job_id IS NOT NULL OR e.candidate_job_ids IS DISTINCT FROM ARRAY[j59,j60]
 THEN RAISE EXCEPTION 'R20: wrong-customer text must go to review, got % %',e.attribution_status,e.job_id; END IF;
 -- R21: Chris's contact sits on another client's job SWF-26167; Chris's own job
 -- SWF-26168 has no contact but carries his phone, known on his contact.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,client_phone,created_at) VALUES
 (j67,org,'quoted','fencing','SWF-26167','TZ8YSOsYK6et7nCbviSs','0400 111 222','2026-07-01Z'),
 (j68,org,'quoted','fencing','SWF-26168',NULL,'0400 333 444','2026-07-02Z');
 INSERT INTO public.contact_matches(job_id,ghl_contact_id,phone) VALUES(j67,'TZ8YSOsYK6et7nCbviSs','+61 400 333 444');
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Is my fence still booked for next week?","line":"fencing"}','TZ8YSOsYK6et7nCbviSs','sms','inbound','2026-07-27Z') RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'pending_luna' OR NOT (j68=ANY(e.candidate_job_ids))
  OR e.metadata->'placement_contactless_job_ids'<>jsonb_build_array(j68)
 THEN RAISE EXCEPTION 'R21: must go to review with SWF-26168, never single_open on SWF-26167, got % % %',e.attribution_status,e.job_id,e.candidate_job_ids; END IF;
 -- R22: builder contact on SWF-26378; SWF-261099 has no contact. Only a phone or
 -- email match makes SWF-261099 a candidate.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,client_email,created_at) VALUES
 (j78,org,'accepted','fencing','SWF-26378','r22-builder','orders@builder.example','2026-05-01Z'),
 (j99,org,'quoted','fencing','SWF-261099',NULL,'someone.else@example.com','2026-08-01Z');
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Update on the Smith St job please"}','r22-builder','ghl:3QZnsoxzr83qUqGjWcml','sms','inbound','2026-08-20Z') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM j78 OR e.attribution_status<>'single_open' OR e.metadata ? 'placement_contactless_job_ids'
 THEN RAISE EXCEPTION 'R22: no match must stay on SWF-26378 by the contact rule, got % %',e.attribution_status,e.job_id; END IF;
 UPDATE public.jobs SET client_email=' Orders@Builder.example ' WHERE id=j99;
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Update on the Smith St job please"}','r22-builder','sms','inbound','2026-08-21Z') RETURNING * INTO e;
 IF e.attribution_status<>'pending_luna' OR e.candidate_job_ids IS DISTINCT FROM ARRAY[j78,j99]
 THEN RAISE EXCEPTION 'R22: an email match must make SWF-261099 a candidate, got % %',e.attribution_status,e.candidate_job_ids; END IF;
 -- A placeholder phone never matches.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,client_phone,created_at) VALUES
 (gen_random_uuid(),org,'quoted','patio','P1A-PLACEHOLDER-A','p1a-placeholder','0000000000','2026-01-01Z'),
 (gen_random_uuid(),org,'quoted','patio','P1A-PLACEHOLDER-B',NULL,'0000000000','2026-01-01Z');
 IF (SELECT count(*) FROM public.context_contact_jobs_at('p1a-placeholder','2026-02-01Z'))<>1 THEN RAISE EXCEPTION 'placeholder phone matched a contactless job'; END IF;
END $$;
ROLLBACK;

-- 10. Finding 5: a GHL conversation is never a job thread. A bound GHL key does
-- not pin the text, and no GHL key is ever bound, by the ladder or by Luna.
-- Non-GHL threads (email group posts) keep working.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; old uuid:=gen_random_uuid(); cur uuid:=gen_random_uuid(); a uuid:=gen_random_uuid();
 e public.business_events; n integer;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at,updated_at) VALUES
 (old,org,'cancelled','fencing','P1A-THREAD-OLD','p1a-thread','2025-01-01Z','2025-02-01Z'),
 (cur,org,'quoted','fencing','P1A-THREAD-NEW','p1a-thread','2026-09-01Z',now()),
 (a,org,'quoted','patio','P1A-THREAD-A','p1a-thread-2','2026-09-01Z',now()),
 (gen_random_uuid(),org,'quoted','patio','P1A-THREAD-B','p1a-thread-2','2026-09-01Z',now());
 INSERT INTO public.event_threads(thread_key,job_id,bound_by) VALUES('I98nlO8dKPOAaylh7k23',old,'ladder');
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,thread_key,channel,direction,event_at)
 VALUES('ghl_webhook','{"body":"Any update?"}','p1a-thread','ghl:p1a-thread-1','I98nlO8dKPOAaylh7k23','sms','inbound','2026-09-10Z') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM cur OR e.attribution_status<>'single_open' THEN RAISE EXCEPTION 'GHL key pinned the text to its first job, got % %',e.attribution_status,e.job_id; END IF;
 INSERT INTO public.business_events(source,payload,contact_id,thread_key,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Another"}','p1a-thread','fresh-ghl-conversation','sms','inbound','2026-09-11Z');
 SELECT count(*) INTO n FROM public.event_threads WHERE thread_key='fresh-ghl-conversation';
 IF n<>0 THEN RAISE EXCEPTION 'the ladder bound a GHL conversation'; END IF;
 INSERT INTO public.business_events(source,payload,contact_id,thread_key,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Which one?"}','p1a-thread-2','luna-ghl-conversation','sms','inbound','2026-09-11Z') RETURNING * INTO e;
 e:=public.attribute_context_event_with_luna(e.id,a,0.9,'job');
 SELECT count(*) INTO n FROM public.event_threads WHERE thread_key='luna-ghl-conversation';
 IF n<>0 OR e.attribution_status<>'luna' THEN RAISE EXCEPTION 'Luna bound a GHL conversation'; END IF;
 INSERT INTO public.business_events(source,payload,contact_id,thread_key,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Which one again?"}','p1a-thread-2','legacy-ghl-conversation','sms','inbound','2026-09-12Z') RETURNING * INTO e;
 e:=public.attribute_context_event_with_luna(e.id,a,0.9);
 SELECT count(*) INTO n FROM public.event_threads WHERE thread_key='legacy-ghl-conversation';
 IF n<>0 OR e.attribution_status<>'luna' THEN RAISE EXCEPTION 'legacy Luna call bound a GHL conversation'; END IF;
 -- Control: a group-post thread still follows its binding.
 INSERT INTO public.event_threads(thread_key,job_id,bound_by) VALUES('outlook-group-thread-1',a,'ladder');
 INSERT INTO public.business_events(source,payload,thread_key,channel,direction) VALUES('monitor-inbox','{"body":"Council reply"}','outlook-group-thread-1','email','inbound') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM a OR e.attribution_status<>'thread' THEN RAISE EXCEPTION 'non-GHL thread lost, got %',e.attribution_status; END IF;
END $$;
ROLLBACK;

-- 11. Rule 5 guard and terminal time (rule 1, Review S3), and rule F.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; lost40 uuid:=gen_random_uuid(); live1 uuid:=gen_random_uuid();
 lost120 uuid:=gen_random_uuid(); live2 uuid:=gen_random_uuid(); arch uuid:=gen_random_uuid(); live3 uuid:=gen_random_uuid();
 fin uuid:=gen_random_uuid(); nxt uuid:=gen_random_uuid(); held uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 -- A quote lost 40 days before the message: guard trips, both listed.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at,updated_at) VALUES
 (lost40,org,'lost','fencing','P1A-LOST-40','p1a-guard','2026-06-01Z','2026-09-01Z'),(live1,org,'quoted','patio','P1A-LIVE-1','p1a-guard','2026-08-15Z',now());
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,channel,direction,payload,event_at)
 VALUES('job.status_changed','app/office','job',lost40::text,'status','internal','{"changes":{"status":{"from":"quoted","to":"lost"}}}','2026-08-11Z');
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at) VALUES('ghl-webhook-receiver','{"body":"Can you call me?"}','p1a-guard','sms','inbound','2026-09-20Z') RETURNING * INTO e;
 IF e.attribution_status<>'pending_luna' OR e.metadata->>'placement_rule'<>'review_recent_other_job' OR e.candidate_job_ids IS DISTINCT FROM ARRAY[live1,lost40]
 THEN RAISE EXCEPTION 'guard: a job lost 40 days earlier must send it to review, got % % %',e.attribution_status,e.candidate_job_ids,e.metadata; END IF;
 -- Lost 120 days before (status evidence, even though updated_at is recent): no guard.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at,updated_at) VALUES
 (lost120,org,'lost','fencing','P1A-LOST-120','p1a-guard-old','2026-03-01Z','2026-09-15Z'),(live2,org,'quoted','patio','P1A-LIVE-2','p1a-guard-old','2026-08-15Z',now());
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,channel,direction,payload,occurred_at)
 VALUES('job.status_changed','send-quote/decline','job',lost120::text,'status','internal','{"changes":{"status":{"from":"quoted","to":"lost"}}}','2026-05-20Z');
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at) VALUES('ghl-webhook-receiver','{"body":"Can you call me?"}','p1a-guard-old','sms','inbound','2026-09-20Z') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM live2 OR e.attribution_status<>'single_open' OR e.payload ? 'terminal_time_source'
 THEN RAISE EXCEPTION 'guard: status evidence must date the lost job, got % %',e.attribution_status,e.payload; END IF;
 -- Archived with no status evidence and no completed_at: updated_at dates it,
 -- and the row records that it did.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at,updated_at,archived) VALUES
 (arch,org,'quoted','fencing','P1A-ARCH-FLAG','p1a-guard-upd','2026-01-01Z','2026-09-10Z',true),(live3,org,'quoted','patio','P1A-LIVE-3','p1a-guard-upd','2026-08-15Z',now(),NULL);
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at) VALUES('ghl-webhook-receiver','{"body":"Can you call me?"}','p1a-guard-upd','sms','inbound','2026-09-20Z') RETURNING * INTO e;
 IF e.attribution_status<>'pending_luna' OR e.candidate_job_ids IS DISTINCT FROM ARRAY[live3,arch] OR e.payload->>'terminal_time_source'<>'updated_at'
 THEN RAISE EXCEPTION 'guard: archived flag dated by updated_at must be recorded, got % % %',e.attribution_status,e.candidate_job_ids,e.payload; END IF;
 -- Rule F: a job finished in January, a new job this month. An old text loaded
 -- today stays on the finished job; a text today stays on the new job.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at,completed_at,updated_at) VALUES
 (fin,org,'complete','fencing','P1A-FIN','p1a-rulef','2025-09-01Z','2026-01-15Z',now()),(nxt,org,'quoted','fencing','P1A-NEXT','p1a-rulef','2026-09-10Z',NULL,now());
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at) VALUES('ghl_sms_cache_backfill','{"body":"Gate latch sticks"}','p1a-rulef','sms','inbound','2025-12-01Z') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM fin OR e.attribution_status<>'single_open' THEN RAISE EXCEPTION 'rule F: an old text went to the new job, got % %',e.attribution_status,e.job_id; END IF;
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at) VALUES('ghl-webhook-receiver','{"body":"Quote looks good"}','p1a-rulef','sms','inbound','2026-09-20Z') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM nxt OR e.attribution_status<>'single_open' THEN RAISE EXCEPTION 'rule F: today''s text left the new job, got % %',e.attribution_status,e.job_id; END IF;
 -- A holding job is never a candidate.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at,metadata) VALUES
 (held,org,'archived','fencing','P1A-HOLDING','p1a-holding','2026-01-01Z','{"do_not_schedule":true}');
 IF EXISTS(SELECT 1 FROM public.context_contact_job_timeline('p1a-holding','2025-12-01Z')) THEN RAISE EXCEPTION 'holding job listed'; END IF;
END $$;
ROLLBACK;

-- 11b. Complete 1 Jun (status event) then archived 15 Jun (status event): an
-- 8 Jun text does not bind. A May text still does (the job was live then).
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; cta uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at,completed_at,updated_at,archived) VALUES
 (cta,org,'archived','fencing','P1A-CTA','p1a-complete-then-archive','2026-03-01Z','2026-06-01Z','2026-06-15Z',true);
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,channel,direction,payload,event_at) VALUES
 ('job.status_changed','app/office','job',cta::text,'status','internal','{"changes":{"status":{"from":"quoted","to":"complete"}}}','2026-06-01Z'),
 ('job.status_changed','app/office','job',cta::text,'status','internal','{"changes":{"status":{"from":"complete","to":"archived"}}}','2026-06-15Z');
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"When is the crew finishing the gate?"}','p1a-complete-then-archive','sms','inbound','2026-05-20Z') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM cta OR e.attribution_status<>'single_open'
 THEN RAISE EXCEPTION 'complete-then-archive: a May text must bind while the job is live, got % %',e.attribution_status,e.job_id; END IF;
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Is the crew still coming this week?"}','p1a-complete-then-archive','sms','inbound','2026-06-08Z') RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'admin_bucket' OR e.metadata->>'placement_rule'<>'no_candidate_at_time'
 THEN RAISE EXCEPTION 'complete-then-archive: an 8 Jun text must not bind after the 1 Jun completion, got % % %',e.attribution_status,e.job_id,e.metadata; END IF;
 IF EXISTS(SELECT 1 FROM public.context_contact_jobs_at('p1a-complete-then-archive','2026-06-08Z'))
 THEN RAISE EXCEPTION 'complete-then-archive: 8 Jun still listed the finished job as a candidate'; END IF;
END $$;
ROLLBACK;

-- 11c. An old cancelled job dated only by updated_at, outside the 90-day
-- window and not a candidate, leaves the live single_open row unstamped.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; old_upd uuid:=gen_random_uuid(); live4 uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at,updated_at) VALUES
 (old_upd,org,'cancelled','fencing','P1A-OLD-UPD','p1a-old-updated','2025-11-01Z','2026-05-01Z'),
 (live4,org,'quoted','patio','P1A-LIVE-4','p1a-old-updated','2026-08-15Z',now());
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at)
 VALUES('ghl-webhook-receiver','{"body":"Can you call me?"}','p1a-old-updated','sms','inbound','2026-09-20Z') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM live4 OR e.attribution_status<>'single_open' OR e.payload ? 'terminal_time_source'
 THEN RAISE EXCEPTION 'updated_at stamp: an old cancelled job outside 90 days must leave single_open unstamped, got % % %',e.attribution_status,e.job_id,e.payload; END IF;
END $$;
ROLLBACK;

-- 12. Luna guard for rows sent to review before P1a (no stored list): the
-- at-time set at the row's own time is the list.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; ja uuid:=gen_random_uuid(); jb uuid:=gen_random_uuid(); later uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
 (ja,org,'quoted','fencing','P1A-LEG-A','p1a-legacy','2026-01-01Z'),(jb,org,'quoted','fencing','P1A-LEG-B','p1a-legacy','2026-01-02Z'),
 (later,org,'quoted','fencing','P1A-LEG-LATER','p1a-legacy','2026-09-01Z');
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at) VALUES('ghl-webhook-receiver','{"body":"Which one is cheaper?"}','p1a-legacy','sms','inbound','2026-02-01Z') RETURNING * INTO e;
 UPDATE public.business_events SET candidate_job_ids=NULL WHERE id=e.id;
 BEGIN
  PERFORM public.attribute_context_event_with_luna(e.id,later,0.95,'job');
  RAISE EXCEPTION 'legacy row: a job created seven months later was accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'job is not a contact candidate' THEN RAISE; END IF; END;
 e:=public.attribute_context_event_with_luna(e.id,jb,0.95);
 IF e.job_id IS DISTINCT FROM jb THEN RAISE EXCEPTION 'legacy row: at-time candidate refused'; END IF;
END $$;
ROLLBACK;

-- 13. The bucket re-run stores the candidate list with the rest of the row:
-- two jobs created together turn a waiting lead text into a review case.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; ja uuid:=gen_random_uuid(); jb uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 INSERT INTO public.business_events(source,payload,contact_id,channel,direction,event_at) VALUES('ghl-webhook-receiver','{"body":"Two quotes please"}','p1a-rerun','sms','inbound','2026-09-01Z') RETURNING * INTO e;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
 (ja,org,'draft','fencing','P1A-RERUN-A','p1a-rerun','2026-09-05Z'),(jb,org,'draft','patio','P1A-RERUN-B','p1a-rerun','2026-09-05Z');
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 IF e.attribution_status<>'pending_luna' OR NOT (e.candidate_job_ids @> ARRAY[ja,jb] AND cardinality(e.candidate_job_ids)=2)
  OR e.metadata->>'placement_rule'<>'review_several'
 THEN RAISE EXCEPTION 're-run: candidate list not stored, got % %',e.attribution_status,e.candidate_job_ids; END IF;
END $$;
ROLLBACK;

-- 13b. L1b's re-run line (audit H1, sms/adminbucket N15 shape): a contactless
-- job insert re-runs the bucket for every contact. It must never strip the job
-- from an unrelated row that holds one with no status (a legacy row), while a
-- bucketed row of that contact is still reconsidered.
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; held uuid:=gen_random_uuid(); legacy uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(held,org,'quoted','fencing','P1A-H1-HELD','p1a-h1','2026-01-01Z');
 INSERT INTO public.business_events(payload,contact_id,channel,direction,event_at) VALUES('{"body":"Legacy text on its job"}','p1a-h1','sms','inbound','2026-02-01Z') RETURNING id INTO legacy;
 -- A legacy row: job held, no ladder stamp (as rows written before the ladder).
 UPDATE public.business_events SET job_id=held,attribution_status=NULL,match_method=NULL WHERE id=legacy;
 -- A make-safe job created with no contact (N15: SWMS-261464 shape).
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES(gen_random_uuid(),org,'processing','makesafe','P1A-H1-MAKESAFE',NULL,now());
 SELECT * INTO e FROM public.business_events WHERE id=legacy;
 IF e.job_id IS DISTINCT FROM held OR e.attribution_status IS NOT NULL
 THEN RAISE EXCEPTION 'H1: a contactless job insert stripped an unrelated row''s job (now % %)',e.job_id,e.attribution_status; END IF;
 IF public.rerun_context_attribution(1000,'p1a-h1')<>0 THEN RAISE EXCEPTION 'H1: the re-run selected a row that holds a job'; END IF;
END $$;
ROLLBACK;

-- 14. Structure: nothing reachable by the public key or a signed-in login; the
-- timeline is private; re-apply is a no-op.
DO $$
DECLARE f text; role_name text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_event_is_ghl(public.business_events)','public.context_contact_job_timeline(text,timestamptz)',
  'public.context_contact_jobs_at(text,timestamptz)','public.resolve_context_attribution(public.business_events)',
  'public.rerun_context_attribution(integer,text)','public.attribute_context_event_with_luna(uuid,uuid,numeric)',
  'public.attribute_context_event_with_luna(uuid,uuid,numeric,text)'] LOOP
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF has_function_privilege(role_name,f,'EXECUTE') THEN RAISE EXCEPTION '% can execute %',role_name,f; END IF;
  END LOOP;
 END LOOP;
 IF has_function_privilege('service_role','public.context_contact_job_timeline(text,timestamptz)','EXECUTE') THEN RAISE EXCEPTION 'service_role can call the private timeline'; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_contact_jobs_at(text,timestamptz)','public.context_event_is_ghl(public.business_events)',
  'public.rerun_context_attribution(integer,text)','public.attribute_context_event_with_luna(uuid,uuid,numeric)',
  'public.attribute_context_event_with_luna(uuid,uuid,numeric,text)'] LOOP
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %',f; END IF;
 END LOOP;
END $$;
CREATE TEMP TABLE p1a_before AS SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN ('resolve_context_attribution','rerun_context_attribution','attribute_context_event_with_luna',
  'context_event_is_ghl','context_contact_job_timeline','context_contact_jobs_at');
\ir ../../../migrations/20260924140000_context_placement_at_time.sql
DO $$
BEGIN
 IF (SELECT count(*) FROM p1a_before)<>7 THEN RAISE EXCEPTION 'expected 7 P1a functions, got %',(SELECT count(*) FROM p1a_before); END IF;
 IF EXISTS(SELECT 1 FROM p1a_before b LEFT JOIN pg_proc p ON p.oid=b.sig::regprocedure WHERE md5(p.prosrc) IS DISTINCT FROM b.md5)
 THEN RAISE EXCEPTION 'P1a re-apply changed a body'; END IF;
END $$;
DROP TABLE p1a_before;
