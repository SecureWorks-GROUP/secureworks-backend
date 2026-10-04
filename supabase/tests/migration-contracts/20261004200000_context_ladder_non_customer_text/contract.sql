-- Ladder L1c contract (20261004200000). Every fixture write is rolled back.
-- Ids, job numbers, contacts and text are synthetic.
--
-- Proves, with the rules flag off (as shipped) and on:
--   A. A crew assignment text (outbound, a known contact who is not the job's
--      customer, the job number in its words) stays for review: unplaced,
--      step 1, the job as its one candidate, ref_not_customer, unresolved.
--      Preview and a re-decision agree; Luna refuses it.
--   B. The same words to the job's customer, or to a party on the job, still
--      place on the job. Inbound words from the crew contact and an outbound
--      row with no contact are unchanged (still placed by the reference).
--   C. A service-role outbound row marked recipient_role crew or staff rests
--      off every job (automated, staff_recipient), even with a writer job, and
--      keeps the writer's about_job_id. A re-decision keeps it there.
--   D. The marker is ignored from any other writer and on an inbound row.
--   E. Structure: both bodies are L1b's plus exactly these rules, the helper
--      is private, the bodies are marked L1c so L1b's re-apply refuses, and a
--      re-apply of this migration is a no-op.
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

CREATE FUNCTION pg_temp.ct_cases(p_rules_on boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE lbl text:=CASE WHEN p_rules_on THEN 'rules on' ELSE 'rules off' END;
 j1 uuid; j2 uuid; e public.business_events; crew public.business_events; s public.business_events; p jsonb; luna_err text;
 words text; placed_method text:=CASE WHEN p_rules_on THEN 'ladder_ref' ELSE 'direct_job_id' END; r text;
 multi_status text:=CASE WHEN p_rules_on THEN 'unplaced' ELSE 'admin_bucket' END;
BEGIN
 UPDATE public.feature_flags SET enabled=p_rules_on,updated_at=clock_timestamp() WHERE flag_name='context_unlinked_rules_v1';
 IF public.context_unlinked_rules_enabled() IS DISTINCT FROM p_rules_on THEN RAISE EXCEPTION 'l1c fixture: flag not %',lbl; END IF;
 j1:=pg_temp.ct_job('SWF-990001','ct-cust');
 j2:=pg_temp.ct_job('SWF-990002','ct-cust2');
 INSERT INTO public.job_contacts(job_id,contact_type,client_name,ghl_contact_id) VALUES(j1,'neighbour_b','Fixture Neighbour','ct-nb');
 words:=E'New job assigned: SWF-990001 - Fixture Client\nSite: 1 Fixture St, Fixtureville\nDate: 2026-10-09';

 -- A. The crew text stays for review.
 crew:=pg_temp.ct_ev('ct-crew','outbound',words);
 IF crew.job_id IS NOT NULL OR crew.attribution_status<>'unplaced' OR crew.attribution_step<>1
  OR crew.candidate_job_ids IS DISTINCT FROM ARRAY[j1] OR crew.metadata->>'placement_rule' IS DISTINCT FROM 'ref_not_customer'
  OR crew.match_status<>'unresolved' OR crew.match_method<>'none' OR crew.match_confidence IS NOT NULL
  OR crew.attribution_confidence IS NOT NULL OR crew.attributed_at IS NOT NULL
 THEN RAISE EXCEPTION 'l1c %: a crew text by job number must not land on the customer''s job, got % % % % %',
  lbl,crew.attribution_status,crew.job_id,crew.match_method,crew.candidate_job_ids,crew.metadata; END IF;
 p:=public.context_attribution_preview(crew.id,p_rules_on);
 IF p->'decided'->>'job_id' IS NOT NULL OR p->'decided'->>'attribution_status'<>'unplaced'
  OR p->'decided'->>'placement_rule' IS DISTINCT FROM 'ref_not_customer'
 THEN RAISE EXCEPTION 'l1c %: preview must keep the crew text for review, got %',lbl,p; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=crew.id;
 s:=public.resolve_context_attribution(e);
 IF s.job_id IS NOT NULL OR s.attribution_status<>'unplaced' OR s.metadata->>'placement_rule' IS DISTINCT FROM 'ref_not_customer'
 THEN RAISE EXCEPTION 'l1c %: a re-decision placed the crew text, got % %',lbl,s.attribution_status,s.job_id; END IF;
 BEGIN
  PERFORM public.attribute_context_event_with_luna(crew.id,j1,0.9,'job');
  luna_err:=NULL;
 EXCEPTION WHEN OTHERS THEN luna_err:=SQLERRM;
 END;
 IF luna_err IS DISTINCT FROM 'event is not pending Luna' THEN RAISE EXCEPTION 'l1c %: Luna must refuse a crew text, got %',lbl,coalesce(luna_err,'a placement'); END IF;

 -- B. Controls: the customer and a party still place; inbound and contactless are unchanged.
 FOREACH r IN ARRAY ARRAY['ct-cust','ct-nb'] LOOP
  e:=pg_temp.ct_ev(r,'outbound',words);
  IF e.job_id IS DISTINCT FROM j1 OR e.attribution_status<>'direct' OR e.attribution_step<>1 OR e.match_method<>placed_method
   OR e.match_status<>'matched'
  THEN RAISE EXCEPTION 'l1c %: our text to % must still place on its job, got % % %',lbl,r,e.attribution_status,e.job_id,e.match_method; END IF;
 END LOOP;
 e:=pg_temp.ct_ev('ct-crew','inbound','Running late to SWF-990001 today');
 IF e.job_id IS DISTINCT FROM j1 OR e.attribution_status<>'direct'
 THEN RAISE EXCEPTION 'l1c %: an inbound reference must be unchanged, got % %',lbl,e.attribution_status,e.job_id; END IF;
 e:=pg_temp.ct_ev(NULL,'outbound',words);
 IF e.job_id IS DISTINCT FROM j1 OR e.attribution_status<>'direct'
 THEN RAISE EXCEPTION 'l1c %: an outbound reference with no contact must be unchanged, got % %',lbl,e.attribution_status,e.job_id; END IF;
 -- Two references are already for review, unchanged.
 e:=pg_temp.ct_ev('ct-crew','outbound','Swap SWF-990001 and SWF-990002');
 IF e.job_id IS NOT NULL OR e.attribution_status<>multi_status
  OR (p_rules_on AND e.metadata->>'placement_rule' IS DISTINCT FROM 'multi_ref')
 THEN RAISE EXCEPTION 'l1c %: two references must stay as before, got % % %',lbl,e.attribution_status,e.job_id,e.metadata; END IF;

 -- C. The writer marker: off every job, whatever the writer job or the words.
 FOREACH r IN ARRAY ARRAY['crew','staff'] LOOP
  e:=pg_temp.ct_ev('ct-crew','outbound',words,jsonb_build_object('recipient_role',r,'about_job_id',j1));
  IF e.job_id IS NOT NULL OR e.attribution_status<>'automated' OR e.metadata->>'placement_rule' IS DISTINCT FROM 'staff_recipient'
   OR e.metadata->>'recipient_role' IS DISTINCT FROM r OR e.metadata->>'about_job_id' IS DISTINCT FROM j1::text
   OR e.match_status<>'unresolved' OR e.match_method<>'none' OR e.candidate_job_ids IS NOT NULL
  THEN RAISE EXCEPTION 'l1c %: a % text must rest off every job, got % % %',lbl,r,e.attribution_status,e.job_id,e.metadata; END IF;
  SELECT * INTO e FROM public.business_events WHERE id=e.id;
  s:=public.resolve_context_attribution(e);
  IF s.job_id IS NOT NULL OR s.attribution_status<>'automated' OR s.metadata->>'placement_rule' IS DISTINCT FROM 'staff_recipient'
  THEN RAISE EXCEPTION 'l1c %: a re-decision moved a % text, got % %',lbl,r,s.attribution_status,s.job_id; END IF;
 END LOOP;
 -- Even sent to the job's own contact with a writer job (custody), a marked text is not a customer message.
 e:=pg_temp.ct_ev('ct-cust','outbound',words,'{"recipient_role":"staff"}',j1,'direct_job_id');
 IF e.job_id IS NOT NULL OR e.attribution_status<>'automated' OR e.metadata->>'placement_rule' IS DISTINCT FROM 'staff_recipient'
 THEN RAISE EXCEPTION 'l1c %: the marker must beat custody, got % %',lbl,e.attribution_status,e.job_id; END IF;

 -- D. The marker counts only from the service role, and only outbound.
 e:=pg_temp.ct_ev('ct-cust','inbound','About SWF-990001',jsonb_build_object('recipient_role','crew'));
 IF e.job_id IS DISTINCT FROM j1 OR e.attribution_status<>'direct'
 THEN RAISE EXCEPTION 'l1c %: an inbound row''s marker must be ignored, got % %',lbl,e.attribution_status,e.job_id; END IF;
 PERFORM set_config('request.jwt.claims','{"role":"authenticated"}',true);
 e:=pg_temp.ct_ev('ct-cust','outbound',words,jsonb_build_object('recipient_role','crew'));
 PERFORM set_config('request.jwt.claims','',true);
 IF e.attribution_status='automated' OR e.metadata->>'placement_rule'='staff_recipient' OR e.metadata->>'written_as'<>'authenticated'
 THEN RAISE EXCEPTION 'l1c %: another writer''s marker must be ignored, got % %',lbl,e.attribution_status,e.metadata; END IF;
END $$;

BEGIN;
SELECT pg_temp.ct_cases(false);
ROLLBACK;
BEGIN;
SELECT pg_temp.ct_cases(true);
ROLLBACK;

-- E. Structure.
DO $$
DECLARE f text; r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'b7d991654bd7d4f2a00136be29ad8fc9'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure)<>'9a94bf772e45b23f7f4ffe725a804fc6'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ref_recipient_is_customer(public.business_events,uuid)'::regprocedure)<>'18904e5439afd9c23e59e97f200d256e'
 THEN RAISE EXCEPTION 'l1c: a body is not this migration''s'; END IF;
 -- Undoing the two rules gives back L1b's bodies byte for byte.
 IF md5(replace(replace((SELECT prosrc FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure),
$b$ -- L1c (20261004200000): a text our own tool sent to crew or staff (writer
 -- marker metadata.recipient_role crew or staff on an outbound row written by
 -- the service role) is never a customer message: it rests off every job as
 -- automated, placement_rule staff_recipient.
 IF e.direction='outbound' AND e.metadata->>'recipient_role' IN ('crew','staff') AND e.metadata->>'written_as'='service_role' THEN
  e.job_id:=NULL; e.attribution_status:='automated';
  e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','staff_recipient');
  RETURN e;
 END IF;
$b$,''),
$b$   -- L1c (20261004200000): a reference alone never makes an outbound row to
   -- a known contact who is not that job's customer (nor a party on it) a
   -- message to the customer. It stays for review (unplaced, the job as the
   -- one candidate, placement_rule ref_not_customer).
   IF candidate IS NOT NULL AND NOT public.context_ref_recipient_is_customer(e,candidate) THEN
    e.job_id:=NULL; e.attribution_status:='unplaced'; e.attribution_step:=1; e.candidate_job_ids:=ARRAY[candidate];
    e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','ref_not_customer');
    RETURN e;
   END IF;
$b$,''))<>'6a45c9ea9a68c8c5899fba45b44e18b5'
 THEN RAISE EXCEPTION 'l1c: context_ladder_p1a is not L1b''s body plus the two rules'; END IF;
 IF md5(replace(replace((SELECT prosrc FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure),
$b$   -- L1c (20261004200000): a text our own tool sent to crew or staff is never
   -- a customer message (automated, staff_recipient), as on the rules-off path.
   IF e.direction='outbound' AND e.metadata->>'recipient_role' IN ('crew','staff') AND e.metadata->>'written_as'='service_role' THEN
    e.attribution_status:='automated'; e.job_id:=NULL;
    e.metadata:=e.metadata||jsonb_build_object('placement_rule','staff_recipient');
    EXIT rules;
   END IF;
$b$,''),
$b$    -- L1c (20261004200000): a reference alone never makes an outbound row to
    -- a known contact who is not that job's customer or party a message to
    -- the customer; it stays for review (unplaced, ref_not_customer).
    IF cardinality(ref_ids)=1 AND NOT public.context_ref_recipient_is_customer(e,ref_ids[1]) THEN
     e.attribution_status:='unplaced'; e.attribution_step:=1; e.candidate_job_ids:=ref_ids;
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','ref_not_customer');
     EXIT rules;
    ELSIF cardinality(ref_ids)=1 THEN
$b$,$b$    IF cardinality(ref_ids)=1 THEN
$b$))<>'a0205f1a17ae9866ca4c8e57ff2746e4'
 THEN RAISE EXCEPTION 'l1c: the rules ladder is not L1b''s body plus the two rules'; END IF;
 -- The entry and the insert trigger are P4's and untouched.
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure)<>'32365101d23dde1695707a0bddff640b'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.attribute_business_event()'::regprocedure)<>'d0036a1bc36f4b2a779f4a8b192cd687'
 THEN RAISE EXCEPTION 'l1c: the ladder entry or insert trigger changed'; END IF;
 -- Marked L1c: L1b's guard refuses to re-apply over them.
 FOREACH f IN ARRAY ARRAY['public.context_ladder_p1a(public.business_events,boolean)','public.resolve_context_attribution(public.business_events,boolean,boolean)',
  'public.context_ref_recipient_is_customer(public.business_events,uuid)'] LOOP
  IF coalesce(obj_description(f::regprocedure,'pg_proc'),'') NOT LIKE 'L1c:%' THEN RAISE EXCEPTION 'l1c: % is not marked L1c',f; END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(r,f,'EXECUTE') THEN RAISE EXCEPTION 'l1c: % can call private %',r,f; END IF;
  END LOOP;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.resolve_context_attribution(public.business_events)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_attribution_preview(uuid,boolean)','EXECUTE')
 THEN RAISE EXCEPTION 'l1c: the service role lost the ladder entry or the preview'; END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name='context_unlinked_rules_v1' AND NOT enabled)<>1
 THEN RAISE EXCEPTION 'l1c: the rules flag must stay off'; END IF;
END $$;

-- Re-apply is a no-op.
CREATE TEMP TABLE l1c_before AS SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5, obj_description(p.oid,'pg_proc') AS note
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  AND p.proname IN ('context_ladder_p1a','resolve_context_attribution','context_ref_recipient_is_customer');
\ir ../../../migrations/20261004200000_context_ladder_non_customer_text.sql
DO $$
BEGIN
 IF (SELECT count(*) FROM l1c_before)<>4 THEN RAISE EXCEPTION 'l1c: expected 4 functions, got %',(SELECT count(*) FROM l1c_before); END IF;
 IF EXISTS(SELECT 1 FROM l1c_before b LEFT JOIN pg_proc p ON p.oid=b.sig::regprocedure
   WHERE md5(p.prosrc) IS DISTINCT FROM b.md5 OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note)
 THEN RAISE EXCEPTION 'l1c: re-apply changed a body or comment'; END IF;
END $$;
DROP TABLE l1c_before;
