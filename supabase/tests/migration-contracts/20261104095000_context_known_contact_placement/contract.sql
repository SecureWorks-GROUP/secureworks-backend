-- C2 known contacts contract (20261104095000). Every fixture write is rolled
-- back. Ids, job numbers, contacts and text are synthetic.
--
-- The rules (rules on, through the real insert trigger):
--   A. A customer message with no words from a contact with exactly one real
--      job at the message time goes on that job and stays empty
--      (empty_single_open); several jobs, a finished job beside the one, a
--      numberless job and no job at all are set aside with a named rule,
--      never guessed.
--   B. Our own tool's copy of a text (source mcp_agent, recipient only in
--      payload.to_contact_id, words only in payload.message_preview) follows
--      its twin: onto the twin's job, or into the bucket with the twin's
--      not-about-a-job reason (twin_copy, placement_copy_of).
--   C. A worded message, a crew text and a non-customer row are decided as
--      before; with the rules off nothing changes.
--   D. The hand run (context_redecide_one, context_redecide_resting 'empty')
--      and P1b (a new job) decide stored empty rows again.
--   E. Structure: md5s, comments, grants, rules-off ladder untouched, re-apply
--      a no-op.
\set ON_ERROR_STOP 1

CREATE FUNCTION pg_temp.c2k_flag(p_on boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE public.feature_flags SET enabled=p_on,updated_at=clock_timestamp() WHERE flag_name='context_unlinked_rules_v1';
 IF public.context_unlinked_rules_enabled() IS DISTINCT FROM p_on THEN RAISE EXCEPTION 'c2k fixture: rules flag not %',p_on; END IF;
END $$;

CREATE FUNCTION pg_temp.c2k_job(p_number text,p_contact text,p_status text,p_created timestamptz,p_completed timestamptz DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,job_number,status,type,ghl_contact_id,site_address,created_at,completed_at,metadata)
 VALUES(v,'00000000-0000-0000-0000-000000000001',p_number,p_status,'fencing',p_contact,'7 Wattle Street, Yokine WA 6060',p_created,p_completed,'{}');
 RETURN v;
END $$;

CREATE FUNCTION pg_temp.c2k_call(p_contact text,p_at timestamptz,p_type text DEFAULT 'client.call_complete') RETURNS public.business_events
LANGUAGE plpgsql AS $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,contact_id,payload)
 VALUES(p_type,'ghl-webhook-receiver','call','inbound',p_at,p_at,p_contact,'{"status":"completed"}') RETURNING * INTO e;
 RETURN e;
END $$;

