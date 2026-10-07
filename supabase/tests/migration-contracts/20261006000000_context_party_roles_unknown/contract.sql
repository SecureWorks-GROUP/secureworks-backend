-- Party roles v2 contract (20261006000000). Every fixture write is rolled back.
-- Ids, job numbers, contacts, addresses and text are synthetic.
--
-- Proves, through the real insert trigger (the ladder runs first):
--   A. Every v1 decision is unchanged (same roles and basis), stamped v2.
--   B. Where v1 said unknown, v2 reads the facts the data holds:
--      a lead (contact_matches, a sales-pipeline stage change, an
--      appointment, an executed sales booking); the phones and emails a GHL
--      contact is known by (crew, staff, our domain, supplier, builder, a
--      party or client of another job); the row's own email as a party of
--      another job, a lead, or an address that only ever sent supplier mail.
--   C. Never a guess: signals that disagree leave the row unknown, basis
--      conflict, conflicting_roles named; a recruiting pipeline is no lead;
--      an address that sent both supplier and customer mail is no supplier.
--   D. L1d's internal rows are copied, never re-decided, even when the
--      contact is a lead.
--   E. Never writes recipient_role, audience or a placement; non-message rows
--      carry none.
--   F. Structure: v1's helpers and trigger untouched, grants, indexes, and a
--      re-apply is a no-op.
\set ON_ERROR_STOP 1

