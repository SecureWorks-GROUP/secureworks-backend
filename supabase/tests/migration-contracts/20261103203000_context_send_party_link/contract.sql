-- C14 contract (20261103203000): a second person we text from a job is
-- that job's person. Every fixture write is rolled back. Ids, job numbers,
-- contacts, phones and words are synthetic.
--   A. A staff text from a job to a contact that matches no party links the
--      contact (job_contact_send_links); the contact's earlier text of the
--      last 30 days is decided again and lands on the job, and the next one
--      lands there too (rules on, the real insert trigger). Party B, with no
--      phone or email, is not guessed.
--   B. A contact matching a party's phone (its contact_matches row) with no
--      contact id: the party gets the id (set_job_party_ids, staff_send);
--      no link row; the contact's next text lands on the job.
--   C. Guards: a contact of another open job is not linked (receipt
--      send_link_other_open_job) and keeps placing on its own job; a party
--      holding a different contact id is never overwritten (receipt
--      send_link_party_other_contact); two matching parties are left
--      (send_link_party_ambiguous); a closed job links nothing.
--   D. Only staff sends count: a send with no user, a job_contacts uuid as
--      the contact, an inbound text and another job_events type link
--      nothing.
--   E. The placer: a live non-owner party carrying the contact makes its job
--      a candidate in both timelines (basis party); a removed party does
--      not; the rules-off candidate set (two-argument timeline) agrees.
--   F. Structure: grants, comments, the trigger, and a re-apply is a no-op.
\set ON_ERROR_STOP 1

BEGIN;
CREATE FUNCTION pg_temp.c14_flag(p_on boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE public.feature_flags SET enabled=p_on,updated_at=clock_timestamp() WHERE flag_name='context_unlinked_rules_v1';
 IF public.context_unlinked_rules_enabled() IS DISTINCT FROM p_on THEN RAISE EXCEPTION 'c14 fixture: rules flag not %',p_on; END IF;
END $$;
CREATE FUNCTION pg_temp.c14_job(p_n int,p_status text,p_owner text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,job_number,status,type,ghl_contact_id,site_address,created_at,metadata)
 VALUES(v,'00000000-0000-0000-0000-000000000001','SWF-9952'||p_n,p_status,'fencing',p_owner,p_n||' Quarry Road, Hamilton Hill WA 6163',now()-interval '20 days','{}');
 INSERT INTO public.job_contacts(job_id,contact_label,client_name,ghl_contact_id,is_primary,status,contact_type,party_role,source_party_key)
 VALUES(v,'A','Owner '||p_n,p_owner,true,'active','primary','owner','primary');
 RETURN v;
END $$;
CREATE FUNCTION pg_temp.c14_party(p_job uuid,p_label text,p_ghl text,p_phone text,p_removed boolean DEFAULT false) RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.job_contacts(job_id,contact_label,client_name,client_phone,ghl_contact_id,is_primary,status,removed_at,contact_type,party_role)
 VALUES(p_job,p_label,'Neighbour '||p_label,p_phone,p_ghl,false,CASE WHEN p_removed THEN 'removed' ELSE 'active' END,
  CASE WHEN p_removed THEN now()-interval '1 day' END,'neighbour_'||lower(p_label),'neighbour')
 RETURNING id
$$;
CREATE FUNCTION pg_temp.c14_text(p_contact text,p_at timestamptz,p_words text DEFAULT 'Got it, thanks.') RETURNS public.business_events LANGUAGE plpgsql AS $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,contact_id,payload)
 VALUES('client.reply','ghl-message-reconcile','sms','inbound',p_at,p_at,p_contact,jsonb_build_object('body',p_words,'sent_by_kind','customer'))
 RETURNING * INTO e;
 RETURN e;
END $$;
CREATE FUNCTION pg_temp.c14_send(p_job uuid,p_contact text,p_user uuid) RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.job_events(job_id,user_id,event_type,detail_json)
 VALUES(p_job,p_user,'sms_sent',jsonb_build_object('contact_id',p_contact,'message','Hi, your share is on the invoice.','message_id','c14msg'))
 RETURNING id