CREATE FUNCTION pg_temp.c2k_expect(p_label text,e public.business_events,p_job uuid,p_status text,p_rule text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF e.job_id IS DISTINCT FROM p_job OR e.attribution_status IS DISTINCT FROM p_status OR e.metadata->>'placement_rule' IS DISTINCT FROM p_rule THEN
  RAISE EXCEPTION 'c2k %: expected job % status % rule %, got job % status % rule %',p_label,p_job,p_status,p_rule,
   e.job_id,e.attribution_status,e.metadata->>'placement_rule';
 END IF;
END $$;

CREATE FUNCTION pg_temp.c2k_cases() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
 at constant timestamptz:='2026-09-20 02:00Z';
 j_one uuid; j_two_a uuid; j_two_b uuid; j_live uuid; j_done uuid; j_c1 uuid; j_c2 uuid; j_old uuid; j_new uuid;
 e public.business_events; tw public.business_events; r text; res jsonb;
BEGIN
 j_one:=pg_temp.c2k_job('SWF-998801','c2k-contact-one','scheduled','2026-09-01Z');
 j_two_a:=pg_temp.c2k_job('SWF-998802','c2k-contact-two','scheduled','2026-09-01Z');
 j_two_b:=pg_temp.c2k_job('SWF-998803','c2k-contact-two','quoted','2026-09-05Z');
 j_live:=pg_temp.c2k_job('SWF-998804','c2k-contact-recent','scheduled','2026-09-01Z');
 j_done:=pg_temp.c2k_job('SWF-998805','c2k-contact-recent','complete','2026-07-01Z','2026-09-10Z');
 j_c1:=pg_temp.c2k_job('SWF-998806','c2kCopyJobContact1','scheduled','2026-09-01Z');
 j_c2:=pg_temp.c2k_job('SWF-998807','c2kCopyJobContact1','scheduled','2026-09-02Z');
 j_old:=pg_temp.c2k_job('SWF-CANARY-998809','c2k-contact-numberless','scheduled','2026-09-01Z');

 ------------------------------------------------------------ rules off: as before
 PERFORM pg_temp.c2k_flag(false);
 e:=pg_temp.c2k_call('c2k-contact-one',at);
 IF e.job_id IS NOT NULL OR e.attribution_status<>'empty' THEN RAISE EXCEPTION 'c2k rules off: an empty call must stay empty on no job, got % %',e.attribution_status,e.job_id; END IF;

 PERFORM pg_temp.c2k_flag(true);
 ------------------------------------------------------------ A. empty rows
 e:=pg_temp.c2k_call('c2k-contact-one',at);
 PERFORM pg_temp.c2k_expect('one job',e,j_one,'empty','empty_single_open');
 IF e.match_method<>'contact_id' OR e.match_status<>'matched' THEN RAISE EXCEPTION 'c2k one job: match % %',e.match_method,e.match_status; END IF;
 IF public.context_linked_status(e.attribution_status) THEN RAISE EXCEPTION 'c2k one job: an empty row must not be a linked status'; END IF;
 e:=pg_temp.c2k_call('c2k-contact-two',at);
 PERFORM pg_temp.c2k_expect('several jobs',e,NULL,'empty','empty_several');
 IF NOT (e.candidate_job_ids @> ARRAY[j_two_a,j_two_b] AND cardinality(e.candidate_job_ids)=2) THEN RAISE EXCEPTION 'c2k several jobs: candidates %',e.candidate_job_ids; END IF;
 e:=pg_temp.c2k_call('c2k-contact-recent',at);
 PERFORM pg_temp.c2k_expect('finished job beside',e,NULL,'empty','empty_recent_other_job');
 IF NOT (e.candidate_job_ids @> ARRAY[j_live,j_done]) THEN RAISE EXCEPTION 'c2k finished job beside: candidates %',e.candidate_job_ids; END IF;
 e:=pg_temp.c2k_call('c2k-contact-numberless',at);
 PERFORM pg_temp.c2k_expect('test job',e,NULL,'empty','empty_no_real_job');
 e:=pg_temp.c2k_call('c2k-contact-nobody',at);
 PERFORM pg_temp.c2k_expect('no job',e,NULL,'empty','no_candidate_at_time');
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,payload)
 VALUES('client.call_complete','ghl-webhook-receiver','call','inbound',at,at,'{}') RETURNING * INTO e;
 PERFORM pg_temp.c2k_expect('no contact',e,NULL,'empty','no_contact');
 -- A crew text and a CRM staff note with no words are not customer messages.
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,contact_id,payload)
 VALUES('ghl.internal_comment','ghl-webhook-receiver','note','internal',at,at,'c2k-contact-one','{}') RETURNING * INTO e;
 PERFORM pg_temp.c2k_expect('staff note',e,NULL,'empty',NULL);
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,contact_id,payload,metadata)
 VALUES('client.sms_out','ghl-proxy','sms','outbound',at,at,'c2k-contact-crew','{}','{"recipient_role":"crew"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL AND e.metadata->>'placement_rule' LIKE 'empty%' THEN RAISE EXCEPTION 'c2k crew text: placed by the empty rule'; END IF;

 ------------------------------------------------------------ B. our own tool's copies
 -- The twin names one of two jobs; the copy follows it, not the contact's two jobs.
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,contact_id,payload)
 VALUES('client.sms_out','ghl-proxy','sms','outbound',at,at,'c2kCopyJobContact1',
  '{"body":"Hi Sam, your fence SWF-998806 is booked for Thursday 7am."}') RETURNING * INTO tw;
 IF tw.job_id IS DISTINCT FROM j_c1 THEN RAISE EXCEPTION 'c2k twin fixture: the twin must sit on SWF-998806, got % %',tw.job_id,tw.metadata->>'placement_rule'; END IF;
 INSERT INTO public.business_events(event_type,source,entity_type,occurred_at,payload)
 VALUES('client.sms_out','mcp_agent','unknown',at+interval '1 second',
  '{"message_preview":"Hi Sam, your fence SWF-998806 is booked for Thursday 7am.","sent_by":"c2k","to_contact_id":"c2kCopyJobContact1","tool":"sw_send_sms"}') RETURNING * INTO e;
 PERFORM pg_temp.c2k_expect('copy follows its twin',e,j_c1,'empty','twin_copy');
 IF e.metadata->>'placement_copy_of' IS DISTINCT FROM tw.id::text THEN RAISE EXCEPTION 'c2k copy: placement_copy_of %',e.metadata->>'placement_copy_of'; END IF;
 IF e.contact_id IS DISTINCT FROM 'c2kCopyJobContact1' OR e.metadata->>'contact_recovered_by' IS DISTINCT FROM 'payload_recipient'
 THEN RAISE EXCEPTION 'c2k copy: recipient not recorded, % %',e.contact_id,e.metadata->>'contact_recovered_by'; END IF;
 -- A recipient id that is not a contact id shape is not read.
 INSERT INTO public.business_events(event_type,source,entity_type,occurred_at,payload)
 VALUES('client.sms_out','mcp_agent','unknown',at,'{"message_preview":"Hi Sam, your fence SWF-998806 is booked.","to_contact_id":"not a contact"}') RETURNING * INTO e;
 PERFORM pg_temp.c2k_expect('copy with no readable recipient',e,NULL,'empty','no_contact');
 -- Words that are not the twin's: no twin; two jobs: set aside.
 INSERT INTO public.business_events(event_type,source,entity_type,occurred_at,payload)
 VALUES('client.sms_out','mcp_agent','unknown',at+interval '2 seconds',
  '{"message_preview":"Something else entirely, see you then.","to_contact_id":"c2kCopyJobContact1"}') RETURNING * INTO e;
 PERFORM pg_temp.c2k_expect('copy with no twin',e,NULL,'empty','empty_several');
 -- A twin set aside as not about a job: the copy carries the same reason.
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,contact_id,payload)
 VALUES('client.sms_out','ghl-proxy','sms','outbound',at,at,'c2kNoJobsContact01','{"body":"Thanks for your enquiry, we will call you."}') RETURNING * INTO tw;
 IF tw.attribution_status<>'admin_bucket' OR tw.metadata->>'bucket_reason' NOT IN ('contact_no_jobs','before_any_job') THEN
  RAISE EXCEPTION 'c2k twin fixture: expected a bucket row with a not-about-a-job reason, got % %',tw.attribution_status,tw.metadata->>'bucket_reason';
 END IF;
 INSERT INTO public.business_events(event_type,source,entity_type,occurred_at,payload)
 VALUES('client.sms_out','mcp_agent','unknown',at,'{"message_preview":"Thanks for your enquiry, we will call you.","to_contact_id":"c2kNoJobsContact01"}') RETURNING * INTO e;
 PERFORM pg_temp.c2k_expect('copy of a set-aside twin',e,NULL,'admin_bucket','twin_copy');
 IF e.metadata->>'bucket_reason' IS DISTINCT FROM tw.metadata->>'bucket_reason' THEN RAISE EXCEPTION 'c2k copy: reason % not the twin''s %',e.metadata->>'bucket_reason',tw.metadata->>'bucket_reason'; END IF;

 ------------------------------------------------------------ C. worded rows as before
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,contact_id,payload)
 VALUES('client.sms_in','ghl-webhook-receiver','sms','inbound',at,at,'c2k-contact-one','{"body":"Is Thursday still ok?"}') RETURNING * INTO e;
 PERFORM pg_temp.c2k_expect('worded text',e,j_one,'single_open','single_open');

 ------------------------------------------------------------ D. stored rows decided again
 -- A row stored before this change (rules off) is placed by the hand run, as relink.
 PERFORM pg_temp.c2k_flag(false);
 e:=pg_temp.c2k_call('c2k-contact-one',at);
 PERFORM pg_temp.c2k_flag(true);
 r:=public.context_redecide_one(e.id,'hand_run');
 IF r<>'placed' THEN RAISE EXCEPTION 'c2k hand run: expected placed, got %',r; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 PERFORM pg_temp.c2k_expect('hand run',e,j_one,'empty','empty_single_open');
 IF e.metadata->>'capture_mode' IS DISTINCT FROM 'relink' THEN RAISE EXCEPTION 'c2k hand run: an old message must be relink, got %',e.metadata->>'capture_mode'; END IF;
 -- Again: nothing to do.
 r:=public.context_redecide_one(e.id,'hand_run');
 IF r<>'unchanged' THEN RAISE EXCEPTION 'c2k hand run twice: expected unchanged, got %',r; END IF;
 -- A stored empty row that stays off a job gets its named rule once, then nothing.
 PERFORM pg_temp.c2k_flag(false);
 e:=pg_temp.c2k_call('c2k-contact-two',at);
 PERFORM pg_temp.c2k_flag(true);
 r:=public.context_redecide_one(e.id,'hand_run');
 IF r<>'named' THEN RAISE EXCEPTION 'c2k hand run several: expected named, got %',r; END IF;
 r:=public.context_redecide_one(e.id,'hand_run');
 IF r<>'unchanged' THEN RAISE EXCEPTION 'c2k hand run several twice: expected unchanged, got %',r; END IF;
 -- A bucket row set aside before the reasons existed gets its reason once.
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,contact_id,payload)
 VALUES('client.sms_in','ghl-webhook-receiver','sms','inbound',at,at,'c2kNoJobsBucket01','{"body":"Do you do fences in Morley?"}') RETURNING * INTO e;
 IF e.attribution_status<>'admin_bucket' OR e.metadata->>'bucket_reason' IS NULL THEN RAISE EXCEPTION 'c2k bucket fixture: % %',e.attribution_status,e.metadata->>'bucket_reason'; END IF;
 tw:=e;
 UPDATE public.business_events SET metadata=metadata-'bucket_reason' WHERE id=e.id;
 r:=public.context_redecide_one(e.id,'hand_run');
 IF r<>'named' THEN RAISE EXCEPTION 'c2k bucket reason: expected named, got %',r; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 IF e.attribution_status<>'admin_bucket' OR e.job_id IS NOT NULL OR e.metadata->>'bucket_reason' IS DISTINCT FROM tw.metadata->>'bucket_reason' THEN
  RAISE EXCEPTION 'c2k bucket reason: got % % %',e.attribution_status,e.job_id,e.metadata->>'bucket_reason';
 END IF;
 r:=public.context_redecide_one(e.id,'hand_run');
 IF r<>'unchanged' THEN RAISE EXCEPTION 'c2k bucket reason twice: expected unchanged, got %',r; END IF;
 res:=public.context_redecide_resting('empty',NULL,NULL);
 IF res->>'outcome'<>'done' OR NOT (res ? 'named') OR NOT (res ? 'set_aside') THEN RAISE EXCEPTION 'c2k resting empty: %',res; END IF;
 -- P1b: a lead's call before the job, then the job: the call goes on it.
 e:=pg_temp.c2k_call('c2k-contact-lead',at);
 PERFORM pg_temp.c2k_expect('lead call',e,NULL,'empty','no_candidate_at_time');
 j_new:=pg_temp.c2k_job('SWF-998808','c2k-contact-lead','quoted',at+interval '5 days');
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 PERFORM pg_temp.c2k_expect('lead call after the job',e,j_new,'empty','empty_single_open');
 IF e.metadata->'placement_reconsidered'->>'job_id' IS DISTINCT FROM j_new::text THEN RAISE EXCEPTION 'c2k P1b: no reconsideration note'; END IF;
 PERFORM pg_temp.c2k_flag(false);