CREATE FUNCTION pg_temp.p2_job(p_number text,p_contact text,p_email text DEFAULT NULL,p_phone text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,client_email,client_phone,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing',p_number,p_contact,p_email,p_phone,now()-interval '60 days');
 RETURN j;
END $$;

-- One row through the real insert trigger.
CREATE FUNCTION pg_temp.p2_ev(p_channel text,p_direction text,p_event text,p_contact text,p_payload jsonb,
 p_meta jsonb DEFAULT '{}'::jsonb) RETURNS public.business_events LANGUAGE plpgsql AS $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(contact_id,entity_type,entity_id,direction,channel,event_type,source,
  provider_message_id,payload,metadata,occurred_at,event_at)
  VALUES(p_contact,'contact',coalesce(p_contact,'none'),p_direction,p_channel,p_event,'party_roles_v2_contract',
   'p2:'||replace(gen_random_uuid()::text,'-',''),p_payload,p_meta||'{"capture_mode":"live"}',now()-interval '1 day',now()-interval '1 day')
  RETURNING * INTO e;
 RETURN e;
END $$;

CREATE FUNCTION pg_temp.p2_on(e public.business_events,p_job uuid) RETURNS public.business_events LANGUAGE plpgsql AS $$
DECLARE r public.business_events;
BEGIN
 UPDATE public.business_events SET job_id=p_job WHERE id=e.id RETURNING * INTO r;
 RETURN r;
END $$;

CREATE FUNCTION pg_temp.p2_is(what text,e public.business_events,p_sender text,p_recipient text,p_basis text,p_audience text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE r jsonb:=e.metadata->'party_roles';
 -- A registered successor (v3, 20261006034000) keeps every v2 decision these
 -- fixtures make and stamps its own version; it proves that in its own contract.
 v text:=CASE WHEN coalesce(obj_description('public.context_message_party_roles(public.business_events)'::regprocedure,'pg_proc'),'')
  LIKE 'Party roles v3 (20261006034000):%' THEN 'party_roles_v3' ELSE 'party_roles_v2' END;
BEGIN
 IF r IS NULL OR r->>'version' IS DISTINCT FROM v OR r->>'sender_role' IS DISTINCT FROM p_sender
  OR r->>'recipient_role' IS DISTINCT FROM p_recipient OR r->>'basis' IS DISTINCT FROM p_basis OR r->>'audience' IS DISTINCT FROM p_audience
  OR (p_basis<>'conflict' AND r ? 'conflicting_roles')
 THEN RAISE EXCEPTION 'party roles v2: % must read % to % (basis %, audience %), got %',what,p_sender,p_recipient,p_basis,p_audience,r; END IF;
END $$;

BEGIN;
DO $$
DECLARE j1 uuid; j2 uuid; e public.business_events; crew public.business_events; k bigint; words text;
BEGIN
 j1:=pg_temp.p2_job('SWF-992001','p2-cust','client.two@example.com','0412 777 001');
 j2:=pg_temp.p2_job('SWF-992002','p2-cust2');
 INSERT INTO public.job_contacts(job_id,contact_type,client_name,client_email,client_phone)
  VALUES(j2,'neighbour_b','Fixture Neighbour Two','neighbour.two@example.com','0412 777 002');
 INSERT INTO public.users(id,org_id,name,role,email,phone) VALUES
  (gen_random_uuid(),'00000000-0000-0000-0000-000000000001','Fixture Crew Two','installer','crew.two@gmail.com','0499 222 111'),
  (gen_random_uuid(),'00000000-0000-0000-0000-000000000001','Fixture Office Two','ops_manager','office.two@gmail.com','0499 222 333');
 INSERT INTO public.suppliers(id,name,email,phone) VALUES
  (gen_random_uuid(),'Fixture Timber','sales@fixturetimber.com.au','08 9444 0000');
 INSERT INTO public.makesafe_companies(slug,name,sender_patterns) VALUES ('p2-builder','Fixture Builder Two',ARRAY['fixturebuildertwo.com.au']);

 -- A. v1 decisions are unchanged, stamped v2.
 e:=pg_temp.p2_on(pg_temp.p2_ev('sms','inbound','client.reply','p2-cust',jsonb_build_object('body','Thanks, see you then')),j1);
 PERFORM pg_temp.p2_is('a reply from the job''s customer',e,'customer','staff','job_customer','customer');
 e:=pg_temp.p2_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','Crew Two <crew.two@gmail.com>','body','Photos'));
 PERFORM pg_temp.p2_is('an email from a crew member',e,'crew','staff','users','internal');
 e:=pg_temp.p2_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','accounts@fixturetimber.com.au','body','Statement'));
 PERFORM pg_temp.p2_is('a supplier email',e,'supplier','staff','supplier','other_party');
 e:=pg_temp.p2_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','wo@fixturebuildertwo.com.au','body','New work order'));
 PERFORM pg_temp.p2_is('a builder',e,'insurer_builder','staff','builder_company','other_party');
 e:=pg_temp.p2_on(pg_temp.p2_ev('sms','inbound','client.reply','p2-cust2',jsonb_build_object('body','Any update on mine?')),NULL);
 PERFORM pg_temp.p2_is('the customer of another job',e,'customer','staff','any_job_customer','customer');
 e:=pg_temp.p2_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','planning@fixture2.wa.gov.au','body','Approval'));
 PERFORM pg_temp.p2_is('a council',e,'unknown','staff','council','unknown');
 e:=pg_temp.p2_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','random.two@gmail.com','body','Hello'));
 PERFORM pg_temp.p2_is('a free-mail stranger',e,'unknown','staff','no_match','unknown');
 e:=pg_temp.p2_ev('email','inbound','client.email_in',NULL,jsonb_build_object('body','no sender at all'));
 PERFORM pg_temp.p2_is('a row with no counterpart',e,'unknown','staff','no_contact','unknown');
 e:=pg_temp.p2_ev('sms','inbound','client.reply','p2-nobody',jsonb_build_object('body','Who is this?'));
 PERFORM pg_temp.p2_is('a GHL contact nothing knows',e,'unknown','staff','no_match','unknown');

 -- B. Leads.
 INSERT INTO public.contact_matches(ghl_contact_id) VALUES('p2-lead-cm');
 e:=pg_temp.p2_ev('sms','inbound','client.reply','p2-lead-cm',jsonb_build_object('body','Can I get a quote?'));
 PERFORM pg_temp.p2_is('a text from a GHL lead (contact_matches)',e,'customer','staff','lead','customer');
 e:=pg_temp.p2_ev('sms','outbound','client.sms_out','p2-lead-cm',jsonb_build_object('body','Hi, thanks for your enquiry'));
 PERFORM pg_temp.p2_is('a text to a GHL lead',e,'staff','customer','lead','customer');
 PERFORM pg_temp.p2_ev('status','internal','ghl.stage_changed','p2-lead-stage',jsonb_build_object('new_stage','Quoted','pipeline','Fencing Sales'));
 e:=pg_temp.p2_ev('call','inbound','client.call_logged','p2-lead-stage',jsonb_build_object('call_status','completed'));
 PERFORM pg_temp.p2_is('a call from a contact with a sales opportunity',e,'customer','staff','lead','customer');
 PERFORM pg_temp.p2_ev('status','internal','client.appointment','p2-lead-appt',jsonb_build_object('title','Fence scope'));
 e:=pg_temp.p2_ev('sms','inbound','client.reply','p2-lead-appt',jsonb_build_object('body','Running 5 min late'));
 PERFORM pg_temp.p2_is('a text from a contact with an appointment',e,'customer','staff','lead','customer');
 PERFORM pg_temp.p2_ev('status','internal','ghl.appointment_created','p2-lead-appt2',jsonb_build_object('title','Patio scope'));
 e:=pg_temp.p2_ev('sms','inbound','client.reply','p2-lead-appt2',jsonb_build_object('body','See you Thursday'));
 PERFORM pg_temp.p2_is('a text from a contact with a GHL app appointment',e,'customer','staff','lead','customer');
 INSERT INTO public.sales_booking_approvals VALUES
  (repeat('e',64),'calendar','marnin','2026-09-21','approved',NULL,
   jsonb_build_object('schema','scope-booking-approval.v1','step','calendar','resource','marnin','week_start','2026-09-21',
    'content_hash',repeat('f',64),'content','{}'::jsonb,'pack_revision',repeat('c',64),'contact_id','p2-lead-book'),
   '706c5258-70dd-483a-b36c-af6864b24498','captain@example.test','2026-09-22T00:00Z','2026-09-22T00:15Z');
 INSERT INTO public.sales_booking_executions(binding_hash,step,contact_id,state,press_token,claimed_by_email)
  VALUES(repeat('e',64),'calendar','p2-lead-book','claimed','55555555-5555-4555-8555-555555555555','captain@example.test');
 e:=pg_temp.p2_ev('sms','inbound','client.reply','p2-lead-book',jsonb_build_object('body','Confirmed'));
 PERFORM pg_temp.p2_is('a text from a contact with an executed sales booking',e,'customer','staff','lead','customer');

 -- B. What a GHL contact is known by.
 PERFORM pg_temp.p2_ev('call','inbound','client.call_complete','p2-crew-c',jsonb_build_object('phone','+61 499 222 111','duration',30));
 e:=pg_temp.p2_ev('sms','inbound','client.reply','p2-crew-c',jsonb_build_object('body','On site now'));
 PERFORM pg_temp.p2_is('a contact whose call carried a crew member''s phone',e,'crew','staff','contact_users','internal');
 e:=pg_temp.p2_ev('sms','outbound','client.sms_out','p2-crew-c',jsonb_build_object('body','Thanks mate'));
 PERFORM pg_temp.p2_is('a text to that contact',e,'staff','crew','contact_users','internal');
 PERFORM pg_temp.p2_ev('call','inbound','client.call_complete','p2-office-c',jsonb_build_object('phone','0499222333'));
 e:=pg_temp.p2_ev('sms','inbound','client.reply','p2-office-c',jsonb_build_object('body','Call me back'));
 PERFORM pg_temp.p2_is('a contact known by an office phone',e,'staff','staff','contact_users','internal');
 PERFORM pg_temp.p2_ev('call','inbound','client.call_complete','p2-ours-c',jsonb_build_object('contact_email','jan@secureworkswa.com.au'));
 e:=pg_temp.p2_ev('sms','inbound','client.reply','p2-ours-c',jsonb_build_object('body','Testing the line'));
 PERFORM pg_temp.p2_is('a contact known by one of our addresses',e,'staff','staff','contact_our_domain','internal');
 PERFORM pg_temp.p2_ev('call','inbound','client.call_complete','p2-supp-c',jsonb_build_object('phone','(08) 9444 0000'));
 e:=pg_temp.p2_ev('call','inbound','client.call_logged','p2-supp-c',jsonb_build_object('call_status','completed'));
 PERFORM pg_temp.p2_is('a contact known by a supplier''s phone',e,'supplier','staff','contact_supplier','other_party');
 PERFORM pg_temp.p2_ev('call','inbound','client.call_complete','p2-build-c',jsonb_build_object('contact_email','claims@fixturebuildertwo.com.au'));
 e:=pg_temp.p2_ev('sms','inbound','client.reply','p2-build-c',jsonb_build_object('body','Work order sent'));
 PERFORM pg_temp.p2_is('a contact known by a builder''s address',e,'insurer_builder','staff','contact_builder_company','other_party');
 PERFORM pg_temp.p2_ev('call','inbound','client.call_complete','p2-nb-c',jsonb_build_object('phone','0412777002'));
 e:=pg_temp.p2_ev('sms','inbound','client.reply','p2-nb-c',jsonb_build_object('body','About the shared fence'));
 PERFORM pg_temp.p2_is('a contact known by a job party''s phone',e,'customer','staff','contact_any_job_party','customer');
 PERFORM pg_temp.p2_ev('call','inbound','client.call_complete','p2-cl-c',jsonb_build_object('contact_email','Client.Two@example.com'));
 e:=pg_temp.p2_ev('sms','inbound','client.reply','p2-cl-c',jsonb_build_object('body','New number, same person'));
 PERFORM pg_temp.p2_is('a contact known by a job''s client email',e,'customer','staff','contact_any_job_customer','customer');

 -- B. The row's own email.
 e:=pg_temp.p2_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','Neighbour <neighbour.two@example.com>','body','Happy to share'));
 PERFORM pg_temp.p2_is('an email from a party of another job',e,'customer','staff','any_job_party','customer');
 INSERT INTO public.contact_matches(ghl_contact_id,email,phone) VALUES('p2-lead-em','lead.two@example.com',NULL);
 e:=pg_temp.p2_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','lead.two@example.com','body','Following up my enquiry'));
 PERFORM pg_temp.p2_is('an email from a lead''s address',e,'customer','staff','lead','customer');
 PERFORM pg_temp.p2_ev('email','inbound','supplier.email_in',NULL,jsonb_build_object('from','Quotes <quotes@fixturemesh.com.au>','body','Quote attached'));
 e:=pg_temp.p2_ev('email','outbound','client.email_out',NULL,jsonb_build_object('email','quotes@fixturemesh.com.au','body','Order confirmed'));
 PERFORM pg_temp.p2_is('an email to an address that only sent supplier mail',e,'staff','supplier','supplier_seen','other_party');

 -- C. Never a guess.
 INSERT INTO public.contact_matches(ghl_contact_id,email) VALUES('p2-clash','orders@fixturetimber.com.au');
 e:=pg_temp.p2_ev('sms','inbound','client.reply','p2-clash',jsonb_build_object('body','Delivery tomorrow'));
 PERFORM pg_temp.p2_is('a lead known by a supplier''s address',e,'unknown','staff','conflict','unknown');
 IF e.metadata->'party_roles'->'conflicting_roles' IS DISTINCT FROM '["customer","supplier"]'::jsonb THEN
  RAISE EXCEPTION 'party roles v2: a conflict must name what disagreed, got %',e.metadata->'party_roles'; END IF;
 PERFORM pg_temp.p2_ev('call','inbound','client.call_complete','p2-clash2',jsonb_build_object('phone','0499222111','contact_email','orders@fixturetimber.com.au'));
 e:=pg_temp.p2_ev('sms','inbound','client.reply','p2-clash2',jsonb_build_object('body','Who am I'));
 PERFORM pg_temp.p2_is('a contact known by a crew phone and a supplier address',e,'unknown','staff','conflict','unknown');
 PERFORM pg_temp.p2_ev('status','internal','ghl.stage_changed','p2-recruit',jsonb_build_object('new_stage','Interview','pipeline','Crew Recruitment'));
 e:=pg_temp.p2_ev('sms','inbound','client.reply','p2-recruit',jsonb_build_object('body','Still keen for the job'));
 PERFORM pg_temp.p2_is('a contact only in a recruiting pipeline',e,'unknown','staff','no_match','unknown');
 PERFORM pg_temp.p2_ev('email','inbound','supplier.email_in',NULL,jsonb_build_object('from','both@fixturemixed.com.au','body','Quote'));
 PERFORM pg_temp.p2_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','both@fixturemixed.com.au','body','My own fence'));
 e:=pg_temp.p2_ev('email','outbound','client.email_out',NULL,jsonb_build_object('email','both@fixturemixed.com.au','body','Thanks'));
 PERFORM pg_temp.p2_is('an address that sent supplier and customer mail',e,'staff','unknown','no_match','unknown');

 -- D. L1d's internal rows: copied even when the contact is a lead.
 INSERT INTO public.contact_matches(ghl_contact_id) VALUES('p2-crewlead');
 words:=E'New job assigned: SWF-992001 - Fixture Client\nSite: 2 Fixture St';
 crew:=pg_temp.p2_ev('sms','outbound','client.sms_out','p2-crewlead',jsonb_build_object('body',words,'text',words,'message',words));
 IF crew.job_id IS DISTINCT FROM j1 OR crew.metadata->>'audience' IS DISTINCT FROM 'internal' OR crew.metadata->>'recipient_role' IS DISTINCT FROM 'crew' THEN
  RAISE EXCEPTION 'party roles v2 fixture: L1d must label the crew text internal on its job, got % %',crew.job_id,crew.metadata; END IF;
 PERFORM pg_temp.p2_is('L1d''s crew text to a lead contact',crew,'staff','crew','ladder_internal','internal');
 UPDATE public.business_events SET metadata=metadata||'{"touched":true}' WHERE id=crew.id RETURNING * INTO e;
 PERFORM pg_temp.p2_is('L1d''s crew text after a re-stamp',e,'staff','crew','ladder_internal','internal');
 IF e.metadata->>'recipient_role_source' IS DISTINCT FROM 'wording' OR e.job_id IS DISTINCT FROM j1 THEN
  RAISE EXCEPTION 'party roles v2: a re-stamp must not touch L1d''s label or placement, got % %',e.job_id,e.metadata; END IF;

 -- E. A v1 stamp is replaced by v2 on the next write; nothing else moves.
 e:=pg_temp.p2_ev('sms','inbound','client.reply','p2-lead-cm',jsonb_build_object('body','Restamp me'));
 UPDATE public.business_events SET metadata=metadata||jsonb_build_object('party_roles',jsonb_build_object('version','party_roles_v1',
  'sender_role','unknown','recipient_role','staff','counterpart_role','unknown','basis','no_match','audience','unknown')) WHERE id=e.id RETURNING * INTO e;
 PERFORM pg_temp.p2_is('a v1 unknown row re-stamped',e,'customer','staff','lead','customer');
 e:=pg_temp.p2_ev('status','system','job.status_changed','p2-lead-cm','{"to":"scheduled"}'::jsonb);
 IF e.metadata ? 'party_roles' THEN RAISE EXCEPTION 'party roles v2: a non-message row must carry none, got %',e.metadata; END IF;
 SELECT count(*) INTO k FROM public.business_events
 WHERE source='party_roles_v2_contract' AND metadata ? 'party_roles' AND coalesce(metadata->>'audience','')=''
  AND (metadata ? 'recipient_role' OR metadata ? 'recipient_role_source');
 IF k<>0 THEN RAISE EXCEPTION 'party roles v2: % rows gained a ladder-owned key',k; END IF;
 SELECT count(*) INTO k FROM public.business_events
 WHERE source='party_roles_v2_contract' AND metadata->>'audience' IS NOT NULL AND metadata ? 'party_roles'
  AND metadata->>'audience' IS DISTINCT FROM metadata->'party_roles'->>'audience';
 IF k<>0 THEN RAISE EXCEPTION 'party roles v2: % rows read an audience other than the ladder''s',k; END IF;
END $$;
ROLLBACK;

-- F. Structure.
DO $$
DECLARE f text; r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_party_user_role(text,text)'::regprocedure)<>'17bdaa22bb55de8635c1dd8563d070d1'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_party_builder_address(text)'::regprocedure)<>'ccd5e9acd5d51228007c3af14054c474'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_stamp_party_roles()'::regprocedure)<>'de974f45ef3174e9391a3d31369df179'
 THEN RAISE EXCEPTION 'party roles v2: a v1 helper or the trigger function changed'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname='context_party_roles_business_event'
   AND t.tgfoid='public.context_stamp_party_roles()'::regprocedure) THEN
  RAISE EXCEPTION 'party roles v2: the party-role trigger changed'; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_party_supplier_key(text,text)','public.context_party_key_roles(text,text)',
  'public.context_party_contact_roles(text)','public.context_message_party_roles(public.business_events)'] LOOP
  IF coalesce(obj_description(f::regprocedure,'pg_proc'),'') NOT LIKE 'Party roles v2 (20261006000000):%'
   AND NOT (f='public.context_message_party_roles(public.business_events)'
    AND coalesce(obj_description(f::regprocedure,'pg_proc'),'') LIKE 'Party roles v3 (20261006034000):%')
  THEN RAISE EXCEPTION 'party roles v2: % is not marked',f; END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF has_function_privilege(r,f,'EXECUTE') THEN RAISE EXCEPTION 'party roles v2: % can call private %',r,f; END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'party roles v2: the service role must preview %',f; END IF;
 END LOOP;
 IF to_regclass('public.business_events_party_contact_keys') IS NULL OR to_regclass('public.business_events_party_lead_contact') IS NULL
  OR to_regclass('public.business_events_party_mail_from') IS NULL
 THEN RAISE EXCEPTION 'party roles v2: an index is missing'; END IF;
