-- Ladder L1e contract (20261005170000). Every fixture write is rolled back.
-- Ids, job numbers, contacts and text are synthetic.
--
-- Proves, with the rules flag off (as shipped) and on:
--   A. A service-role row naming a job with no match_method (null or none)
--      keeps that job when it has no words (empty), is a system row or is
--      automated (automated): placement_rule writer_job. Preview and a
--      re-decision of the stored row agree. A holding job is never kept.
--   B. A worded row from the same writer is unchanged: the job stays a hint
--      and the ladder decides (here: the bucket).
--   C. Another writer (a signed-in login) and a guess method keep nothing.
--   D. F6: a custody row with no words, and an automated custody row, keep
--      their job with the rules on as with them off.
--   E. F5: a payload job the writer declared a guess (the SMS cache backfill,
--      or a payload attribution_hint naming the same job with a contact
--      method) is skipped by step 1b and the contact rules place the row;
--      a plain payload job still places on step 1b.
--   F. A crew-marked text is the crew and staff rule's, never a writer job.
--   G. The payload-job repair classes a declared guess payload_job_guess and
--      never moves it; an ordinary mismatch is still repointed.
--   H. Structure: both bodies are L1c's plus exactly these edits, the helpers
--      are private, the bodies are marked L1e, the flag stays off, and a
--      re-apply of this migration is a no-op.
\set ON_ERROR_STOP 1

CREATE FUNCTION pg_temp.wj_job(p_number text,p_contact text,p_meta jsonb DEFAULT '{}'::jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at,metadata)
  VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing',p_number,p_contact,now()-interval '60 days',p_meta);
 RETURN j;
END $$;