$$;
CREATE FUNCTION pg_temp.c14_match(p_contact text,p_phone text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 -- contact_matches carries org_id live (NOT NULL) but not in every stack shape.
 IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.contact_matches'::regclass AND attname='org_id' AND NOT attisdropped) THEN
  EXECUTE 'INSERT INTO public.contact_matches(org_id,ghl_contact_id,phone) VALUES($1,$2,$3)' USING '00000000-0000-0000-0000-000000000001'::uuid,p_contact,p_phone;
 ELSE
  INSERT INTO public.contact_matches(ghl_contact_id,phone) VALUES(p_contact,p_phone);
 END IF;
END $$;
CREATE FUNCTION pg_temp.c14_receipts(p_job uuid,p_change text) RETURNS bigint LANGUAGE sql AS $$
 SELECT count(*) FROM public.job_party_events WHERE job_id=p_job AND change=p_change
$$;

DO $$
DECLARE
 staff uuid:=gen_random_uuid(); ja uuid; jd uuid; je uuid; jf uuid; jg uuid; jh uuid; jc uuid; jk uuid;
 pb uuid; pe uuid; pf uuid; pg uuid; pr uuid; e public.business_events; early public.business_events; n bigint; r jsonb; t record;
BEGIN
 PERFORM pg_temp.c14_flag(true);
 ja:=pg_temp.c14_job(1,'order_materials','C14ownerA000001');
 pb:=pg_temp.c14_party(ja,'B',NULL,NULL);                         -- like SWF-261586 neighbour B: no contact, no phone
 jd:=pg_temp.c14_job(2,'awaiting_deposit','C14ownerD000001');      -- like SWF-261638: no second party

 ------------------------------------------------------------ A. no matching party: a link row
 early:=pg_temp.c14_text('C14neighbA00001',now()-interval '2 days','We have received it.');
 IF early.job_id IS NOT NULL OR early.metadata->>'placement_rule' IS DISTINCT FROM 'no_candidate_at_time' THEN
  RAISE EXCEPTION 'c14 A: before the send the neighbour''s text should find no job, got % %',early.job_id,early.metadata->>'placement_rule'; END IF;
 PERFORM pg_temp.c14_send(ja,'C14neighbA00001',staff);
 IF (SELECT count(*) FROM public.job_contact_send_links WHERE job_id=ja AND ghl_contact_id='C14neighbA00001' AND removed_at IS NULL
     AND source='sms_sent' AND linked_by=staff AND source_id IS NOT NULL)<>1 THEN RAISE EXCEPTION 'c14 A: texted neighbour not linked to the job'; END IF;
 IF pg_temp.c14_receipts(ja,'send_contact_linked')<>1 THEN RAISE EXCEPTION 'c14 A: no send_contact_linked receipt'; END IF;
 IF (SELECT ghl_contact_id FROM public.job_contacts WHERE id=pb) IS NOT NULL THEN RAISE EXCEPTION 'c14 A: party B was guessed'; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=early.id;
 IF e.job_id IS DISTINCT FROM ja THEN RAISE EXCEPTION 'c14 A: the earlier text was not decided again onto the job: % %',e.job_id,e.attribution_status; END IF;
 e:=pg_temp.c14_text('C14neighbA00001',now(),'Vesna has just paid the balance.');
 IF e.job_id IS DISTINCT FROM ja OR e.attribution_status<>'single_open' THEN
  RAISE EXCEPTION 'c14 A: the next text did not place on the job: % % %',e.job_id,e.attribution_status,e.metadata->>'placement_rule'; END IF;
 -- The same send again links nothing new.
 PERFORM pg_temp.c14_send(ja,'C14neighbA00001',staff);
 IF (SELECT count(*) FROM public.job_contact_send_links WHERE ghl_contact_id='C14neighbA00001')<>1 THEN RAISE EXCEPTION 'c14 A: a repeat send linked twice'; END IF;
 -- A second payer on a job with no parties at all (SWF-261638) is linked the same way.
 PERFORM pg_temp.c14_send(jd,'C14secondD00001',staff);
 e:=pg_temp.c14_text('C14secondD00001',now(),'If you get this tonight pls send');
 IF e.job_id IS DISTINCT FROM jd THEN RAISE EXCEPTION 'c14 A: second payer''s text did not place on the job'; END IF;

 ------------------------------------------------------------ B. a matching party gets the contact id
 je:=pg_temp.c14_job(3,'scheduled','C14ownerE000001');
 pe:=pg_temp.c14_party(je,'B',NULL,'0400 111 222');
 PERFORM pg_temp.c14_match('C14neighbE00001','+61400111222');
 PERFORM pg_temp.c14_send(je,'C14neighbE00001',staff);
 IF (SELECT ghl_contact_id FROM public.job_contacts WHERE id=pe) IS DISTINCT FROM 'C14neighbE00001' THEN RAISE EXCEPTION 'c14 B: matching party did not get the contact id'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.job_party_events WHERE job_contact_id=pe AND change='party_ids_set' AND method='staff_send' AND match_basis='phone')
 THEN RAISE EXCEPTION 'c14 B: no staff_send receipt from the party writer'; END IF;
 IF EXISTS (SELECT 1 FROM public.job_contact_send_links WHERE job_id=je) THEN RAISE EXCEPTION 'c14 B: a link row beside the party'; END IF;
 e:=pg_temp.c14_text('C14neighbE00001',now());
 IF e.job_id IS DISTINCT FROM je THEN RAISE EXCEPTION 'c14 B: the party''s text did not place on the job'; END IF;

 ------------------------------------------------------------ C. guards
 -- A contact already on another open job (the owner of SWF-99522) is not linked to SWF-99521.
 PERFORM pg_temp.c14_send(ja,'C14ownerD000001',staff);
 IF EXISTS (SELECT 1 FROM public.job_contact_send_links WHERE ghl_contact_id='C14ownerD000001') THEN RAISE EXCEPTION 'c14 C: contact of another open job linked'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.job_party_events WHERE job_id=ja AND change='send_link_other_open_job' AND detail->'other_job_ids' @> to_jsonb(ARRAY[jd]))
 THEN RAISE EXCEPTION 'c14 C: no send_link_other_open_job receipt naming the other job'; END IF;
 e:=pg_temp.c14_text('C14ownerD000001',now());
 IF e.job_id IS DISTINCT FROM jd THEN RAISE EXCEPTION 'c14 C: the other job''s customer no longer places on their own job'; END IF;
 -- A contact linked on one open job is not linked to a second one.
 PERFORM pg_temp.c14_send(je,'C14neighbA00001',staff);
 IF (SELECT count(*) FROM public.job_contact_send_links WHERE ghl_contact_id='C14neighbA00001')<>1 THEN RAISE EXCEPTION 'c14 C: one contact linked to two open jobs'; END IF;
 IF pg_temp.c14_receipts(je,'send_link_other_open_job')<>1 THEN RAISE EXCEPTION 'c14 C: no receipt for the second open job'; END IF;
 -- A party with a different contact id is never overwritten.
 jf:=pg_temp.c14_job(4,'scheduled','C14ownerF000001');
 pf:=pg_temp.c14_party(jf,'B','C14otherF000001','0400 333 444');
 PERFORM pg_temp.c14_match('C14newerF000001','0400333444');
 PERFORM pg_temp.c14_send(jf,'C14newerF000001',staff);
 IF (SELECT ghl_contact_id FROM public.job_contacts WHERE id=pf) IS DISTINCT FROM 'C14otherF000001' THEN RAISE EXCEPTION 'c14 C: an existing different contact id was overwritten'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.job_party_events WHERE job_contact_id=pf AND change='send_link_party_other_contact') THEN RAISE EXCEPTION 'c14 C: no send_link_party_other_contact receipt'; END IF;
 IF EXISTS (SELECT 1 FROM public.job_contact_send_links WHERE ghl_contact_id='C14newerF000001') THEN RAISE EXCEPTION 'c14 C: linked beside a party that holds another contact'; END IF;
 IF EXISTS (SELECT 1 FROM public.job_contacts WHERE id=pf AND 'identity_conflict'=ANY(party_flags)) THEN RAISE EXCEPTION 'c14 C: the refusal wrote a flag on the party'; END IF;
 -- Two matching parties: left for a person.
 jh:=pg_temp.c14_job(5,'scheduled','C14ownerH000001');
 PERFORM pg_temp.c14_party(jh,'B',NULL,'0400 555 666'); PERFORM pg_temp.c14_party(jh,'C',NULL,'0400 555 666');
 PERFORM pg_temp.c14_match('C14twinH0000001','0400555666');
 PERFORM pg_temp.c14_send(jh,'C14twinH0000001',staff);
 IF EXISTS (SELECT 1 FROM public.job_contacts WHERE job_id=jh AND ghl_contact_id='C14twinH0000001')
  OR EXISTS (SELECT 1 FROM public.job_contact_send_links WHERE ghl_contact_id='C14twinH0000001') THEN RAISE EXCEPTION 'c14 C: picked between two matching parties'; END IF;
 IF pg_temp.c14_receipts(jh,'send_link_party_ambiguous')<>1 THEN RAISE EXCEPTION 'c14 C: no send_link_party_ambiguous receipt'; END IF;
 -- A closed job links nothing.
 jc:=pg_temp.c14_job(6,'archived','C14ownerC000001');
 PERFORM pg_temp.c14_send(jc,'C14closedC00001',staff);
 IF EXISTS (SELECT 1 FROM public.job_contact_send_links WHERE ghl_contact_id='C14closedC00001') OR pg_temp.c14_receipts(jc,'send_link_job_closed')<>1
 THEN RAISE EXCEPTION 'c14 C: a closed job linked a contact or left no receipt'; END IF;

 ------------------------------------------------------------ D. only staff sends
 SELECT count(*) INTO n FROM public.job_party_events;
 PERFORM pg_temp.c14_send(ja,'C14autoA0000001',NULL);                               -- automated: no user
 PERFORM pg_temp.c14_send(ja,gen_random_uuid()::text,staff);                        -- a job_contacts uuid is not a GHL contact
 INSERT INTO public.job_events(job_id,user_id,event_type,detail_json)              -- another job_events type
 VALUES(ja,staff,'quote_viewed',jsonb_build_object('contact_id','C14viewA0000001'));
 PERFORM pg_temp.c14_text('C14inbndA000001',now());                                 -- inbound only
 IF EXISTS (SELECT 1 FROM public.job_contact_send_links WHERE ghl_contact_id IN ('C14autoA0000001','C14viewA0000001','C14inbndA000001'))
  OR (SELECT count(*) FROM public.job_party_events)<>n THEN RAISE EXCEPTION 'c14 D: a non-staff send, a non-GHL id, another event or an inbound text linked or logged'; END IF;
 r:=public.context_link_send_contact(ja,'C14autoA0000001','sms_sent',NULL,NULL);
 IF r->>'outcome'<>'not_staff' THEN RAISE EXCEPTION 'c14 D: no user should be not_staff, got %',r; END IF;
 BEGIN
  PERFORM public.context_link_send_contact(ja,'C14autoA0000001','sms_received',NULL,staff);
  RAISE EXCEPTION 'c14 D: an unknown source was accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'send_link_source_invalid' THEN RAISE; END IF;
 END;

 ------------------------------------------------------------ E. the placer
 jg:=pg_temp.c14_job(7,'scheduled','C14ownerG000001');
 pg:=pg_temp.c14_party(jg,'B','C14partyG000001',NULL);              -- linked earlier (say, by the quote accept)
 jk:=pg_temp.c14_job(8,'scheduled','C14ownerK000001');
 pr:=pg_temp.c14_party(jk,'B','C14removK000001',NULL,true);         -- removed
 SELECT * INTO t FROM public.context_contact_job_timeline('C14partyG000001',now(),NULL,NULL) x WHERE x.job_id=jg;
 IF t.basis IS DISTINCT FROM 'party' OR NOT t.candidate THEN RAISE EXCEPTION 'c14 E: four-argument timeline: % %',t.basis,t.candidate; END IF;
 SELECT * INTO t FROM public.context_contact_job_timeline('C14partyG000001',now()) x WHERE x.job_id=jg;
 IF t.basis IS DISTINCT FROM 'party' OR NOT t.candidate THEN RAISE EXCEPTION 'c14 E: two-argument timeline: % %',t.basis,t.candidate; END IF;
 IF (SELECT count(*) FROM public.context_contact_job_timeline('C14partyG000001',now(),NULL,NULL))<>1 THEN RAISE EXCEPTION 'c14 E: party job counted twice'; END IF;
 IF EXISTS (SELECT 1 FROM public.context_contact_job_timeline('C14removK000001',now(),NULL,NULL)) THEN RAISE EXCEPTION 'c14 E: removed party still a candidate'; END IF;
 IF EXISTS (SELECT 1 FROM public.context_contact_job_timeline('C14ownerG000001',now(),NULL,NULL) WHERE basis='party') THEN RAISE EXCEPTION 'c14 E: owner counted as a party'; END IF;
 e:=pg_temp.c14_text('C14partyG000001',now());
 IF e.job_id IS DISTINCT FROM jg OR e.attribution_status<>'single_open' THEN RAISE EXCEPTION 'c14 E: party''s text did not place: % %',e.job_id,e.attribution_status; END IF;
 e:=pg_temp.c14_text('C14removK000001',now());
 IF e.job_id IS NOT NULL THEN RAISE EXCEPTION 'c14 E: removed party''s text placed'; END IF;
 -- Rules off: the frozen ladder reads the two-argument timeline through context_contact_jobs_at.
 PERFORM pg_temp.c14_flag(false);
 IF NOT EXISTS (SELECT 1 FROM public.context_contact_jobs_at('C14partyG000001',now()) x WHERE x.job_id=jg AND x.basis='party')
 THEN RAISE EXCEPTION 'c14 E: rules-off candidate set lacks the party job'; END IF;
 e:=pg_temp.c14_text('C14partyG000001',now());
 IF e.job_id IS DISTINCT FROM jg THEN RAISE EXCEPTION 'c14 E: rules off, party''s text did not place: % %',e.job_id,e.attribution_status; END IF;
