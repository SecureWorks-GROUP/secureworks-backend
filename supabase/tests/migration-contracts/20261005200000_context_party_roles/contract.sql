-- Party roles contract (20261005200000). Every fixture write is rolled back.
-- Ids, job numbers, contacts, addresses and text are synthetic.
--
-- Proves, through the real insert trigger (the ladder runs first):
--   A. This job's customer and a party on it read customer, in and out, on
--      texts, calls and transcripts; our side reads staff.
--   B. L1d's internal rows are copied, never re-decided: a crew text by job
--      number and a writer-marked staff text read staff to crew / staff,
--      audience internal; a contact our tools texted as crew reads crew when
--      it texts back; an L1d other_party row keeps its audience.
--   C. Emails: a person in users reads crew or staff by role, a supplier by
--      address or domain (never a free-mail domain), an insurer or builder by
--      company pattern, invoice or report address, or Prime; a council reads
--      unknown (council from v4, 20261007060000, on); internal mail reads
--      staff to staff; a customer of another job reads customer
--      (any_job_customer).
--   D. Non-message rows carry no party_roles; a writer cannot assert one.
--   E. A re-decision (job_id written) stamps again.
--   F. A classifier error never blocks capture: unknown, basis error.
--   G. Never writes recipient_role, audience or a placement; structure,
--      grants, trigger order, and a re-apply is a no-op.
\set ON_ERROR_STOP 1