-- One record through the real insert trigger; the ladder decides it.
CREATE FUNCTION pg_temp.wj_ev(p_source text,p_job uuid,p_method text,p_payload jsonb,p_channel text DEFAULT NULL,
 p_role text DEFAULT NULL,p_contact text DEFAULT NULL,p_direction text DEFAULT NULL,p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS public.business_events LANGUAGE plpgsql AS $$
DECLARE e public.business_events;
BEGIN
 IF p_role IS NOT NULL THEN PERFORM set_config('request.jwt.claims',jsonb_build_object('role',p_role)::text,true); END IF;
 INSERT INTO public.business_events(job_id,match_method,contact_id,entity_type,entity_id,direction,channel,event_type,source,
  provider_message_id,payload,metadata,occurred_at,event_at)
  VALUES(p_job,p_method,p_contact,'invoice','wj-fixture',p_direction,p_channel,'invoice.paid',p_source,
   CASE WHEN p_contact IS NOT NULL THEN 'ghl:wj'||replace(gen_random_uuid()::text,'-','') END,
   p_payload,p_meta||'{"capture_mode":"live"}',now()-interval '1 day',now()-interval '1 day')
  RETURNING * INTO e;
 PERFORM set_config('request.jwt.claims','',true);
 RETURN e;
END $$;

CREATE FUNCTION pg_temp.wj_cases(p_rules_on boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE lbl text:=CASE WHEN p_rules_on THEN 'rules on' ELSE 'rules off' END;
 j1 uuid; j2 uuid; jh uuid; e public.business_events; s public.business_events; p jsonb; m text; c jsonb;
 nowords constant jsonb:='{"invoice_number":"INV-99001","amount_paid":110}';
BEGIN
 UPDATE public.feature_flags SET enabled=p_rules_on,updated_at=clock_timestamp() WHERE flag_name='context_unlinked_rules_v1';
 IF public.context_unlinked_rules_enabled() IS DISTINCT FROM p_rules_on THEN RAISE EXCEPTION 'l1e fixture: flag not %',lbl; END IF;
 j1:=pg_temp.wj_job('SWF-991001','wj-cust');
 j2:=pg_temp.wj_job('SWF-991002','wj-other');
 jh:=pg_temp.wj_job('SWF-991003','wj-hold','{"do_not_schedule":"true"}');

 -- A. The writer job on a record the reader never reads.
 FOREACH m IN ARRAY ARRAY['<null>','none'] LOOP
  e:=pg_temp.wj_ev('xero-sync-trigger',j1,nullif(m,'<null>'),nowords);
  IF e.job_id IS DISTINCT FROM j1 OR e.attribution_status<>'empty' OR e.metadata->>'placement_rule' IS DISTINCT FROM 'writer_job'
   OR e.metadata->>'written_as' IS DISTINCT FROM 'service_role' OR e.match_method<>'none' OR e.match_status<>'unresolved'
  THEN RAISE EXCEPTION 'l1e %: a writer job on a row with no words must stay (method %), got % % %',lbl,m,e.attribution_status,e.job_id,e.metadata; END IF;
  p:=public.context_attribution_preview(e.id,p_rules_on);
  IF p->'decided'->>'job_id' IS DISTINCT FROM j1::text OR p->'decided'->>'attribution_status'<>'empty'
   OR p->'decided'->>'placement_rule' IS DISTINCT FROM 'writer_job'
  THEN RAISE EXCEPTION 'l1e %: preview must keep the writer job, got %',lbl,p; END IF;
  SELECT * INTO e FROM public.business_events WHERE id=e.id;
  s:=public.resolve_context_attribution(e);
  IF s.job_id IS DISTINCT FROM j1 OR s.attribution_status<>'empty'
  THEN RAISE EXCEPTION 'l1e %: a re-decision must keep the writer job, got % %',lbl,s.attribution_status,s.job_id; END IF;
 END LOOP;
 e:=pg_temp.wj_ev('mcp_agent',j1,NULL,'{"body":"Payment noted"}','system');
 IF e.job_id IS DISTINCT FROM j1 OR e.attribution_status<>'automated' OR e.metadata->>'placement_rule' IS DISTINCT FROM 'writer_job'
 THEN RAISE EXCEPTION 'l1e %: a system row must keep the writer job, got % %',lbl,e.attribution_status,e.job_id; END IF;
 e:=pg_temp.wj_ev('graf_event_listener',j1,NULL,'{"body":"Reminder cancelled","automated":"true"}');
 IF e.job_id IS DISTINCT FROM j1 OR e.attribution_status<>'automated' OR e.metadata->>'placement_rule' IS DISTINCT FROM 'writer_job'
 THEN RAISE EXCEPTION 'l1e %: an automated row must keep the writer job, got % %',lbl,e.attribution_status,e.job_id; END IF;
 e:=pg_temp.wj_ev('mcp_agent',jh,NULL,nowords);
 IF e.job_id IS NOT NULL OR e.attribution_status<>'empty'
 THEN RAISE EXCEPTION 'l1e %: a holding job must never be kept, got % %',lbl,e.attribution_status,e.job_id; END IF;

 -- B. A worded row: unchanged, the job stays a hint.
 e:=pg_temp.wj_ev('mcp_agent',j1,NULL,'{"body":"Customer asked about the gate colour"}');
 IF e.job_id IS NOT NULL OR e.attribution_status<>'admin_bucket' OR e.metadata->'attribution_hint'->>'job_id' IS DISTINCT FROM j1::text
  OR e.metadata->>'placement_rule' IS NOT DISTINCT FROM 'writer_job'
 THEN RAISE EXCEPTION 'l1e %: a worded writer row must stay as before, got % % %',lbl,e.attribution_status,e.job_id,e.metadata; END IF;

 -- C. Another writer, or a guess method: nothing kept.
 e:=pg_temp.wj_ev('patio-tool',j1,NULL,nowords,NULL,'authenticated');
 IF e.job_id IS NOT NULL OR e.metadata->>'written_as'<>'authenticated'
 THEN RAISE EXCEPTION 'l1e %: a signed-in writer must not pin a job, got % %',lbl,e.attribution_status,e.job_id; END IF;
 e:=pg_temp.wj_ev('patio-tool',j1,NULL,nowords,NULL,'anon');
 IF e.job_id IS NOT NULL THEN RAISE EXCEPTION 'l1e %: a public-key writer must not pin a job, got %',lbl,e.job_id; END IF;
 e:=pg_temp.wj_ev('some-matcher',j1,'contact_id',nowords);
 IF e.job_id IS NOT NULL OR e.attribution_status<>'empty'
 THEN RAISE EXCEPTION 'l1e %: a guess method must not be kept, got % %',lbl,e.attribution_status,e.job_id; END IF;

 -- D. F6: custody on rows with no words or automated, both paths.
 e:=pg_temp.wj_ev('send-quote',j1,'direct_job_id',nowords);
 IF e.job_id IS DISTINCT FROM j1 OR e.attribution_status<>'empty'
 THEN RAISE EXCEPTION 'l1e %: custody on a row with no words must stay, got % %',lbl,e.attribution_status,e.job_id; END IF;
 e:=pg_temp.wj_ev('send-quote',j1,'direct_job_id','{"body":"Auto reply","auto_submitted":"auto-replied"}');
 IF e.job_id IS DISTINCT FROM j1 OR e.attribution_status<>'automated'
 THEN RAISE EXCEPTION 'l1e %: custody on an automated row must stay, got % %',lbl,e.attribution_status,e.job_id; END IF;

 -- E. F5: a declared guess in payload.job_id is skipped by step 1b.
 e:=pg_temp.wj_ev('ghl_sms_cache_backfill',NULL,'none',
  jsonb_build_object('body','See you Tuesday','job_id',j2,'source','ghl_sms_cache_backfill',
   'attribution_hint',jsonb_build_object('job_id',j2,'match_method','contact_id','match_confidence',0.85)),'sms',NULL,'wj-cust','inbound');
 IF e.job_id IS DISTINCT FROM j1 OR e.attribution_status<>'single_open' OR e.metadata->>'payload_job_guess' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'l1e %: the backfill guess must not place the row, got % % %',lbl,e.attribution_status,e.job_id,e.metadata; END IF;
 -- The guess skip alone, without the hint (older backfill rows).
 e:=pg_temp.wj_ev('ghl_sms_cache_backfill',NULL,'none',jsonb_build_object('body','See you Tuesday','job_id',j2),'sms',NULL,'wj-cust','inbound');
 IF e.job_id IS DISTINCT FROM j1 OR e.metadata->>'payload_job_guess' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'l1e %: an older backfill guess must not place the row, got % %',lbl,e.attribution_status,e.job_id; END IF;
 -- Any writer whose payload hint calls the same job a contact guess.
 e:=pg_temp.wj_ev('ghl-receiver',NULL,NULL,
  jsonb_build_object('body','See you Tuesday','job_id',j2,'attribution_hint',jsonb_build_object('job_id',j2,'match_method','contact_id')),
  'sms',NULL,'wj-cust','inbound');
 IF e.job_id IS DISTINCT FROM j1 OR e.metadata->>'payload_job_guess' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'l1e %: a hinted guess must not place the row, got % %',lbl,e.attribution_status,e.job_id; END IF;
 -- Controls: a plain payload job, and a hint that says the job is certain, still place on step 1b.
 e:=pg_temp.wj_ev('ghl-proxy',NULL,NULL,jsonb_build_object('body','See you Tuesday','job_id',j2),'sms',NULL,'wj-cust','inbound');
 IF e.job_id IS DISTINCT FROM j2 OR e.attribution_status<>'direct' OR e.metadata->>'placement_rule' IS DISTINCT FROM 'payload_job'
  OR e.metadata ? 'payload_job_guess'
 THEN RAISE EXCEPTION 'l1e %: a plain payload job must still place, got % % %',lbl,e.attribution_status,e.job_id,e.metadata; END IF;
 e:=pg_temp.wj_ev('ghl-proxy',NULL,NULL,
  jsonb_build_object('body','See you Tuesday','job_id',j2,'attribution_hint',jsonb_build_object('job_id',j2,'match_method','direct_job_id')),
  'sms',NULL,'wj-cust','inbound');
 IF e.job_id IS DISTINCT FROM j2 OR e.metadata->>'placement_rule' IS DISTINCT FROM 'payload_job'
 THEN RAISE EXCEPTION 'l1e %: a certain hint must not read as a guess, got % %',lbl,e.attribution_status,e.job_id; END IF;

 -- F. The crew and staff rule still decides a marked text, writer job or not.
 e:=pg_temp.wj_ev('ghl-proxy',j1,NULL,'{"body":"New job assigned: SWF-991001"}','sms',NULL,'wj-crew','outbound','{"recipient_role":"crew"}');
 IF e.metadata->>'placement_rule' NOT IN ('staff_recipient','internal_recipient')
 THEN RAISE EXCEPTION 'l1e %: a crew text must stay the crew and staff rule''s, got % % %',lbl,e.attribution_status,e.job_id,e.metadata->>'placement_rule'; END IF;

 -- G. The repair classifier: a declared guess is never repointed.
 e:=pg_temp.wj_ev('ghl_sms_cache_backfill',NULL,'none',jsonb_build_object('body','See you Tuesday','job_id',j2),'sms',NULL,'wj-cust','inbound');
 s:=pg_temp.wj_ev('ghl-proxy',NULL,NULL,jsonb_build_object('body','On my way'),'sms',NULL,'wj-cust','inbound');
 UPDATE public.business_events SET payload=payload||jsonb_build_object('job_id',j2) WHERE id=s.id;
 IF (SELECT class FROM public.context_payload_job_mismatch_rows() WHERE id=e.id) IS DISTINCT FROM 'payload_job_guess'
  OR (SELECT class FROM public.context_payload_job_mismatch_rows() WHERE id=s.id) IS DISTINCT FROM 'repoint'
 THEN RAISE EXCEPTION 'l1e %: classes wrong: guess % ordinary %',lbl,
  (SELECT class FROM public.context_payload_job_mismatch_rows() WHERE id=e.id),(SELECT class FROM public.context_payload_job_mismatch_rows() WHERE id=s.id); END IF;
 c:=public.context_payload_job_repair(false,500);
 IF (SELECT job_id FROM public.business_events WHERE id=e.id) IS DISTINCT FROM j1
  OR (SELECT job_id FROM public.business_events WHERE id=s.id) IS DISTINCT FROM j2
 THEN RAISE EXCEPTION 'l1e %: the repair must move only the ordinary row, got %',lbl,c; END IF;
END $$;

BEGIN;
SELECT pg_temp.wj_cases(false);
ROLLBACK;
BEGIN;
SELECT pg_temp.wj_cases(true);
ROLLBACK;

-- H. Structure.
-- A registered successor (L1f 20261006020000, then L1g 20261006035000)
-- replaces the rules ladder and proves in its own contract that its body is
-- exactly its predecessor's plus its edits; while one is live only the
-- rules-off ladder, the helpers and the classifier are checked here, and the
-- re-apply is skipped (L1e's guard refuses to re-apply over a successor's body).
SELECT coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'),'pg_proc'),'') SIMILAR TO 'L1(f|g):%' AS l1f_live \gset
\if :l1f_live
DO $$
DECLARE f text; r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'ce620833c851196a00eca328d9b7426a'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_payload_job_mismatch_rows()'::regprocedure)<>'69d68f016116576e6b6c8c773de8752e'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_event_writer_job(public.business_events)'::regprocedure)<>'cd36b092818e7607d114d1b3011b3bfd'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_payload_job_is_guess(public.business_events)'::regprocedure)<>'1c87d88718cf014429170e3f1aaaa2aa'
 THEN RAISE EXCEPTION 'l1e: a body is not this migration''s'; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_ladder_p1a(public.business_events,boolean)',
  'public.context_event_writer_job(public.business_events)','public.context_payload_job_is_guess(public.business_events)'] LOOP
  IF coalesce(obj_description(f::regprocedure,'pg_proc'),'') NOT LIKE 'L1e:%' THEN RAISE EXCEPTION 'l1e: % is not marked L1e',f; END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(r,f,'EXECUTE') THEN RAISE EXCEPTION 'l1e: % can call private %',r,f; END IF;
  END LOOP;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.context_payload_job_mismatch_rows()','EXECUTE')
 THEN RAISE EXCEPTION 'l1e: the service role lost the classifier'; END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name='context_unlinked_rules_v1' AND NOT enabled)<>1
 THEN RAISE EXCEPTION 'l1e: the rules flag must stay off'; END IF;