END $$;
ROLLBACK;

-- F. Structure.
DO $$
DECLARE r text; problems text[]:='{}';
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_contact_job_timeline(text,timestamptz)'::regprocedure)<>'e14de55f5ca63ec5a81a7e3a420a0a15'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_contact_job_timeline(text,timestamptz,text,text)'::regprocedure)<>'454ced32a1213e2c28d7d41d37263df5'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_link_send_contact(uuid,text,text,uuid,uuid,text,text)'::regprocedure)<>'f4601e213838c0dd0be1f99d8c07dec2'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_event_send_link()'::regprocedure)<>'29406e3aa57f2d8bf6d412e1db448d88'
 THEN problems:=problems||'a body is not this migration''s'::text; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF has_function_privilege(r,'public.context_link_send_contact(uuid,text,text,uuid,uuid,text,text)','EXECUTE')
   OR has_function_privilege(r,'public.context_job_event_send_link()','EXECUTE')
   OR has_table_privilege(r,'public.job_contact_send_links','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
   OR has_function_privilege(r,'public.context_contact_job_timeline(text,timestamptz,text,text)','EXECUTE')
  THEN problems:=problems||format('%s can reach the linker, the links or the timeline',r); END IF;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.context_link_send_contact(uuid,text,text,uuid,uuid,text,text)','EXECUTE')
  OR NOT has_table_privilege('service_role','public.job_contact_send_links','SELECT')
  OR has_table_privilege('service_role','public.job_contact_send_links','INSERT,UPDATE,DELETE')
 THEN problems:=problems||'service_role grants on the linker or the links are wrong'::text; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.job_contact_send_links'::regclass) THEN problems:=problems||'links table without RLS'::text; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.job_events'::regclass AND tgname='context_job_event_send_link' AND tgenabled='O'
   AND pg_get_triggerdef(oid) LIKE '%AFTER INSERT ON public.job_events FOR EACH ROW WHEN (((new.event_type = ''sms_sent''::text) AND (new.user_id IS NOT NULL) AND (new.job_id IS NOT NULL)))%')
 THEN problems:=problems||'the job_events trigger is missing or changed'::text; END IF;
 IF coalesce(obj_description('public.context_contact_job_timeline(text,timestamptz)'::regprocedure,'pg_proc'),'') NOT LIKE 'Every job of a GHL contact %basis party, C14%'
  OR coalesce(obj_description('public.context_contact_job_timeline(text,timestamptz,text,text)'::regprocedure,'pg_proc'),'') NOT LIKE 'P4:%C14 (20261103203000)%'
  OR coalesce(obj_description('public.context_link_send_contact(uuid,text,text,uuid,uuid,text,text)'::regprocedure,'pg_proc'),'') NOT LIKE 'C14 (20261103203000)%'
 THEN problems:=problems||'a comment is missing'::text; END IF;
 IF (SELECT count(*) FROM public.job_contact_send_links)<>0 THEN problems:=problems||'the migration wrote a link row'::text; END IF;
 IF cardinality(problems)>0 THEN RAISE EXCEPTION 'c14 structure: %',array_to_string(problems,'; '); END IF;