END $$;

-- A registered successor that replaces the helper (C2 place, 20261104202000:
-- a contact with no job then is set aside as not about a job) comes off
-- first, inside each transaction.
BEGIN;
SELECT coalesce((SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_empty_row_job(public.business_events)')),'')
 ='1769c9e93e3ebefc25416781bb5a94e6' AS c2p_live \gset
\if :c2p_live
\ir ../../../rollbacks/20261104202000_context_c2_empty_no_job_reason_down.sql
\endif
SELECT pg_temp.c2k_cases();
ROLLBACK;

-- E. Structure.
BEGIN;
SELECT coalesce((SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_empty_row_job(public.business_events)')),'')
 ='1769c9e93e3ebefc25416781bb5a94e6' AS c2p_live \gset
\if :c2p_live
\ir ../../../rollbacks/20261104202000_context_c2_empty_no_job_reason_down.sql
\endif
DO $$
DECLARE x record; problems text[]:='{}'; r text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.resolve_context_attribution(public.business_events,boolean,boolean)','f9cd8d311bf00a92f7b708ff2d2dc8a7','L1g plus unplaced stage 1 (20261014170000)%C2 known contacts (20261104095000)%',false),
  ('public.context_redecide_one(uuid,text,jsonb)','b90e52161037944135f326ecf38c9745','Unplaced stage 1 (20261014170000)%C2 known contacts (20261104095000)%',true),
  ('public.context_redecide_resting(text,timestamptz,uuid)','5c11ac90d98fe62b0749e27c4f427f64','Unplaced stage 1 (20261014170000)%C2 known contacts (20261104095000)%',true),
  ('public.context_reconsider_eligible(public.business_events,uuid)','b36321bfcadcb02dc2aef454d12cece7','%C2 known contacts (20261104095000)%',false),
  ('public.context_reconsider_contact(text,timestamptz,text,uuid)','53f7d9d592e75d0232226fa466f76464','%C2 known contacts (20261104095000)%',true),
  ('public.context_empty_row_job(public.business_events)','130b29784228b2542306f5c0e5a5f0e7','C2 known contacts (20261104095000)%',true)
 ) AS t(sig,want,note,service_role) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(x.sig)) IS DISTINCT FROM x.want THEN problems:=problems||format('%s md5',x.sig); END IF;
  IF coalesce(obj_description(to_regprocedure(x.sig),'pg_proc'),'') NOT LIKE x.note THEN problems:=problems||format('%s comment',x.sig); END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF has_function_privilege(r,x.sig,'EXECUTE') THEN problems:=problems||format('%s can call %s',r,x.sig); END IF;
  END LOOP;
  IF has_function_privilege('service_role',x.sig,'EXECUTE') IS DISTINCT FROM x.service_role THEN problems:=problems||format('service role grant on %s',x.sig); END IF;
 END LOOP;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'ce620833c851196a00eca328d9b7426a'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure)<>'32365101d23dde1695707a0bddff640b'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_event_text(public.business_events)'::regprocedure)<>'bd5870b90e0f912d6a6d5be4faea812e'
 THEN problems:=problems||'the rules-off ladder, the entry or the text reader changed'::text; END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name='context_unlinked_rules_v1' AND NOT enabled)<>1
 THEN problems:=problems||'the rules flag must stay off'::text; END IF;
 IF cardinality(problems)>0 THEN RAISE EXCEPTION 'c2k structure: %',array_to_string(problems,'; '); END IF;