END $$;
\else
DO $$
DECLARE f text; r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'ce620833c851196a00eca328d9b7426a'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure)<>'d5af94a0f9320652116cc2b304021ab5'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_payload_job_mismatch_rows()'::regprocedure)<>'69d68f016116576e6b6c8c773de8752e'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_event_writer_job(public.business_events)'::regprocedure)<>'cd36b092818e7607d114d1b3011b3bfd'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_payload_job_is_guess(public.business_events)'::regprocedure)<>'1c87d88718cf014429170e3f1aaaa2aa'
 THEN RAISE EXCEPTION 'l1e: a body is not this migration''s'; END IF;
 -- Undoing the L1e edits gives back L1d's bodies byte for byte.
 IF md5(replace(replace(replace(replace(replace(replace((SELECT prosrc FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure),
$b$ -- L1e (20261005170000): a payload job its writer declared a guess (the SMS
 -- cache backfill's newest job of the contact) is not the source's own job;
 -- the row goes on to the reference and contact rules.
 IF candidate IS NULL AND public.context_payload_job_is_guess(e) THEN
  e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('payload_job_guess',true);
 ELSIF candidate IS NULL AND e.payload#>>'{job_id}' IS NOT NULL THEN
$b$,
$b$ IF candidate IS NULL AND e.payload#>>'{job_id}' IS NOT NULL THEN
$b$),
$b$ IF to_jsonb(e)->>'channel' IN ('system','audit') THEN e.attribution_status:='automated';
  IF writer_job IS NOT NULL THEN e.job_id:=writer_job; e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','writer_job'); END IF;
  RETURN e;
 END IF;
 IF btrim(words)='' THEN e.attribution_status:='empty';
  IF writer_job IS NOT NULL THEN e.job_id:=writer_job; e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','writer_job'); END IF;
  RETURN e;
 END IF;
$b$,
$b$ IF to_jsonb(e)->>'channel' IN ('system','audit') THEN e.attribution_status:='automated'; RETURN e; END IF;
 IF btrim(words)='' THEN e.attribution_status:='empty'; RETURN e; END IF;
$b$),
$b$ THEN e.attribution_status:='automated';
  IF writer_job IS NOT NULL THEN e.job_id:=writer_job; e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','writer_job'); END IF;
  RETURN e;
 END IF;
$b$,
$b$ THEN e.attribution_status:='automated'; RETURN e; END IF;
$b$),
$b$ IF e.metadata ?| ARRAY['placement_rule','placement_contactless_job_ids','placement_guard_job_ids','payload_job_guess'] THEN
  e.metadata:=e.metadata-'placement_rule'-'placement_contactless_job_ids'-'placement_guard_job_ids'-'payload_job_guess';
$b$,
$b$ IF e.metadata ?| ARRAY['placement_rule','placement_contactless_job_ids','placement_guard_job_ids'] THEN
  e.metadata:=e.metadata-'placement_rule'-'placement_contactless_job_ids'-'placement_guard_job_ids';
$b$),
$b$ IF e.job_id IS NOT NULL AND coalesce(source_method,'none') NOT IN ('direct_job_id','direct_reference','manual') THEN
   -- L1e (20261005170000): a job the service role named without saying how
   -- (no match_method) is kept for a row the reader never reads.
   writer_job:=public.context_event_writer_job(e);
   e.metadata:=$b$,
$b$ IF e.job_id IS NOT NULL AND coalesce(source_method,'none') NOT IN ('direct_job_id','direct_reference','manual') THEN
   e.metadata:=$b$),
$b$
 writer_job uuid;
BEGIN
 prior_status:=e.attribution_status;
$b$,
$b$
BEGIN
 prior_status:=e.attribution_status;
$b$))<>'e11321e9d986be1e83f05e95f3efc36c'
 THEN RAISE EXCEPTION 'l1e: context_ladder_p1a is not L1d''s body plus the L1e edits'; END IF;
 IF md5(replace(replace(replace(replace(replace(replace((SELECT prosrc FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure),
$b$   -- L1e (20261005170000): a payload job its writer declared a guess is not
   -- the source's own job; the row goes on to the later rules.
   IF cand IS NULL AND public.context_payload_job_is_guess(e) THEN
    e.metadata:=e.metadata||jsonb_build_object('payload_job_guess',true);
   ELSIF cand IS NULL AND e.payload#>>'{job_id}' IS NOT NULL THEN
$b$,
$b$   IF cand IS NULL AND e.payload#>>'{job_id}' IS NOT NULL THEN
$b$),
$b$   -- L1e (20261005170000): a row with no words, a system row and an automated
   -- row keep the job custody proved (as with the rules off) and the job the
   -- service role named; none of them is ever read.
   IF to_jsonb(e)->>'channel' IN ('system','audit') THEN e.attribution_status:='automated';
    IF writer_job IS NOT NULL AND e.job_id IS NULL THEN e.job_id:=writer_job; e.metadata:=e.metadata||jsonb_build_object('placement_rule','writer_job'); END IF;
    EXIT rules;
   END IF;
   IF btrim(words)='' THEN e.attribution_status:='empty';
    IF writer_job IS NOT NULL AND e.job_id IS NULL THEN e.job_id:=writer_job; e.metadata:=e.metadata||jsonb_build_object('placement_rule','writer_job'); END IF;
    EXIT rules;
   END IF;
$b$,
$b$   IF to_jsonb(e)->>'channel' IN ('system','audit') THEN e.attribution_status:='automated'; EXIT rules; END IF;
   IF btrim(words)='' THEN e.attribution_status:='empty'; e.job_id:=NULL; EXIT rules; END IF;
$b$),
$b$   THEN e.attribution_status:='automated';
    IF writer_job IS NOT NULL AND e.job_id IS NULL THEN e.job_id:=writer_job; e.metadata:=e.metadata||jsonb_build_object('placement_rule','writer_job'); END IF;
    EXIT rules;
   END IF;
$b$,
$b$   THEN e.attribution_status:='automated'; e.job_id:=NULL; EXIT rules; END IF;
$b$),
$b$    ELSE
     -- L1e (20261005170000): a job the service role named without saying how
     -- (no match_method) is kept for a row the reader never reads.
     writer_job:=public.context_event_writer_job(e);
     e.metadata:=coalesce(e.metadata,'{}'::jsonb)-'source_job_binding';
     e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('attribution_hint'$b$,
$b$    ELSE
     e.metadata:=coalesce(e.metadata,'{}'::jsonb)-'source_job_binding';
     e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('attribution_hint'$b$),
$b$owned_keys constant text[]:=ARRAY['payload_job_guess','placement_rule',$b$,
$b$owned_keys constant text[]:=ARRAY['placement_rule',$b$),
$b$
 writer_job uuid;
BEGIN
 rules_on:=$b$,
$b$
BEGIN
 rules_on:=$b$))<>'90c038b5f48677af4598e475e2583572'
 THEN RAISE EXCEPTION 'l1e: the rules ladder is not L1d''s body plus the L1e edits'; END IF;
 -- The entry, the insert trigger and the repair are untouched.
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure)<>'32365101d23dde1695707a0bddff640b'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.attribute_business_event()'::regprocedure)<>'d0036a1bc36f4b2a779f4a8b192cd687'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_payload_job_repair(boolean,integer)'::regprocedure)<>'db0412566058df9e27a070472abb5482'
 THEN RAISE EXCEPTION 'l1e: the ladder entry, the insert trigger or the repair changed'; END IF;
 -- Marked L1e: L1d's guard refuses to re-apply over them.
 FOREACH f IN ARRAY ARRAY['public.context_ladder_p1a(public.business_events,boolean)','public.resolve_context_attribution(public.business_events,boolean,boolean)',
  'public.context_event_writer_job(public.business_events)','public.context_payload_job_is_guess(public.business_events)'] LOOP
  IF coalesce(obj_description(f::regprocedure,'pg_proc'),'') NOT LIKE 'L1e:%' THEN RAISE EXCEPTION 'l1e: % is not marked L1e',f; END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(r,f,'EXECUTE') THEN RAISE EXCEPTION 'l1e: % can call private %',r,f; END IF;
  END LOOP;
 END LOOP;
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF has_function_privilege(r,'public.context_payload_job_mismatch_rows()','EXECUTE') THEN RAISE EXCEPTION 'l1e: % can call the repair classifier',r; END IF;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.context_payload_job_mismatch_rows()','EXECUTE')
  OR NOT has_function_privilege('service_role','public.resolve_context_attribution(public.business_events)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_attribution_preview(uuid,boolean)','EXECUTE')
 THEN RAISE EXCEPTION 'l1e: the service role lost the classifier, the ladder entry or the preview'; END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name='context_unlinked_rules_v1' AND NOT enabled)<>1
 THEN RAISE EXCEPTION 'l1e: the rules flag must stay off'; END IF;
END $$;

-- Re-apply is a no-op.
CREATE TEMP TABLE l1e_before AS SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5, obj_description(p.oid,'pg_proc') AS note
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  AND p.proname IN ('context_ladder_p1a','resolve_context_attribution','context_event_writer_job','context_payload_job_is_guess','context_payload_job_mismatch_rows');
\ir ../../../migrations/20261005170000_context_ladder_writer_job.sql
DO $$
BEGIN
 IF (SELECT count(*) FROM l1e_before)<>6 THEN RAISE EXCEPTION 'l1e: expected 6 functions, got %',(SELECT count(*) FROM l1e_before); END IF;
 IF EXISTS(SELECT 1 FROM l1e_before b LEFT JOIN pg_proc p ON p.oid=b.sig::regprocedure
   WHERE md5(p.prosrc) IS DISTINCT FROM b.md5 OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note)
 THEN RAISE EXCEPTION 'l1e: re-apply changed a body or comment'; END IF;
END $$;
DROP TABLE l1e_before;
\endif