CREATE FUNCTION pg_temp.pr_job(p_number text,p_contact text,p_email text DEFAULT NULL,p_phone text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,client_email,client_phone,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing',p_number,p_contact,p_email,p_phone,now()-interval '60 days');
 RETURN j;
END $$;

-- One row through the real insert trigger.
CREATE FUNCTION pg_temp.pr_ev(p_channel text,p_direction text,p_event text,p_contact text,p_payload jsonb,
 p_meta jsonb DEFAULT '{}'::jsonb) RETURNS public.business_events LANGUAGE plpgsql AS $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(contact_id,entity_type,entity_id,direction,channel,event_type,source,
  provider_message_id,payload,metadata,occurred_at,event_at)
  VALUES(p_contact,'contact',coalesce(p_contact,'none'),p_direction,p_channel,p_event,'party_roles_contract',
   'pr:'||replace(gen_random_uuid()::text,'-',''),p_payload,p_meta||'{"capture_mode":"live"}',now()-interval '1 day',now()-interval '1 day')
  RETURNING * INTO e;
 RETURN e;
END $$;

-- Put a row on a job as a re-decision would, and return it as stored.
CREATE FUNCTION pg_temp.pr_on(e public.business_events,p_job uuid) RETURNS public.business_events LANGUAGE plpgsql AS $$
DECLARE r public.business_events;
BEGIN
 UPDATE public.business_events SET job_id=p_job WHERE id=e.id RETURNING * INTO r;
 RETURN r;
END $$;

CREATE FUNCTION pg_temp.pr_is(what text,e public.business_events,p_sender text,p_recipient text,p_basis text,p_audience text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE r jsonb:=e.metadata->'party_roles';
 -- A registered successor (v2, 20261006000000; v3, 20261006034000; v4,
 -- 20261007060000) keeps every v1 decision these fixtures make (v4 reads a
 -- council by its gov.au domain, below) and stamps its own version; each
 -- proves that in its own contract.
 v text:=CASE WHEN coalesce(obj_description('public.context_message_party_roles(public.business_events)'::regprocedure,'pg_proc'),'')
  LIKE 'Party roles v4 (20261007060000):%' THEN 'party_roles_v4'
  WHEN coalesce(obj_description('public.context_message_party_roles(public.business_events)'::regprocedure,'pg_proc'),'')
  LIKE 'Party roles v3 (20261006034000):%' THEN 'party_roles_v3'
  WHEN coalesce(obj_description('public.context_message_party_roles(public.business_events)'::regprocedure,'pg_proc'),'')
  LIKE 'Party roles v2 (20261006000000):%' THEN 'party_roles_v2' ELSE 'party_roles_v1' END;
BEGIN
 IF r IS NULL OR r->>'version' IS DISTINCT FROM v OR r->>'sender_role' IS DISTINCT FROM p_sender
  OR r->>'recipient_role' IS DISTINCT FROM p_recipient OR r->>'basis' IS DISTINCT FROM p_basis OR r->>'audience' IS DISTINCT FROM p_audience
 THEN RAISE EXCEPTION 'party roles: % must read % to % (basis %, audience %), got %',what,p_sender,p_recipient,p_basis,p_audience,r; END IF;
END $$;

BEGIN;
DO $$
DECLARE j1 uuid; j2 uuid; e public.business_events; crew public.business_events; k bigint; words text;
BEGIN
 j1:=pg_temp.pr_job('SWF-991001','pr-cust','client.one@example.com','0412 345 678');
 j2:=pg_temp.pr_job('SWF-991002','pr-cust2');
 INSERT INTO public.job_contacts(job_id,contact_type,client_name,ghl_contact_id,client_email) VALUES(j1,'neighbour_b','Fixture Neighbour','pr-nb','neighbour@example.com');
 INSERT INTO public.users(id,org_id,name,role,email,phone) VALUES
  (gen_random_uuid(),'00000000-0000-0000-0000-000000000001','Fixture Crew','lead_installer','crew.person@gmail.com','0499 000 111'),
  (gen_random_uuid(),'00000000-0000-0000-0000-000000000001','Fixture Office','ops_manager','office.person@gmail.com',NULL);
 INSERT INTO public.suppliers(id,name,email,phone) VALUES
  (gen_random_uuid(),'Fixture Steel','orders@fixturesteel.com.au','08 9333 0000'),
  (gen_random_uuid(),'Fixture Sole Trader','bob.supplies@gmail.com',NULL);
 INSERT INTO public.makesafe_companies(slug,name,sender_patterns,invoice_email,report_recipient) VALUES
  ('pr-builder','Fixture Builder',ARRAY['fixturebuilder.com.au','claims@fixtureinsure.com'],'finance@fixturebuilder-billing.com','reports@fixturebuilder-reports.com');

 -- A. The job's customer and a party on it.
 e:=pg_temp.pr_on(pg_temp.pr_ev('sms','outbound','client.sms_out','pr-cust',jsonb_build_object('body','Hi, we are booked in for Tuesday')),j1);
 PERFORM pg_temp.pr_is('a text to the job''s customer',e,'staff','customer','job_customer','customer');
 e:=pg_temp.pr_on(pg_temp.pr_ev('sms','inbound','client.reply','pr-cust',jsonb_build_object('body','Thanks, see you then')),j1);
 PERFORM pg_temp.pr_is('a reply from the job''s customer',e,'customer','staff','job_customer','customer');
 e:=pg_temp.pr_on(pg_temp.pr_ev('sms','inbound','client.reply','pr-nb',jsonb_build_object('body','Is the fence still going ahead?')),j1);
 PERFORM pg_temp.pr_is('a text from a party on the job',e,'customer','staff','job_party','customer');
 e:=pg_temp.pr_on(pg_temp.pr_ev('call','inbound','client.call_logged','pr-cust',jsonb_build_object('call_status','completed')),j1);
 PERFORM pg_temp.pr_is('a call from the job''s customer',e,'customer','staff','job_customer','customer');
 e:=pg_temp.pr_on(pg_temp.pr_ev('call','outbound','call.transcript_completed','pr-cust',jsonb_build_object('transcript','We spoke about the gate')),j1);
 PERFORM pg_temp.pr_is('a call transcript to the job''s customer',e,'staff','customer','job_customer','customer');
 e:=pg_temp.pr_on(pg_temp.pr_ev('call','unknown','client.call_logged','pr-cust',jsonb_build_object('call_status','completed')),j1);
 PERFORM pg_temp.pr_is('a call with no direction',e,'unknown','unknown','job_customer','customer');
 IF e.metadata->'party_roles'->>'counterpart_role' IS DISTINCT FROM 'customer' THEN
  RAISE EXCEPTION 'party roles: a call with no direction must still name its counterpart, got %',e.metadata->'party_roles'; END IF;
 e:=pg_temp.pr_on(pg_temp.pr_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','Client One <Client.One@example.com>','body','Quote looks good')),j1);
 PERFORM pg_temp.pr_is('an email from the job''s client email',e,'customer','staff','job_customer','customer');
 e:=pg_temp.pr_on(pg_temp.pr_ev('sms','inbound','client.sms_in',NULL,jsonb_build_object('phone','+61412345678','body','Running late')),j1);
 PERFORM pg_temp.pr_is('a text from the job''s client phone',e,'customer','staff','job_customer','customer');

 -- B. L1d's internal rows: copied, never re-decided.
 words:=E'New job assigned: SWF-991001 - Fixture Client\nSite: 1 Fixture St';
 crew:=pg_temp.pr_ev('sms','outbound','client.sms_out','pr-crewc',jsonb_build_object('body',words,'text',words,'message',words));
 IF crew.job_id IS DISTINCT FROM j1 OR crew.metadata->>'audience' IS DISTINCT FROM 'internal' OR crew.metadata->>'recipient_role' IS DISTINCT FROM 'crew' THEN
  RAISE EXCEPTION 'party roles fixture: L1d must label the crew text internal on its job, got % %',crew.job_id,crew.metadata; END IF;
 PERFORM pg_temp.pr_is('L1d''s crew text',crew,'staff','crew','ladder_internal','internal');
 -- Even once the contact is the job's customer, a re-stamp copies L1d.
 UPDATE public.jobs SET ghl_contact_id='pr-crewc' WHERE id=j2;
 UPDATE public.business_events SET metadata=metadata||'{"touched":true}' WHERE id=crew.id RETURNING * INTO e;
 PERFORM pg_temp.pr_is('L1d''s crew text after a re-stamp',e,'staff','crew','ladder_internal','internal');
 IF e.metadata->>'recipient_role_source' IS DISTINCT FROM 'wording' OR e.job_id IS DISTINCT FROM j1 THEN
  RAISE EXCEPTION 'party roles: a re-stamp must not touch L1d''s label or placement, got % %',e.job_id,e.metadata; END IF;
 UPDATE public.jobs SET ghl_contact_id='pr-cust2' WHERE id=j2;
 e:=pg_temp.pr_ev('sms','outbound','client.sms_out','pr-staffc',jsonb_build_object('body','Docs Ready: SWF-991001 pack is ready'),
  jsonb_build_object('recipient_role','staff','about_job_id',j1::text));
 IF e.job_id IS DISTINCT FROM j1 THEN RAISE EXCEPTION 'party roles fixture: L1d must place the marked staff text on its job, got %',e.job_id; END IF;
 PERFORM pg_temp.pr_is('a writer-marked staff text',e,'staff','staff','ladder_internal','internal');
 -- A contact our tools texted as crew reads crew when it texts back.
 e:=pg_temp.pr_ev('sms','outbound','client.sms_out','pr-crew2',jsonb_build_object('body','Job ready for crew: tomorrow 7am'),
  jsonb_build_object('recipient_role','crew','about_job_id',j1::text));
 PERFORM pg_temp.pr_is('a writer-marked crew text',e,'staff','crew','ladder_internal','internal');
 e:=pg_temp.pr_on(pg_temp.pr_ev('sms','inbound','client.reply','pr-crew2',jsonb_build_object('body','On my way')),j1);
 PERFORM pg_temp.pr_is('a reply from a contact we texted as crew',e,'crew','staff','writer_marked_contact','internal');
 -- An L1d other_party row (a known contact who is not the customer) keeps
 -- its audience.
 e:=pg_temp.pr_ev('sms','outbound','client.sms_out','pr-someone',jsonb_build_object('body','About SWF-991001: the gate is in'));
 IF e.metadata->>'audience' IS DISTINCT FROM 'other_party' THEN RAISE EXCEPTION 'party roles fixture: L1d other_party expected, got %',e.metadata; END IF;
 PERFORM pg_temp.pr_is('L1d''s other_party text',e,'staff','unknown','not_job_customer','other_party');

 -- C. Emails.
 e:=pg_temp.pr_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','Fixture Crew <Crew.Person@gmail.com>','body','Photos attached'));
 PERFORM pg_temp.pr_is('an email from a crew member',e,'crew','staff','users','internal');
 e:=pg_temp.pr_ev('sms','inbound','client.sms_in',NULL,jsonb_build_object('phone','0499000111','body','Done for the day'));
 PERFORM pg_temp.pr_is('a text from a crew member''s phone',e,'crew','staff','users','internal');
 e:=pg_temp.pr_ev('email','outbound','client.email_out',NULL,jsonb_build_object('email','office.person@gmail.com','to',jsonb_build_array('office.person@gmail.com'),'body','FYI'));
 PERFORM pg_temp.pr_is('an email to an office person',e,'staff','staff','users','internal');
 e:=pg_temp.pr_ev('email','inbound','supplier.email_in',NULL,jsonb_build_object('from','orders@fixturesteel.com.au','body','Order confirmed'));
 PERFORM pg_temp.pr_is('a supplier email',e,'supplier','staff','supplier','other_party');
 e:=pg_temp.pr_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','accounts@dispatch.fixturesteel.com.au','body','Statement'));
 PERFORM pg_temp.pr_is('an email from a supplier''s domain',e,'supplier','staff','supplier','other_party');
 e:=pg_temp.pr_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','random.person@gmail.com','body','Hello'));
 PERFORM pg_temp.pr_is('a free-mail stranger',e,'unknown','staff','no_match','unknown');
 e:=pg_temp.pr_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','wo@claims.fixturebuilder.com.au','body','New work order'));
 PERFORM pg_temp.pr_is('a builder by domain pattern',e,'insurer_builder','staff','builder_company','other_party');
 e:=pg_temp.pr_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','claims@fixtureinsure.com','body','Claim update'));
 PERFORM pg_temp.pr_is('an insurer by address pattern',e,'insurer_builder','staff','builder_company','other_party');
 e:=pg_temp.pr_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','someone.else@fixtureinsure.com','body','Hi'));
 PERFORM pg_temp.pr_is('another address at an address-pattern domain',e,'unknown','staff','no_match','unknown');
 e:=pg_temp.pr_ev('email','outbound','client.email_out',NULL,jsonb_build_object('email','reports@fixturebuilder-reports.com','body','Report attached'));
 PERFORM pg_temp.pr_is('a report to a builder''s report address',e,'staff','insurer_builder','builder_company','other_party');
 e:=pg_temp.pr_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','noreply@notifications.primeeco.tech','body','Work order'));
 PERFORM pg_temp.pr_is('Prime',e,'insurer_builder','staff','builder_company','other_party');
 e:=pg_temp.pr_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','planning@fixture.wa.gov.au','body','Approval'));
 -- v4 (20261007060000) gives a council its own role, basis council as before; earlier versions name it in the basis only.
 IF coalesce(obj_description('public.context_message_party_roles(public.business_events)'::regprocedure,'pg_proc'),'')
   LIKE 'Party roles v4 (20261007060000):%' THEN
  PERFORM pg_temp.pr_is('a council',e,'council','staff','council','other_party');
 ELSE
  PERFORM pg_temp.pr_is('a council',e,'unknown','staff','council','unknown');
 END IF;
 e:=pg_temp.pr_ev('email','internal','staff.email_internal',NULL,jsonb_build_object('from','shaun@secureworkswa.com.au','body','Can you check this'));
 PERFORM pg_temp.pr_is('internal mail',e,'staff','staff','internal_direction','internal');
 e:=pg_temp.pr_ev('email','inbound','client.email_in',NULL,jsonb_build_object('from','jan@secureworkswa.com.au','body','Forwarding'));
 PERFORM pg_temp.pr_is('mail in from our own domain',e,'staff','staff','our_domain','internal');
 e:=pg_temp.pr_on(pg_temp.pr_ev('sms','inbound','client.reply','pr-cust2',jsonb_build_object('body','Any update on mine?')),NULL);
 PERFORM pg_temp.pr_is('the customer of another job',e,'customer','staff','any_job_customer','customer');
 e:=pg_temp.pr_ev('email','inbound','client.email_in',NULL,jsonb_build_object('body','no sender at all'));
 PERFORM pg_temp.pr_is('a row with no counterpart',e,'unknown','staff','no_contact','unknown');

 -- D. Non-message rows carry none, and a writer cannot assert one.
 e:=pg_temp.pr_ev('status','system','job.status_changed',NULL,'{"to":"scheduled"}'::jsonb,
  '{"party_roles":{"sender_role":"customer","recipient_role":"customer"}}'::jsonb);
 IF e.metadata ? 'party_roles' THEN RAISE EXCEPTION 'party roles: a non-message row must carry none, got %',e.metadata; END IF;
 e:=pg_temp.pr_ev('sms','inbound','client.reply','pr-crew2',jsonb_build_object('body','Forged'),
  '{"party_roles":{"version":"party_roles_v1","sender_role":"customer","recipient_role":"staff","basis":"job_customer","audience":"customer"}}'::jsonb);
 PERFORM pg_temp.pr_is('a writer-asserted role',e,'crew','staff','writer_marked_contact','internal');

 -- E. A re-decision stamps again.
 e:=pg_temp.pr_ev('sms','inbound','client.reply','pr-cust',jsonb_build_object('body','Following up'));
 e:=pg_temp.pr_on(e,NULL);
 PERFORM pg_temp.pr_is('the customer, off any job',e,'customer','staff','any_job_customer','customer');
 e:=pg_temp.pr_on(e,j1);
 PERFORM pg_temp.pr_is('the customer, placed on the job',e,'customer','staff','job_customer','customer');

 -- G. Never a placement or a ladder-owned key.
 SELECT count(*) INTO k FROM public.business_events
 WHERE source='party_roles_contract' AND metadata ? 'party_roles' AND coalesce(metadata->>'audience','')=''
  AND (metadata ? 'recipient_role' OR metadata ? 'recipient_role_source');
 IF k<>0 THEN RAISE EXCEPTION 'party roles: % rows gained a ladder-owned key',k; END IF;
END $$;
ROLLBACK;

-- F. A classifier error never blocks capture.
BEGIN;
CREATE OR REPLACE FUNCTION public.context_message_party_roles(e public.business_events) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $f$ BEGIN RAISE EXCEPTION 'fixture failure'; END $f$;
DO $$
DECLARE e public.business_events;
BEGIN
 e:=pg_temp.pr_ev('sms','inbound','client.reply','pr-err',jsonb_build_object('body','Still captured'));
 IF e.id IS NULL OR e.metadata->'party_roles'->>'basis' IS DISTINCT FROM 'error' OR e.metadata->'party_roles'->>'sender_role' IS DISTINCT FROM 'unknown'
  OR e.metadata->'party_roles'->>'error' IS DISTINCT FROM 'P0001'
 THEN RAISE EXCEPTION 'party roles: a classifier error must stamp unknown with basis error, got %',e.metadata; END IF;
END $$;
ROLLBACK;

-- G. Structure.
DO $$
DECLARE f text; r text; t text[];
BEGIN
 SELECT array_agg(t.tgname ORDER BY t.tgname) INTO t FROM pg_trigger t
 WHERE t.tgrelid='public.business_events'::regclass AND NOT t.tgisinternal AND t.tgname LIKE 'context\_%' AND (t.tgtype & 2)=2;
 IF t IS DISTINCT FROM ARRAY['context_attribute_business_event','context_party_roles_business_event']::text[] THEN
  RAISE EXCEPTION 'party roles: the BEFORE triggers must be the ladder then party roles, got %',t; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname='context_party_roles_business_event'
   AND t.tgfoid='public.context_stamp_party_roles()'::regprocedure AND (t.tgtype & 4)=4 AND (t.tgtype & 16)=16) THEN
  RAISE EXCEPTION 'party roles: the trigger must fire on insert and update'; END IF;
 -- The ladder's trigger still calls the ladder (this migration replaces no function).
 IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname='context_attribute_business_event' AND t.tgfoid='public.attribute_business_event()'::regprocedure)
 THEN RAISE EXCEPTION 'party roles: the ladder''s insert trigger changed'; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_party_user_role(text,text)','public.context_party_builder_address(text)',
  'public.context_message_party_roles(public.business_events)','public.context_stamp_party_roles()'] LOOP
  IF coalesce(obj_description(f::regprocedure,'pg_proc'),'') NOT LIKE 'Party roles (20261005200000):%'
   AND NOT (f='public.context_message_party_roles(public.business_events)'
    AND (coalesce(obj_description(f::regprocedure,'pg_proc'),'') LIKE 'Party roles v2 (20261006000000):%'
     OR coalesce(obj_description(f::regprocedure,'pg_proc'),'') LIKE 'Party roles v3 (20261006034000):%'
     OR coalesce(obj_description(f::regprocedure,'pg_proc'),'') LIKE 'Party roles v4 (20261007060000):%'))
  THEN RAISE EXCEPTION 'party roles: % is not marked',f; END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF has_function_privilege(r,f,'EXECUTE') THEN RAISE EXCEPTION 'party roles: % can call private %',r,f; END IF;
  END LOOP;
 END LOOP;
 IF has_function_privilege('service_role','public.context_stamp_party_roles()','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_message_party_roles(public.business_events)','EXECUTE')
 THEN RAISE EXCEPTION 'party roles: the service role must preview the classifier and not call the trigger function'; END IF;
 IF to_regclass('public.business_events_writer_marked_contact') IS NULL OR to_regclass('public.jobs_ghl_contact_party_roles') IS NULL
 THEN RAISE EXCEPTION 'party roles: an index is missing'; END IF;