END $$;

-- Re-apply is a no-op.
CREATE TEMP TABLE c2k_before AS SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5, obj_description(p.oid,'pg_proc') AS note, p.proacl::text AS acl
 FROM pg_proc p WHERE p.oid IN ('public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure,
  'public.context_redecide_one(uuid,text,jsonb)'::regprocedure,'public.context_redecide_resting(text,timestamptz,uuid)'::regprocedure,
  'public.context_reconsider_eligible(public.business_events,uuid)'::regprocedure,'public.context_reconsider_contact(text,timestamptz,text,uuid)'::regprocedure,
  'public.context_empty_row_job(public.business_events)'::regprocedure);
\ir ../../../migrations/20261104095000_context_known_contact_placement.sql
DO $$
BEGIN
 IF (SELECT count(*) FROM c2k_before)<>6 THEN RAISE EXCEPTION 'c2k: expected 6 functions, got %',(SELECT count(*) FROM c2k_before); END IF;
 IF EXISTS(SELECT 1 FROM c2k_before b LEFT JOIN pg_proc p ON p.oid=b.sig::regprocedure
   WHERE md5(p.prosrc) IS DISTINCT FROM b.md5 OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note OR p.proacl::text IS DISTINCT FROM b.acl)
 THEN RAISE EXCEPTION 'c2k: re-apply changed a body, comment or grant'; END IF;
END $$;
DROP TABLE c2k_before;
ROLLBACK;
