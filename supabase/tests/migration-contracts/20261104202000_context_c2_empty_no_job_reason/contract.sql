-- C2 place contract (20261104202000). Every fixture write is rolled back.
-- Ids, job numbers, contacts, phones and text are synthetic.
--
-- The rule (rules on, through the real insert trigger): a customer message
-- with no words from a known contact with no job at the message time and no
-- finished job in the aftercare window is set aside as not about a job, with
-- the reason a worded message gets there, when the message's own keys agree:
--   A. no job at all -> admin_bucket, contact_no_jobs; the first job more
--      than 60 days later -> admin_bucket, before_any_job.
--   B. Left empty with its named rule as before (never marked, never placed):
--      a job 31 to 60 days later (a possible lead), only finished work, a
--      job carrying the message's phone (another contact's or contactless),
--      a job hint taken off.
--   C. Unchanged: one job (placed), several jobs, a worded message, rules off.
--      A copy our own tool logged follows its twin only onto a customer's job:
--      a twin on a holding record is not followed (the contact's job decides).
--   D. Stored rows: the hand run sets an old empty row aside once
--      (set_aside, then unchanged); the bucket re-run keeps it; a new job
--      inside its lead window places it (P1b).
--   E. Structure: md5, comment, grants, the ladder and the hand run
--      untouched, re-apply a no-op.
\set ON_ERROR_STOP 1

CREATE FUNCTION pg_temp.c2p_flag(p_on boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE public.feature_flags SET enabled=p_on,updated_at=clock_timestamp() WHERE flag_name='context_unlinked_rules_v1';
 IF public.context_unlinked_rules_enabled() IS DISTINCT FROM p_on THEN RAISE EXCEPTION 'c2p fixture: rules flag not %',p_on; END IF;
END $$;

CREATE FUNCTION pg_temp.c2p_job(p_number text,p_contact text,p_status text,p_created timestamptz,p_completed timestamptz DEFAULT NULL,p_phone text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,job_number,status,type,ghl_contact_id,site_address,created_at,completed_at,client_phone,metadata)
 VALUES(v,'00000000-0000-0000-0000-000000000001',p_number,p_status,'fencing',p_contact,'9 Banksia Road, Morley WA 6062',p_created,p_completed,p_phone,'{}');
 RETURN v;
END $$;

CREATE FUNCTION pg_temp.c2p_call(p_contact text,p_at timestamptz,p_phone text DEFAULT NULL) RETURNS public.business_events
LANGUAGE plpgsql AS $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,contact_id,payload)
 VALUES('client.call_complete','ghl-webhook-receiver','call','inbound',p_at,p_at,p_contact,
  jsonb_build_object('status','completed')||CASE WHEN p_phone IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('customer_phone',p_phone) END)
 RETURNING * INTO e;
 RETURN e;
END $$;

CREATE FUNCTION pg_temp.c2p_expect(p_label text,e public.business_events,p_job uuid,p_status text,p_rule text,p_reason text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF e.job_id IS DISTINCT FROM p_job OR e.attribution_status IS DISTINCT FROM p_status OR e.metadata->>'placement_rule' IS DISTINCT FROM p_rule
  OR e.metadata->>'bucket_reason' IS DISTINCT FROM p_reason THEN
  RAISE EXCEPTION 'c2p %: expected job % status % rule % reason %, got job % status % rule % reason %',p_label,p_job,p_status,p_rule,p_reason,
   e.job_id,e.attribution_status,e.metadata->>'placement_rule',e.metadata->>'bucket_reason';
 END IF;
END $$;

CREATE FUNCTION pg_temp.c2p_cases() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
 at constant timestamptz:='2026-09-20 02:00Z';
 j_one uuid; j_later uuid; j_near uuid; j_done uuid; j_key uuid; j_two_a uuid; j_two_b uuid; j_new uuid; j_hold uuid; j_own uuid;
 e public.business_events; tw public.business_events; r text; n int;
BEGIN
 j_one:=pg_temp.c2p_job('SWF-997701','c2p-contact-one','scheduled','2026-09-01Z');
 j_later:=pg_temp.c2p_job('SWF-997702','c2p-contact-later','quoted',at+interval '90 days');
 j_near:=pg_temp.c2p_job('SWF-997703','c2p-contact-near','quoted',at+interval '45 days');
 j_done:=pg_temp.c2p_job('SWF-997704','c2p-contact-done','complete','2025-11-01Z','2026-01-10Z');
 -- A contactless job carrying the caller's phone, created long after the call.
 j_key:=pg_temp.c2p_job('SWF-997705',NULL,'quoted',at+interval '120 days',NULL,'0400 997 705');
 j_two_a:=pg_temp.c2p_job('SWF-997706','c2p-contact-two','scheduled','2026-09-01Z');
 j_two_b:=pg_temp.c2p_job('SWF-997707','c2p-contact-two','quoted','2026-09-05Z');

 ------------------------------------------------------------ rules off: as before
 PERFORM pg_temp.c2p_flag(false);
 e:=pg_temp.c2p_call('c2p-contact-nobody',at);
 IF e.job_id IS NOT NULL OR e.attribution_status<>'empty' THEN RAISE EXCEPTION 'c2p rules off: an empty call must stay empty, got % %',e.attribution_status,e.job_id; END IF;
 PERFORM pg_temp.c2p_flag(true);

 ------------------------------------------------------------ A. not about a job
 e:=pg_temp.c2p_call('c2p-contact-nobody',at);
 PERFORM pg_temp.c2p_expect('no job at all',e,NULL,'admin_bucket','no_candidate_at_time','contact_no_jobs');
 IF e.candidate_job_ids IS NOT NULL OR e.match_status<>'unresolved' OR e.match_method<>'none' OR e.attributed_at IS NOT NULL
 THEN RAISE EXCEPTION 'c2p no job at all: a set-aside row must carry no candidates or match, got % % % %',e.candidate_job_ids,e.match_status,e.match_method,e.attributed_at; END IF;
 IF public.context_linked_status(e.attribution_status) THEN RAISE EXCEPTION 'c2p no job at all: admin_bucket must not be a linked status'; END IF;
 e:=pg_temp.c2p_call('c2p-contact-later',at);
 PERFORM pg_temp.c2p_expect('first job 90 days later',e,NULL,'admin_bucket','no_candidate_at_time','before_any_job');

 ------------------------------------------------------------ B. left empty, named
 e:=pg_temp.c2p_call('c2p-contact-near',at);
 PERFORM pg_temp.c2p_expect('first job 45 days later',e,NULL,'empty','no_candidate_at_time',NULL);
 e:=pg_temp.c2p_call('c2p-contact-done',at);
 PERFORM pg_temp.c2p_expect('only finished work',e,NULL,'empty','no_candidate_at_time',NULL);
 -- The contact has no job, but a contactless job carries the caller's phone: the keys disagree.
 e:=pg_temp.c2p_call('c2p-contact-keyed',at,'0400 997 705');
 PERFORM pg_temp.c2p_expect('a job carries the phone',e,NULL,'empty','no_candidate_at_time',NULL);
 -- The same contact with no phone on the call: no job by any key.
 e:=pg_temp.c2p_call('c2p-contact-keyed',at);
 PERFORM pg_temp.c2p_expect('no phone on the call',e,NULL,'admin_bucket','no_candidate_at_time','contact_no_jobs');
 -- A job the ladder took off a stored row (a hint) is never read as no job.
 PERFORM pg_temp.c2p_flag(false);
 e:=pg_temp.c2p_call('c2p-contact-hint',at);
 UPDATE public.business_events SET metadata=metadata||jsonb_build_object('attribution_hint',jsonb_build_object('job_id',j_one,'match_method','none'))
 WHERE id=e.id;
 PERFORM pg_temp.c2p_flag(true);
 r:=public.context_redecide_one(e.id,'hand_run');
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 PERFORM pg_temp.c2p_expect('a job hint',e,NULL,'empty','no_candidate_at_time',NULL);

 ------------------------------------------------------------ C. unchanged
 e:=pg_temp.c2p_call('c2p-contact-one',at);
 PERFORM pg_temp.c2p_expect('one job',e,j_one,'empty','empty_single_open',NULL);
 e:=pg_temp.c2p_call('c2p-contact-two',at);
 PERFORM pg_temp.c2p_expect('several jobs',e,NULL,'empty','empty_several',NULL);
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,contact_id,payload)
 VALUES('client.sms_in','ghl-webhook-receiver','sms','inbound',at,at,'c2p-contact-worded','{"body":"Do you build fences in Morley?"}') RETURNING * INTO e;
 PERFORM pg_temp.c2p_expect('worded, no job',e,NULL,'admin_bucket','no_candidate_at_time','contact_no_jobs');
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,payload)
 VALUES('client.call_complete','ghl-webhook-receiver','call','inbound',at,at,'{}') RETURNING * INTO e;
 PERFORM pg_temp.c2p_expect('no contact',e,NULL,'empty','no_contact',NULL);
 -- Our own tool's copy of a text whose twin its writer put on a holding record: not followed onto it.
 j_own:=pg_temp.c2p_job('SWF-997709','c2pCopyHoldContact1','scheduled','2026-09-01Z');
 j_hold:=gen_random_uuid();
 INSERT INTO public.jobs(id,org_id,job_number,status,type,site_address,created_at,metadata)
 VALUES(j_hold,'00000000-0000-0000-0000-000000000001','SWF-HOLD-997710','archived','fencing','1 Holding Way, Perth WA 6000','2026-01-01Z','{"do_not_schedule":"true"}');
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,contact_id,payload)
 VALUES('client.sms_out','ghl-proxy','sms','outbound',at,at,'c2pCopyHoldContact1','{"body":"Hi Jo, your patio quote is attached, call us with questions."}') RETURNING * INTO tw;
 UPDATE public.business_events SET job_id=j_hold,attribution_status='direct' WHERE id=tw.id;
 INSERT INTO public.business_events(event_type,source,entity_type,occurred_at,payload)
 VALUES('client.sms_out','mcp_agent','unknown',at+interval '1 second',
  '{"message_preview":"Hi Jo, your patio quote is attached, call us with questions.","to_contact_id":"c2pCopyHoldContact1","tool":"sw_send_sms"}') RETURNING * INTO e;
 PERFORM pg_temp.c2p_expect('twin on a holding record',e,j_own,'empty','empty_single_open',NULL);
 -- The same twin on the contact's own job: the copy follows it, as before.
 UPDATE public.business_events SET job_id=j_own,attribution_status='single_open' WHERE id=tw.id;
 INSERT INTO public.business_events(event_type,source,entity_type,occurred_at,payload)
 VALUES('client.sms_out','mcp_agent','unknown',at+interval '2 seconds',
  '{"message_preview":"Hi Jo, your patio quote is attached, call us with questions.","to_contact_id":"c2pCopyHoldContact1","tool":"sw_send_sms"}') RETURNING * INTO e;
 PERFORM pg_temp.c2p_expect('twin on the customer''s job',e,j_own,'empty','twin_copy',NULL);

 ------------------------------------------------------------ D. stored rows
 -- A row stored before this change (rules off) is set aside by the hand run, once.
 PERFORM pg_temp.c2p_flag(false);
 e:=pg_temp.c2p_call('c2p-contact-stored',at);
 PERFORM pg_temp.c2p_flag(true);
 r:=public.context_redecide_one(e.id,'hand_run',jsonb_build_object('run','c2p'));
 IF r<>'set_aside' THEN RAISE EXCEPTION 'c2p hand run: expected set_aside, got %',r; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 PERFORM pg_temp.c2p_expect('hand run',e,NULL,'admin_bucket','no_candidate_at_time','contact_no_jobs');
 IF e.metadata->'placement_redecided'->>'from_status' IS DISTINCT FROM 'empty' OR e.metadata->'placement_redecided'->>'run' IS DISTINCT FROM 'c2p'
 THEN RAISE EXCEPTION 'c2p hand run: note %',e.metadata->'placement_redecided'; END IF;
 r:=public.context_redecide_one(e.id,'hand_run');
 IF r<>'unchanged' THEN RAISE EXCEPTION 'c2p hand run twice: expected unchanged, got %',r; END IF;
 -- The bucket re-run decides it the same way.
 n:=public.rerun_context_attribution(10,'c2p-contact-stored');
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 PERFORM pg_temp.c2p_expect('bucket re-run',e,NULL,'admin_bucket','no_candidate_at_time','contact_no_jobs');
 -- P1b: the job arrives inside the call's lead window; the call goes on it.
 j_new:=pg_temp.c2p_job('SWF-997708','c2p-contact-stored','quoted',at+interval '5 days');
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 PERFORM pg_temp.c2p_expect('lead call after the job',e,j_new,'empty','empty_single_open',NULL);
 IF e.metadata->'placement_reconsidered'->>'job_id' IS DISTINCT FROM j_new::text THEN RAISE EXCEPTION 'c2p P1b: no reconsideration note'; END IF;
 PERFORM pg_temp.c2p_flag(false);