END $$;

-- Re-apply is a no-op. While a registered successor (v2, 20261006000000,
-- v3, 20261006034000, or v4, 20261007060000) is live this migration's guard
-- refuses to re-apply over its classifier, so the re-apply is skipped here and
-- each successor's contract proves its own re-apply.
SELECT coalesce(obj_description(to_regprocedure('public.context_message_party_roles(public.business_events)'),'pg_proc'),'')
 LIKE 'Party roles v2 (20261006000000):%'
 OR coalesce(obj_description(to_regprocedure('public.context_message_party_roles(public.business_events)'),'pg_proc'),'')
 LIKE 'Party roles v3 (20261006034000):%'
 OR coalesce(obj_description(to_regprocedure('public.context_message_party_roles(public.business_events)'),'pg_proc'),'')
 LIKE 'Party roles v4 (20261007060000):%' AS pr_v2_live \gset
\if :pr_v2_live
\else
CREATE TEMP TABLE pr_before AS SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5, obj_description(p.oid,'pg_proc') AS note
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  AND p.proname IN ('context_party_user_role','context_party_builder_address','context_message_party_roles','context_stamp_party_roles');
\ir ../../../migrations/20261005200000_context_party_roles.sql
DO $$
BEGIN
 IF (SELECT count(*) FROM pr_before)<>4 THEN RAISE EXCEPTION 'party roles: expected 4 functions, got %',(SELECT count(*) FROM pr_before); END IF;
 IF EXISTS(SELECT 1 FROM pr_before b LEFT JOIN pg_proc p ON p.oid=b.sig::regprocedure
   WHERE md5(p.prosrc) IS DISTINCT FROM b.md5 OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note)
 THEN RAISE EXCEPTION 'party roles: re-apply changed a body or comment'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname='context_party_roles_business_event')<>1 THEN RAISE EXCEPTION 'party roles: re-apply duplicated the trigger'; END IF;
END $$;
DROP TABLE pr_before;
\endif
