-- Ladder L1d contract (20261005090000). Every fixture write is rolled back.
-- Ids, job numbers, contacts and text are synthetic.
--
-- Proves, with the rules flag off (as shipped) and on:
--   A. A crew text (outbound, a known contact who is not the job's customer,
--      the job number in its words) stays ON that job as internal
--      communication: direct, step 1, ladder_ref, matched, placement_rule
--      internal_ref, recipient_role crew, recipient_role_source wording,
--      audience internal, no candidates. Staff wording reads staff; any other
--      wording reads other (source contact, audience other_party). Preview
--      and a re-decision agree; Luna refuses it. A ladder-derived role is
--      derived again: once the contact becomes the job's customer, a
--      re-decision places the row as a customer message with no label.
--   B. The same words to the job's customer, or to a party on the job, still
--      place on the job with no label. Inbound words from the crew contact,
--      an outbound row with no contact and two references are unchanged.
--   C. A service-role outbound row marked recipient_role crew or staff stays
--      on the job it is about: metadata.about_job_id first (about_job_id),
--      else its one reference (ladder_ref), labelled internal_recipient,
--      audience internal, recipient_role_source writer, the writer's role
--      kept. A holding about job is not used. With no job named it rests off
--      every job as automated, still labelled. A writer job (custody) does
--      not make it a customer message. A re-decision keeps it.
--   D. The marker is ignored from any other writer and on an inbound row.
--   E. Structure: both bodies are L1c's with exactly these two rules
--      replaced, the helpers are private, the bodies are marked L1d so L1c's
--      re-apply refuses, and a re-apply of this migration is a no-op.
\set ON_ERROR_STOP 1