END $$;

-- Re-apply is a no-op.
CREATE TEMP TABLE c14_before AS SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5, obj_description(p.oid,'pg_proc') AS note, p.proacl::text AS acl
 FROM pg_proc p WHERE p.oid IN ('public.context_contact_job_timeline(text,timestamptz)'::regprocedure,
  'public.context_contact_job_timeline(text,timestamptz,text,text)'::regprocedure,
  'public.context_link_send_contact(uuid,text,text,uuid,uuid,text,text)'::regprocedure,'public.context_job_event_send_link()'::regprocedure);
BEGIN;
\ir ../../../migrations/20261103203000_context_send_party_link.sql
COMMIT;
DO $$
BEGIN
 IF (SELECT count(*) FROM c14_before)<>4 THEN RAISE EXCEPTION 'c14: expected 4 functions, got %',(SELECT count(*) FROM c14_before); END IF;
 IF EXISTS(SELECT 1 FROM c14_before b LEFT JOIN pg_proc p ON p.oid=b.sig::regprocedure
   WHERE md5(p.prosrc) IS DISTINCT FROM b.md5 OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note OR p.proacl::text IS DISTINCT FROM b.acl)
 THEN RAISE EXCEPTION 'c14: re-apply changed a body, comment or grant'; END IF;
END $$;
DROP TABLE c14_before;