END $$;

BEGIN;
SELECT pg_temp.c2p_cases();
ROLLBACK;

-- E. Structure.
DO $$
DECLARE problems text[]:='{}'; r text; sig constant text:='public.context_empty_row_job(public.business_events)';
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(sig)) IS DISTINCT FROM 'b057fc7da940afe25833028d511594b5' THEN problems:=problems||'helper md5'::text; END IF;
 IF coalesce(obj_description(to_regprocedure(sig),'pg_proc'),'') NOT LIKE 'C2 known contacts (20261104095000)%C2 place (20261104202000)%' THEN problems:=problems||'helper comment'::text; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF has_function_privilege(r,sig,'EXECUTE') THEN problems:=problems||format('%s can call the helper',r); END IF;
 END LOOP;
 IF NOT has_function_privilege('service_role',sig,'EXECUTE') THEN problems:=problems||'service role grant on the helper'::text; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure)<>'f9cd8d311bf00a92f7b708ff2d2dc8a7'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_redecide_one(uuid,text,jsonb)'::regprocedure)<>'b90e52161037944135f326ecf38c9745'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'ce620833c851196a00eca328d9b7426a'
 THEN problems:=problems||'the ladder, the hand run or the rules-off ladder changed'::text; END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name='context_unlinked_rules_v1' AND NOT enabled)<>1
 THEN problems:=problems||'the rules flag must stay off'::text; END IF;
 IF cardinality(problems)>0 THEN RAISE EXCEPTION 'c2p structure: %',array_to_string(problems,'; '); END IF;
END $$;

-- Re-apply is a no-op.
CREATE TEMP TABLE c2p_before AS SELECT md5(p.prosrc) AS md5, obj_description(p.oid,'pg_proc') AS note, p.proacl::text AS acl
 FROM pg_proc p WHERE p.oid='public.context_empty_row_job(public.business_events)'::regprocedure;
\ir ../../../migrations/20261104202000_context_c2_empty_no_job_reason.sql
DO $$
BEGIN
 IF (SELECT count(*) FROM c2p_before)<>1 THEN RAISE EXCEPTION 'c2p: expected the helper'; END IF;
 IF EXISTS(SELECT 1 FROM c2p_before b, pg_proc p WHERE p.oid='public.context_empty_row_job(public.business_events)'::regprocedure
   AND (md5(p.prosrc) IS DISTINCT FROM b.md5 OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note OR p.proacl::text IS DISTINCT FROM b.acl))
 THEN RAISE EXCEPTION 'c2p: re-apply changed the body, comment or grant'; END IF;
END $$;
DROP TABLE c2p_before;