CREATE FUNCTION pg_temp.ct_job(p_number text,p_contact text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing',p_number,p_contact,now()-interval '60 days');
 RETURN j;
END $$;

-- One GHL text through the real insert trigger; the ladder decides it.
CREATE FUNCTION pg_temp.ct_ev(p_contact text,p_direction text,p_body text,p_meta jsonb DEFAULT '{}'::jsonb,
 p_job uuid DEFAULT NULL,p_method text DEFAULT NULL) RETURNS public.business_events LANGUAGE plpgsql AS $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(job_id,match_method,contact_id,entity_type,entity_id,direction,channel,event_type,source,
  provider_message_id,payload,metadata,occurred_at,event_at)
  VALUES(p_job,p_method,p_contact,'contact',p_contact,p_direction,'sms',
   CASE WHEN p_direction='outbound' THEN 'client.sms_out' ELSE 'client.reply' END,'ghl-proxy',
   'ghl:ct'||replace(gen_random_uuid()::text,'-',''),
   jsonb_build_object('body',p_body,'text',p_body,'message',p_body,'direction',p_direction,'channel','sms','ghl_contact_id',p_contact),
   p_meta||'{"capture_mode":"live"}',now()-interval '1 day',now()-interval '1 day')
  RETURNING * INTO e;
 RETURN e;
END $$;

-- Placed on p_job as internal communication with the given label.
CREATE FUNCTION pg_temp.ct_internal(lbl text,what text,e public.business_events,p_job uuid,p_method text,p_rule text,
 p_role text,p_source text,p_audience text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF e.job_id IS DISTINCT FROM p_job OR e.attribution_status<>'direct' OR e.attribution_step<>1
  OR e.match_status<>'matched' OR e.match_method IS DISTINCT FROM p_method OR e.match_confidence<>1
  OR e.attribution_confidence<>1 OR e.attributed_at IS NULL OR e.candidate_job_ids IS NOT NULL
  OR e.metadata->>'placement_rule' IS DISTINCT FROM p_rule OR e.metadata->>'recipient_role' IS DISTINCT FROM p_role
  OR e.metadata->>'recipient_role_source' IS DISTINCT FROM p_source OR e.metadata->>'audience' IS DISTINCT FROM p_audience
 THEN RAISE EXCEPTION 'l1d %: % must stay on its job as internal communication (% % % %), got % % % % %',
  lbl,what,p_method,p_rule,p_role,p_audience,e.attribution_status,e.job_id,e.match_method,e.candidate_job_ids,e.metadata; END IF;
END $$;

CREATE FUNCTION pg_temp.ct_cases(p_rules_on boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE lbl text:=CASE WHEN p_rules_on THEN 'rules on' ELSE 'rules off' END;
 j1 uuid; j2 uuid; jh uuid; e public.business_events; crew public.business_events; s public.business_events; p jsonb; luna_err text;
 words text; placed_method text:=CASE WHEN p_rules_on THEN 'ladder_ref' ELSE 'direct_job_id' END; r text;
 multi_status text:=CASE WHEN p_rules_on THEN 'unplaced' ELSE 'admin_bucket' END; threads bigint;
BEGIN
 UPDATE public.feature_flags SET enabled=p_rules_on,updated_at=clock_timestamp() WHERE flag_name='context_unlinked_rules_v1';
 IF public.context_unlinked_rules_enabled() IS DISTINCT FROM p_rules_on THEN RAISE EXCEPTION 'l1d fixture: flag not %',lbl; END IF;
 j1:=pg_temp.ct_job('SWF-990001','ct-cust');
 j2:=pg_temp.ct_job('SWF-990002','ct-cust2');
 jh:=pg_temp.ct_job('SWF-990003','ct-cust3');
 UPDATE public.jobs SET metadata=coalesce(metadata,'{}'::jsonb)||'{"do_not_schedule":"true"}' WHERE id=jh;
 INSERT INTO public.job_contacts(job_id,contact_type,client_name,ghl_contact_id) VALUES(j1,'neighbour_b','Fixture Neighbour','ct-nb');
 words:=E'New job assigned: SWF-990001 - Fixture Client\nSite: 1 Fixture St, Fixtureville\nDate: 2026-10-09';
 SELECT count(*) INTO threads FROM public.event_threads;

 -- A. The crew text stays on the job, labelled internal.
 crew:=pg_temp.ct_ev('ct-crew','outbound',words);
 PERFORM pg_temp.ct_internal(lbl,'a crew text by job number',crew,j1,'ladder_ref','internal_ref','crew','wording','internal');
 p:=public.context_attribution_preview(crew.id,p_rules_on);
 IF p->'decided'->>'job_id' IS DISTINCT FROM j1::text OR p->'decided'->>'attribution_status'<>'direct'
  OR p->'decided'->>'placement_rule' IS DISTINCT FROM 'internal_ref'
 THEN RAISE EXCEPTION 'l1d %: preview must keep the crew text on its job as internal, got %',lbl,p; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=crew.id;
 s:=public.resolve_context_attribution(e);
 PERFORM pg_temp.ct_internal(lbl,'a re-decided crew text',s,j1,'ladder_ref','internal_ref','crew','wording','internal');
 BEGIN
  PERFORM public.attribute_context_event_with_luna(crew.id,j1,0.9,'job');
  luna_err:=NULL;
 EXCEPTION WHEN OTHERS THEN luna_err:=SQLERRM;
 END;
 IF luna_err IS DISTINCT FROM 'event is not pending Luna' THEN RAISE EXCEPTION 'l1d %: Luna must refuse a crew text, got %',lbl,coalesce(luna_err,'a placement'); END IF;
 e:=pg_temp.ct_ev('ct-staff','outbound',E'Docs Ready: SWF-990001 Fixture Client\nDocket awaits your press.');
 PERFORM pg_temp.ct_internal(lbl,'a staff text by job number',e,j1,'ladder_ref','internal_ref','staff','wording','internal');
 e:=pg_temp.ct_ev('ct-other','outbound','Hi mate, SWF-990001 is on Thursday');
 PERFORM pg_temp.ct_internal(lbl,'a text to another contact by job number',e,j1,'ladder_ref','internal_ref','other','contact','other_party');
 IF (SELECT count(*) FROM public.event_threads)<>threads THEN RAISE EXCEPTION 'l1d %: an internal text bound a thread',lbl; END IF;
 -- A derived role is derived again: the contact is now the job's customer.
 UPDATE public.jobs SET ghl_contact_id='ct-other' WHERE id=j1;
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 s:=public.resolve_context_attribution(e);
 IF s.job_id IS DISTINCT FROM j1 OR s.attribution_status<>'direct' OR s.metadata ?| ARRAY['recipient_role','recipient_role_source','audience']
  OR s.metadata->>'placement_rule' IS NOT DISTINCT FROM 'internal_ref'
 THEN RAISE EXCEPTION 'l1d %: a stale derived role survived a re-decision, got % % %',lbl,s.attribution_status,s.job_id,s.metadata; END IF;
 UPDATE public.jobs SET ghl_contact_id='ct-cust' WHERE id=j1;

 -- B. Controls: the customer and a party still place, unlabelled; inbound and contactless are unchanged.
 FOREACH r IN ARRAY ARRAY['ct-cust','ct-nb'] LOOP
  e:=pg_temp.ct_ev(r,'outbound',words);
  IF e.job_id IS DISTINCT FROM j1 OR e.attribution_status<>'direct' OR e.attribution_step<>1 OR e.match_method<>placed_method
   OR e.match_status<>'matched' OR e.metadata ?| ARRAY['recipient_role','recipient_role_source','audience']
  THEN RAISE EXCEPTION 'l1d %: our text to % must still place on its job unlabelled, got % % % %',lbl,r,e.attribution_status,e.job_id,e.match_method,e.metadata; END IF;
 END LOOP;
 e:=pg_temp.ct_ev('ct-crew','inbound','Running late to SWF-990001 today');
 IF e.job_id IS DISTINCT FROM j1 OR e.attribution_status<>'direct' OR e.metadata ? 'audience'
 THEN RAISE EXCEPTION 'l1d %: an inbound reference must be unchanged, got % %',lbl,e.attribution_status,e.job_id; END IF;
 e:=pg_temp.ct_ev(NULL,'outbound',words);
 IF e.job_id IS DISTINCT FROM j1 OR e.attribution_status<>'direct' OR e.metadata ? 'audience'
 THEN RAISE EXCEPTION 'l1d %: an outbound reference with no contact must be unchanged, got % %',lbl,e.attribution_status,e.job_id; END IF;
 e:=pg_temp.ct_ev('ct-crew','outbound','Swap SWF-990001 and SWF-990002');
 IF e.job_id IS NOT NULL OR e.attribution_status<>multi_status
  OR (p_rules_on AND e.metadata->>'placement_rule' IS DISTINCT FROM 'multi_ref')
 THEN RAISE EXCEPTION 'l1d %: two references must stay as before, got % % %',lbl,e.attribution_status,e.job_id,e.metadata; END IF;

 -- C. The writer marker: on the job it is about, labelled internal.
 FOREACH r IN ARRAY ARRAY['crew','staff'] LOOP
  -- about_job_id wins over the words (which name another job).
  e:=pg_temp.ct_ev('ct-crew','outbound','Swap to SWF-990002 tomorrow',jsonb_build_object('recipient_role',r,'about_job_id',j1));
  PERFORM pg_temp.ct_internal(lbl,'a marked '||r||' text',e,j1,'about_job_id','internal_recipient',r,'writer','internal');
  IF e.metadata->>'about_job_id' IS DISTINCT FROM j1::text THEN RAISE EXCEPTION 'l1d %: the writer''s about_job_id was lost',lbl; END IF;
  SELECT * INTO e FROM public.business_events WHERE id=e.id;
  s:=public.resolve_context_attribution(e);
  PERFORM pg_temp.ct_internal(lbl,'a re-decided marked '||r||' text',s,j1,'about_job_id','internal_recipient',r,'writer','internal');
  -- No about_job_id: its one reference.
  e:=pg_temp.ct_ev('ct-crew','outbound',words,jsonb_build_object('recipient_role',r));
  PERFORM pg_temp.ct_internal(lbl,'a marked '||r||' text with no about job',e,j1,'ladder_ref','internal_recipient',r,'writer','internal');
  -- Nothing named: off every job, still labelled.
  e:=pg_temp.ct_ev('ct-crew','outbound','Can you call the office',jsonb_build_object('recipient_role',r));
  IF e.job_id IS NOT NULL OR e.attribution_status<>'automated' OR e.metadata->>'placement_rule' IS DISTINCT FROM 'internal_recipient'
   OR e.metadata->>'audience' IS DISTINCT FROM 'internal' OR e.metadata->>'recipient_role' IS DISTINCT FROM r
   OR e.match_status<>'unresolved' OR e.match_method<>'none' OR e.candidate_job_ids IS NOT NULL
  THEN RAISE EXCEPTION 'l1d %: a marked % text naming no job must rest off every job labelled, got % % %',lbl,r,e.attribution_status,e.job_id,e.metadata; END IF;
 END LOOP;
 -- A holding about job is not used; a malformed one is ignored.
 e:=pg_temp.ct_ev('ct-crew','outbound','Can you call the office',jsonb_build_object('recipient_role','crew','about_job_id',jh));
 IF e.job_id IS NOT NULL OR e.attribution_status<>'automated'
 THEN RAISE EXCEPTION 'l1d %: a holding about job must not place, got % %',lbl,e.attribution_status,e.job_id; END IF;
 e:=pg_temp.ct_ev('ct-crew','outbound',words,'{"recipient_role":"crew","about_job_id":"not-a-uuid"}');
 PERFORM pg_temp.ct_internal(lbl,'a marked text with a malformed about job',e,j1,'ladder_ref','internal_recipient','crew','writer','internal');
 -- Even sent to the job's own contact with a writer job (custody), a marked text is internal.
 e:=pg_temp.ct_ev('ct-cust','outbound',words,'{"recipient_role":"staff"}',j1,'direct_job_id');
 PERFORM pg_temp.ct_internal(lbl,'a marked text with a writer job',e,j1,'ladder_ref','internal_recipient','staff','writer','internal');

 -- D. The marker counts only from the service role, and only outbound.
 e:=pg_temp.ct_ev('ct-cust','inbound','About SWF-990001',jsonb_build_object('recipient_role','crew'));
 IF e.job_id IS DISTINCT FROM j1 OR e.attribution_status<>'direct' OR e.metadata ? 'audience'
 THEN RAISE EXCEPTION 'l1d %: an inbound row''s marker must be ignored, got % %',lbl,e.attribution_status,e.job_id; END IF;
 PERFORM set_config('request.jwt.claims','{"role":"authenticated"}',true);
 e:=pg_temp.ct_ev('ct-cust','outbound',words,jsonb_build_object('recipient_role','crew'));
 PERFORM set_config('request.jwt.claims','',true);
 IF e.metadata->>'placement_rule'='internal_recipient' OR e.metadata ? 'audience' OR e.metadata->>'written_as'<>'authenticated'
 THEN RAISE EXCEPTION 'l1d %: another writer''s marker must be ignored, got % %',lbl,e.attribution_status,e.metadata; END IF;
END $$;

BEGIN;
SELECT pg_temp.ct_cases(false);
ROLLBACK;
BEGIN;
SELECT pg_temp.ct_cases(true);
ROLLBACK;

-- E. Structure. A registered successor (L1e 20261005100000) proves in its own
-- contract that its ladder bodies are exactly these plus its edits; while it is
-- live only the two helpers are checked here, and the re-apply is skipped
-- (L1d's guard refuses to re-apply over L1e's bodies).
SELECT coalesce(obj_description(to_regprocedure('public.context_ladder_p1a(public.business_events,boolean)'),'pg_proc'),'') LIKE 'L1e:%' AS l1e_live \gset
\if :l1e_live
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_internal_text_role(public.business_events)'::regprocedure)<>'e7327d108966e2bcb9d2eb48e3086a55'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_internal_about_job(public.business_events)'::regprocedure)<>'aa53618f6c82998a821b8f7439c75e60'
  OR coalesce(obj_description('public.context_internal_text_role(public.business_events)'::regprocedure,'pg_proc'),'') NOT LIKE 'L1d:%'
  OR coalesce(obj_description('public.context_internal_about_job(public.business_events)'::regprocedure,'pg_proc'),'') NOT LIKE 'L1d:%'
 THEN RAISE EXCEPTION 'l1d: a helper is not this migration''s'; END IF;
END $$;
\else
DO $$
DECLARE f text; r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'e11321e9d986be1e83f05e95f3efc36c'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure)<>'90c038b5f48677af4598e475e2583572'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_internal_text_role(public.business_events)'::regprocedure)<>'e7327d108966e2bcb9d2eb48e3086a55'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_internal_about_job(public.business_events)'::regprocedure)<>'aa53618f6c82998a821b8f7439c75e60'
 THEN RAISE EXCEPTION 'l1d: a body is not this migration''s'; END IF;
 -- Putting L1c's two rules back gives back L1c's bodies byte for byte.
 IF md5(replace(replace(replace((SELECT prosrc FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure),
$b$used_updated_at boolean; rule text; irole text;
BEGIN
 prior_status:=e.attribution_status;$b$,
$b$used_updated_at boolean; rule text;
BEGIN
 prior_status:=e.attribution_status;$b$),
$b$ -- L1d (20261005090000): a text our own tool sent to crew or staff (writer
 -- marker metadata.recipient_role crew or staff on an outbound row written by
 -- the service role) is internal job communication, never a customer
 -- message. It stays ON the job it is about (metadata.about_job_id, else the
 -- one job its words name): direct, step 1, placement_rule
 -- internal_recipient, audience internal, recipient_role_source writer,
 -- match_method about_job_id or ladder_ref. It binds no thread. With no such
 -- job it rests off every job as automated, still labelled.
 IF e.direction='outbound' AND e.metadata->>'recipient_role' IN ('crew','staff') AND e.metadata->>'written_as'='service_role' THEN
  e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','internal_recipient','audience','internal','recipient_role_source','writer');
  SELECT a.job_id,a.match_method INTO e.job_id,e.match_method FROM public.context_internal_about_job(e) a;
  IF e.job_id IS NULL THEN e.attribution_status:='automated'; e.match_method:='none'; RETURN e; END IF;
  e.attribution_status:='direct'; e.attribution_step:=1; e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
  e.match_status:='matched'; e.match_confidence:=1;
  RETURN e;
 END IF;
$b$,
$b$ -- L1c (20261004200000): a text our own tool sent to crew or staff (writer
 -- marker metadata.recipient_role crew or staff on an outbound row written by
 -- the service role) is never a customer message: it rests off every job as
 -- automated, placement_rule staff_recipient.
 IF e.direction='outbound' AND e.metadata->>'recipient_role' IN ('crew','staff') AND e.metadata->>'written_as'='service_role' THEN
  e.job_id:=NULL; e.attribution_status:='automated';
  e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','staff_recipient');
  RETURN e;
 END IF;
$b$),
$b$   -- L1d (20261005090000): a reference alone never makes an outbound row to
   -- a known contact who is not that job's customer (nor a party on it) a
   -- message to the customer. It stays ON the job as internal communication
   -- (direct, step 1, match_method ladder_ref, placement_rule internal_ref),
   -- labelled with who it went to: recipient_role crew or staff when its
   -- words are one of our crew or staff templates (recipient_role_source
   -- wording, audience internal), else other (recipient_role_source contact,
   -- audience other_party). It binds no thread.
   IF candidate IS NOT NULL AND NOT public.context_ref_recipient_is_customer(e,candidate) THEN
    irole:=public.context_internal_text_role(e);
    e.job_id:=candidate; e.attribution_status:='direct'; e.attribution_step:=1;
    e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
    e.match_status:='matched'; e.match_method:='ladder_ref'; e.match_confidence:=1;
    e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','internal_ref','recipient_role',irole,
     'recipient_role_source',CASE WHEN irole='other' THEN 'contact' ELSE 'wording' END,'audience',CASE WHEN irole='other' THEN 'other_party' ELSE 'internal' END);
    RETURN e;
   END IF;
$b$,
$b$   -- L1c (20261004200000): a reference alone never makes an outbound row to
   -- a known contact who is not that job's customer (nor a party on it) a
   -- message to the customer. It stays for review (unplaced, the job as the
   -- one candidate, placement_rule ref_not_customer).
   IF candidate IS NOT NULL AND NOT public.context_ref_recipient_is_customer(e,candidate) THEN
    e.job_id:=NULL; e.attribution_status:='unplaced'; e.attribution_step:=1; e.candidate_job_ids:=ARRAY[candidate];
    e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','ref_not_customer');
    RETURN e;
   END IF;
$b$))<>'b7d991654bd7d4f2a00136be29ad8fc9'
 THEN RAISE EXCEPTION 'l1d: context_ladder_p1a is not L1c''s body with the two rules replaced'; END IF;
 IF md5(replace(replace(replace(replace(replace((SELECT prosrc FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure),
$b$ unpaid_ids uuid[]; window_ids uuid[]; review_ids uuid[]; n int; irole text;
$b$,
$b$ unpaid_ids uuid[]; window_ids uuid[]; review_ids uuid[]; n int;
$b$),
$b$'placement_site_keys','placement_retired_binding','placement_preview_bindings','supplier_ref_conflicts','aftercare_unpaid_job_ids',
  'audience','recipient_role_source'];$b$,
$b$'placement_site_keys','placement_retired_binding','placement_preview_bindings','supplier_ref_conflicts','aftercare_unpaid_job_ids'];$b$),
$b$ p_preview:=coalesce(p_preview,false);
 -- L1d (20261005090000): a recipient role the ladder derived (from the words
 -- or the contact) is derived again on every decision; a writer's is kept.
 IF e.metadata->>'recipient_role_source' IN ('wording','contact') THEN e.metadata:=e.metadata-'recipient_role'; END IF;
 IF e.metadata ?| owned_keys THEN$b$,
$b$ p_preview:=coalesce(p_preview,false);
 IF e.metadata ?| owned_keys THEN$b$),
$b$   -- L1d (20261005090000): a text our own tool sent to crew or staff is
   -- internal job communication on the job it is about (internal_recipient),
   -- as on the rules-off path.
   IF e.direction='outbound' AND e.metadata->>'recipient_role' IN ('crew','staff') AND e.metadata->>'written_as'='service_role' THEN
    e.metadata:=e.metadata||jsonb_build_object('placement_rule','internal_recipient','audience','internal','recipient_role_source','writer');
    SELECT a.job_id,a.match_method INTO e.job_id,e.match_method FROM public.context_internal_about_job(e) a;
    IF e.job_id IS NULL THEN e.attribution_status:='automated'; e.match_method:='none'; EXIT rules; END IF;
    e.attribution_status:='direct'; e.attribution_step:=1; e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
    e.match_status:='matched'; e.match_confidence:=1;
    EXIT rules;
   END IF;
$b$,
$b$   -- L1c (20261004200000): a text our own tool sent to crew or staff is never
   -- a customer message (automated, staff_recipient), as on the rules-off path.
   IF e.direction='outbound' AND e.metadata->>'recipient_role' IN ('crew','staff') AND e.metadata->>'written_as'='service_role' THEN
    e.attribution_status:='automated'; e.job_id:=NULL;
    e.metadata:=e.metadata||jsonb_build_object('placement_rule','staff_recipient');
    EXIT rules;
   END IF;
$b$),
$b$    -- L1d (20261005090000): a reference alone never makes an outbound row to
    -- a known contact who is not that job's customer or party a message to
    -- the customer; it stays ON the job as internal communication
    -- (internal_ref), labelled with who it went to, as on the rules-off path.
    IF cardinality(ref_ids)=1 AND NOT public.context_ref_recipient_is_customer(e,ref_ids[1]) THEN
     irole:=public.context_internal_text_role(e);
     e.job_id:=ref_ids[1]; e.attribution_status:='direct'; e.attribution_step:=1;
     e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
     e.match_status:='matched'; e.match_method:='ladder_ref'; e.match_confidence:=1;
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','internal_ref','recipient_role',irole,
      'recipient_role_source',CASE WHEN irole='other' THEN 'contact' ELSE 'wording' END,'audience',CASE WHEN irole='other' THEN 'other_party' ELSE 'internal' END);
     EXIT rules;
    ELSIF cardinality(ref_ids)=1 THEN