END $$;

-- Re-apply is a no-op. A registered successor (v3, 20261006034000) replaces
-- the classifier; whenever the live body is not v2's, stand v2's classifier
-- back up first, inside this rolled-back block, and nothing else (a later
-- change to any other function never reaches this check).
BEGIN;
SELECT md5(prosrc)<>'8d5bb9cfa80a631ee39497282e54f967' AS p2_classifier_moved
FROM pg_proc WHERE oid='public.context_message_party_roles(public.business_events)'::regprocedure \gset
\if :p2_classifier_moved
\ir ../20261006034000_context_party_roles_health/v2_message_party_roles.sql
\endif
CREATE TEMP TABLE p2_before AS SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5, obj_description(p.oid,'pg_proc') AS note
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  AND p.proname IN ('context_party_supplier_key','context_party_key_roles','context_party_contact_roles','context_message_party_roles',
   'context_party_user_role','context_party_builder_address','context_stamp_party_roles');
\ir ../../../migrations/20261006000000_context_party_roles_unknown.sql
DO $$
BEGIN
 IF (SELECT count(*) FROM p2_before)<>7 THEN RAISE EXCEPTION 'party roles v2: expected 7 functions, got %',(SELECT count(*) FROM p2_before); END IF;
 IF EXISTS(SELECT 1 FROM p2_before b LEFT JOIN pg_proc p ON p.oid=b.sig::regprocedure
   WHERE md5(p.prosrc) IS DISTINCT FROM b.md5 OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note)
 THEN RAISE EXCEPTION 'party roles v2: re-apply changed a body or comment'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname='context_party_roles_business_event')<>1 THEN RAISE EXCEPTION 'party roles v2: re-apply duplicated the trigger'; END IF;
END $$;
ROLLBACK;