$b$,
$b$    -- L1c (20261004200000): a reference alone never makes an outbound row to
    -- a known contact who is not that job's customer or party a message to
    -- the customer; it stays for review (unplaced, ref_not_customer).
    IF cardinality(ref_ids)=1 AND NOT public.context_ref_recipient_is_customer(e,ref_ids[1]) THEN
     e.attribution_status:='unplaced'; e.attribution_step:=1; e.candidate_job_ids:=ref_ids;
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','ref_not_customer');
     EXIT rules;
    ELSIF cardinality(ref_ids)=1 THEN
$b$))<>'9a94bf772e45b23f7f4ffe725a804fc6'
 THEN RAISE EXCEPTION 'l1d: the rules ladder is not L1c''s body with the two rules replaced'; END IF;
 -- The entry, the insert trigger and L1c's customer test are untouched.
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure)<>'32365101d23dde1695707a0bddff640b'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.attribute_business_event()'::regprocedure)<>'d0036a1bc36f4b2a779f4a8b192cd687'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ref_recipient_is_customer(public.business_events,uuid)'::regprocedure)<>'18904e5439afd9c23e59e97f200d256e'
 THEN RAISE EXCEPTION 'l1d: the ladder entry, insert trigger or customer test changed'; END IF;
 -- Marked L1d: L1c's guard refuses to re-apply over them.
 FOREACH f IN ARRAY ARRAY['public.context_ladder_p1a(public.business_events,boolean)','public.resolve_context_attribution(public.business_events,boolean,boolean)',
  'public.context_internal_text_role(public.business_events)','public.context_internal_about_job(public.business_events)'] LOOP
  IF coalesce(obj_description(f::regprocedure,'pg_proc'),'') NOT LIKE 'L1d:%' THEN RAISE EXCEPTION 'l1d: % is not marked L1d',f; END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(r,f,'EXECUTE') THEN RAISE EXCEPTION 'l1d: % can call private %',r,f; END IF;
  END LOOP;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.resolve_context_attribution(public.business_events)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_attribution_preview(uuid,boolean)','EXECUTE')
 THEN RAISE EXCEPTION 'l1d: the service role lost the ladder entry or the preview'; END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name='context_unlinked_rules_v1' AND NOT enabled)<>1
 THEN RAISE EXCEPTION 'l1d: the rules flag must stay off'; END IF;
END $$;

-- Re-apply is a no-op.
CREATE TEMP TABLE l1d_before AS SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5, obj_description(p.oid,'pg_proc') AS note
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  AND p.proname IN ('context_ladder_p1a','resolve_context_attribution','context_internal_text_role','context_internal_about_job');
\ir ../../../migrations/20261005090000_context_ladder_internal_text.sql
DO $$
BEGIN
 IF (SELECT count(*) FROM l1d_before)<>5 THEN RAISE EXCEPTION 'l1d: expected 5 functions, got %',(SELECT count(*) FROM l1d_before); END IF;
 IF EXISTS(SELECT 1 FROM l1d_before b LEFT JOIN pg_proc p ON p.oid=b.sig::regprocedure
   WHERE md5(p.prosrc) IS DISTINCT FROM b.md5 OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note)
 THEN RAISE EXCEPTION 'l1d: re-apply changed a body or comment'; END IF;
END $$;
DROP TABLE l1d_before;
\endif
