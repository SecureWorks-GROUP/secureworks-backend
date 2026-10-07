-- EM2/EM3 behaviour contract: the email reader's database side. The input
-- rows between the ROWS markers are exactly what the TypeScript builder
-- (_shared/evidence/outlook_mail.ts) produces for the synthetic fixtures in
-- outlook_mail_fixtures.ts; outlook_mail_contract_rows_test.ts fails if they
-- drift. Every fixture write is rolled back.

BEGIN;
-- 1. Shape and access: flags off, ledger locked to the service role, helpers
-- service-only, cron callers postgres-only, lanes extended.
DO $$
DECLARE f text;
BEGIN
 IF (SELECT enabled FROM public.feature_flags WHERE flag_name='email_reader_v1') IS DISTINCT FROM false
  OR (SELECT enabled FROM public.feature_flags WHERE flag_name='email_reader_schedule_v1') IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'em2 flags must be created off'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.context_email_attachments'::regclass)
 THEN RAISE EXCEPTION 'em2 ledger RLS off'; END IF;
 IF has_table_privilege('anon','public.context_email_attachments','SELECT') OR has_table_privilege('authenticated','public.context_email_attachments','SELECT')
  OR has_table_privilege('anon','public.context_email_attachments','INSERT') OR has_table_privilege('authenticated','public.context_email_attachments','INSERT')
 THEN RAISE EXCEPTION 'em2 ledger reachable by anon or authenticated'; END IF;
 IF NOT has_table_privilege('service_role','public.context_email_attachments','SELECT,INSERT')
  OR has_table_privilege('service_role','public.context_email_attachments','UPDATE')
  OR has_table_privilege('service_role','public.context_email_attachments','DELETE')
 THEN RAISE EXCEPTION 'em2 service_role must read and insert only'; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_email_reader_flags()','public.context_email_supplier_domains()','public.context_email_job_client_emails()',
  'public.context_email_history_scope()','public.trigger_context_email_poll()','public.trigger_context_email_sweep()'] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE')
  THEN RAISE EXCEPTION 'em2 % executable by anon or authenticated',f; END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=f::regprocedure) THEN RAISE EXCEPTION 'em2 % must be SECURITY DEFINER',f; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=f::regprocedure AND proconfig IS NOT NULL AND EXISTS(SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search_path=%'))
  THEN RAISE EXCEPTION 'em2 % needs a fixed search_path',f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_email_reader_flags()','public.context_email_supplier_domains()','public.context_email_job_client_emails()','public.context_email_history_scope()'] LOOP
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'em2 service_role cannot execute %',f; END IF;
 END LOOP;
 IF has_function_privilege('service_role','public.trigger_context_email_poll()','EXECUTE')
  OR has_function_privilege('service_role','public.trigger_context_email_sweep()','EXECUTE')
 THEN RAISE EXCEPTION 'em2 cron callers must not be callable by service_role'; END IF;
 -- Containment: later capture slices add their own jobs (B-2, 20261005190000:
 -- ghl-history-schedule; B-5, 20261005210000: context-document-text; history
 -- daily, 20261007050000: xero-history-daily; history depth, 20261007080000:
 -- outlook-mail-deep-history, all capture); these six rows must stay as
 -- they are.
 IF NOT (SELECT array_agg(cron_jobname||':'||lane ORDER BY cron_jobname) FROM public.automation_switch_cron_lanes())
    @> ARRAY['contact-matching:attribution','ghl-call-transcript-fetch:capture','ghl-message-reconcile:capture','monitor-inbox-poll:capture','monitor-inbox-sweep:capture','outlook-mail-poll:capture']
  OR EXISTS(SELECT 1 FROM public.automation_switch_cron_lanes() l WHERE l.cron_jobname NOT IN ('contact-matching','ghl-call-transcript-fetch',
   'ghl-message-reconcile','monitor-inbox-poll','monitor-inbox-sweep','outlook-mail-poll','ghl-history-schedule','context-document-text',
   'xero-history-daily','outlook-mail-deep-history'))
  OR EXISTS(SELECT 1 FROM public.automation_switch_cron_lanes() l WHERE l.cron_jobname IN ('ghl-history-schedule','context-document-text',
   'xero-history-daily','outlook-mail-deep-history') AND l.lane<>'capture')
 THEN RAISE EXCEPTION 'em2 cron lane list %',(SELECT array_agg(to_jsonb(l)) FROM public.automation_switch_cron_lanes() l); END IF;
END $$;
ROLLBACK;

BEGIN;
-- 2. The flags read fails closed and follows the three rows.
DO $$
DECLARE f jsonb;
BEGIN
 f:=public.context_email_reader_flags();
 IF (f->>'reader')::boolean OR (f->>'schedule')::boolean OR (f->>'program')::boolean THEN RAISE EXCEPTION 'em2 flags read on: %',f; END IF;
 UPDATE public.feature_flags SET enabled=true WHERE flag_name IN ('email_reader_v1','email_capture_v2');
 f:=public.context_email_reader_flags();
 IF NOT (f->>'reader')::boolean OR NOT (f->>'program')::boolean OR (f->>'schedule')::boolean OR f->>'state'<>'present'
 THEN RAISE EXCEPTION 'em2 flags read %',f; END IF;
 DELETE FROM public.feature_flags WHERE flag_name='email_reader_schedule_v1';
 f:=public.context_email_reader_flags();
 IF (f->>'schedule')::boolean OR f->>'state'<>'missing' THEN RAISE EXCEPTION 'em2 missing flag must read off: %',f; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 3. The ledger refuses a stored row without its file, a public or other
-- bucket, an unknown status, and a second row for one attachment.
DO $$
DECLARE k text:=repeat('a',64); h text:=repeat('b',64);
BEGIN
 INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status,file_name,size_bytes)
  VALUES('email:m1@x.example',k,'skipped_inline','logo.png',4000);
 BEGIN
  INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status) VALUES('email:m1@x.example',k,'skipped_inline');
  RAISE EXCEPTION 'em2 duplicate attachment row accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status) VALUES('email:m1@x.example',h,'stored');
  RAISE EXCEPTION 'em2 stored row without a file accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status,sha256,storage_bucket,storage_path)
   VALUES('email:m1@x.example',h,'stored',h,'job-photos','x/y.pdf');
  RAISE EXCEPTION 'em2 stored row in another bucket accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status) VALUES('email:m1@x.example',h,'sent');
  RAISE EXCEPTION 'em2 unknown status accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status) VALUES('m1@x.example',h,'skipped_kind');
  RAISE EXCEPTION 'em2 unkeyed email accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status,sha256,storage_bucket,storage_path,size_bytes)
  VALUES('email:m1@x.example',h,'stored',h,'context-email-attachments','abc/def/sketch.pdf',120000);
END $$;
ROLLBACK;

BEGIN;
-- 4. Read helpers: supplier domains (ours and free mail excluded), client
-- emails of jobs, and the live-job scope for history.
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; live uuid:=gen_random_uuid(); closed uuid:=gen_random_uuid(); s jsonb;
BEGIN
 INSERT INTO public.suppliers(name,email) VALUES('Steel','Orders@SteelSupply.example'),('Ours','x@secureworkswa.com.au'),
  ('Gmail rep','rep@gmail.com'),('No email',NULL),('Sub','sales@east.steelsupply.example');
 IF public.context_email_supplier_domains() IS DISTINCT FROM ARRAY['east.steelsupply.example','steelsupply.example']
 THEN RAISE EXCEPTION 'em2 supplier domains %',public.context_email_supplier_domains(); END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,metadata,client_email) VALUES
  (live,org,'scheduled','patio','EM2-LIVE-1','em2-live-contact','{}','Live.Client@Example.com'),
  (closed,org,'complete','patio','EM2-DONE-1','em2-done-contact','{}','done.client@example.com');
 IF NOT 'live.client@example.com'=ANY(public.context_email_job_client_emails())
  OR NOT 'done.client@example.com'=ANY(public.context_email_job_client_emails())
 THEN RAISE EXCEPTION 'em2 job client emails %',public.context_email_job_client_emails(); END IF;
 s:=public.context_email_history_scope();
 IF NOT s->'job_numbers' ? 'EM2-LIVE-1' OR s->'job_numbers' ? 'EM2-DONE-1'
  OR NOT s->'client_emails' ? 'live.client@example.com' OR s->'client_emails' ? 'done.client@example.com'
 THEN RAISE EXCEPTION 'em2 history scope %',s; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 5. End to end on the database: builder rows saved through the one writer,
-- placed by the ladder. A job number in the subject lands direct; the same
-- email from a second mailbox is one row; a customer's email with no
-- reference lands on the job whose client email it is; our reply is
-- outbound on the same job; a group post plus-addressed to a job lands
-- direct; an attachment ledger row points at the evidence row.
CREATE OR REPLACE FUNCTION public.attribute_business_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.context_captured_at IS NULL THEN
    NEW.context_captured_at := clock_timestamp();
  END IF;
  NEW := public.resolve_context_attribution(NEW);
  RETURN NEW;
END $$;
CREATE TEMP TABLE em2_rows(label text PRIMARY KEY, r jsonb NOT NULL) ON COMMIT DROP;
-- ROWS BEGIN
INSERT INTO em2_rows(label,r) VALUES
 ('e_direct','{"event_type":"client.email_in","source":"outlook-mail-capture","entity_type":"email","entity_id":"email:em2-direct-0001@mail.example.com","job_id":null,"match_method":"none","event_at":"2026-10-01T02:00:00Z","provider_message_id":"email:em2-direct-0001@mail.example.com","channel":"email","direction":"inbound","thread_key":"outlook:AAQkAGEm2ConvDirect01=","body_preview":"Subject: Re: Patio quote SWP-990001 colour choice\n\nHi Nithin,\n\nWe would like Monument for the roof.\n\nThanks, Pat","safe_summary":"Subject: Re: Patio quote SWP-990001 colour choice\n\nHi Nithin,\n\nWe would like Monument for the roof.\n\nThanks, Pat","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"Subject: Re: Patio quote SWP-990001 colour choice\n\nHi Nithin,\n\nWe would like Monument for the roof.\n\nThanks, Pat","subject":"Re: Patio quote SWP-990001 colour choice","email":"pat.example@example.com","from":"pat.example@example.com","to":["nithin@secureworkswa.com.au"],"cc":[],"mailbox":"nithin@secureworkswa.com.au","folder_kind":"inbox","delivered_to":null,"line":null,"sender_kind":"customer","sent_by_kind":"external","sent_by_user":null,"internet_message_id":"em2-direct-0001@mail.example.com","conversation_id":"AAQkAGEm2ConvDirect01=","body_source":"unique_body","body_truncated":false,"body_chars_total":112,"has_attachments":true,"attachments":[{"name":"sketch.pdf","content_type":"application/pdf","size":120000,"inline":false,"kind":"file"},{"name":"logo.png","content_type":"image/png","size":4000,"inline":true,"kind":"file"}],"attachments_total":2,"references":["SWP-990001"],"event_at_source":"provider"},"metadata":{"capture_mode":"live","capture_path":"outlook_mail_v1"}}'::jsonb),
 ('e_direct_admin_copy','{"event_type":"client.email_in","source":"outlook-mail-capture","entity_type":"email","entity_id":"email:em2-direct-0001@mail.example.com","job_id":null,"match_method":"none","event_at":"2026-10-01T02:00:00Z","provider_message_id":"email:em2-direct-0001@mail.example.com","channel":"email","direction":"inbound","thread_key":"outlook:AAQkAGEm2ConvDirect01=","body_preview":"Subject: Re: Patio quote SWP-990001 colour choice\n\nHi Nithin,\n\nWe would like Monument for the roof.\n\nThanks, Pat","safe_summary":"Subject: Re: Patio quote SWP-990001 colour choice\n\nHi Nithin,\n\nWe would like Monument for the roof.\n\nThanks, Pat","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"Subject: Re: Patio quote SWP-990001 colour choice\n\nHi Nithin,\n\nWe would like Monument for the roof.\n\nThanks, Pat","subject":"Re: Patio quote SWP-990001 colour choice","email":"pat.example@example.com","from":"pat.example@example.com","to":["nithin@secureworkswa.com.au"],"cc":[],"mailbox":"admin@secureworkswa.com.au","folder_kind":"inbox","delivered_to":null,"line":null,"sender_kind":"customer","sent_by_kind":"external","sent_by_user":null,"internet_message_id":"em2-direct-0001@mail.example.com","conversation_id":"AAQkAGEm2ConvDirect01=","body_source":"unique_body","body_truncated":false,"body_chars_total":112,"has_attachments":true,"attachments":[{"name":"sketch.pdf","content_type":"application/pdf","size":120000,"inline":false,"kind":"file"},{"name":"logo.png","content_type":"image/png","size":4000,"inline":true,"kind":"file"}],"attachments_total":2,"references":["SWP-990001"],"event_at_source":"provider"},"metadata":{"capture_mode":"live","capture_path":"outlook_mail_v1"}}'::jsonb),
 ('e_identity','{"event_type":"client.email_in","source":"outlook-mail-capture","entity_type":"email","entity_id":"email:em2-identity-0002@mail.example.com","job_id":null,"match_method":"none","event_at":"2026-10-01T03:00:00Z","provider_message_id":"email:em2-identity-0002@mail.example.com","channel":"email","direction":"inbound","thread_key":"outlook:AAQkAGEm2ConvIdentity02=","body_preview":"Subject: When can you come out?\n\nIs Friday morning possible for the measure?","safe_summary":"Subject: When can you come out?\n\nIs Friday morning possible for the measure?","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"Subject: When can you come out?\n\nIs Friday morning possible for the measure?","subject":"When can you come out?","email":"sam.sample@example.net","from":"sam.sample@example.net","to":["nithin@secureworkswa.com.au"],"cc":[],"mailbox":"nithin@secureworkswa.com.au","folder_kind":"inbox","delivered_to":null,"line":null,"sender_kind":"customer","sent_by_kind":"external","sent_by_user":null,"internet_message_id":"em2-identity-0002@mail.example.com","conversation_id":"AAQkAGEm2ConvIdentity02=","body_source":"unique_body","body_truncated":false,"body_chars_total":76,"has_attachments":false,"attachments":[],"attachments_total":0,"references":[],"event_at_source":"provider"},"metadata":{"capture_mode":"live","capture_path":"outlook_mail_v1"}}'::jsonb),
 ('e_sent','{"event_type":"client.email_out","source":"outlook-mail-capture","entity_type":"email","entity_id":"email:sy4pr01mb0003@secureworkswa.com.au","job_id":null,"match_method":"none","event_at":"2026-10-01T03:30:00Z","provider_message_id":"email:sy4pr01mb0003@secureworkswa.com.au","channel":"email","direction":"outbound","thread_key":"outlook:AAQkAGEm2ConvIdentity02=","body_preview":"Subject: RE: When can you come out?\n\nFriday 9am works, see you then.","safe_summary":"Subject: RE: When can you come out?\n\nFriday 9am works, see you then.","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"Subject: RE: When can you come out?\n\nFriday 9am works, see you then.","subject":"RE: When can you come out?","email":"sam.sample@example.net","from":"nithin@secureworkswa.com.au","to":["sam.sample@example.net"],"cc":["admin@secureworkswa.com.au"],"mailbox":"nithin@secureworkswa.com.au","folder_kind":"sent","delivered_to":null,"line":null,"sender_kind":"ours","sent_by_kind":"staff_email","sent_by_user":"nithin@secureworkswa.com.au","internet_message_id":"sy4pr01mb0003@secureworkswa.com.au","conversation_id":"AAQkAGEm2ConvIdentity02=","body_source":"unique_body","body_truncated":false,"body_chars_total":68,"has_attachments":false,"attachments":[],"attachments_total":0,"references":[],"event_at_source":"provider"},"metadata":{"capture_mode":"live","capture_path":"outlook_mail_v1"}}'::jsonb),
 ('e_group_post','{"event_type":"client.email_in","source":"outlook-mail-capture","entity_type":"email","entity_id":"email:em2-post-0006@mail.example.org","job_id":null,"match_method":"none","event_at":"2026-10-01T06:00:00Z","provider_message_id":"email:em2-post-0006@mail.example.org","channel":"email","direction":"inbound","thread_key":"outlook:AAQkAGEm2GroupConv06=","body_preview":"Subject: Council approval 12 Example Street\nTo-tag: SWP-990001\n\nApproval attached.\nRegards, Planning","safe_summary":"Subject: Council approval 12 Example Street\nTo-tag: SWP-990001\n\nApproval attached.\nRegards, Planning","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"Subject: Council approval 12 Example Street\nTo-tag: SWP-990001\n\nApproval attached.\nRegards, Planning","subject":"Council approval 12 Example Street","email":"approvals@council.wa.gov.au","from":"approvals@council.wa.gov.au","to":["patios+swp-990001@secureworkswa.com.au"],"cc":[],"mailbox":"patios@secureworkswa.com.au","folder_kind":"group","delivered_to":"patios+swp-990001@secureworkswa.com.au","line":"patio","sender_kind":"council","sent_by_kind":"external","sent_by_user":null,"internet_message_id":"em2-post-0006@mail.example.org","conversation_id":"AAQkAGEm2GroupConv06=","body_source":"post_body_cut","body_truncated":false,"body_chars_total":100,"has_attachments":true,"attachments":[],"attachments_total":0,"references":["SWP-990001"],"event_at_source":"provider","to_tag":"SWP-990001"},"metadata":{"capture_mode":"live","capture_path":"outlook_mail_v1"}}'::jsonb);
-- ROWS END
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; job_a uuid:=gen_random_uuid(); job_b uuid:=gen_random_uuid();
 out jsonb; e public.business_events; ev uuid;
BEGIN
 UPDATE public.automation_switches SET capture=true, attribution=true WHERE id=1;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,metadata,client_email) VALUES
  (job_a,org,'scheduled','patio','SWP-990001','em2-contact-a','{}','pat.example@example.com'),
  (job_b,org,'accepted','patio','SWP-990002','em2-contact-b','{}','sam.sample@example.net');

 out:=public.capture_business_event((SELECT r FROM em2_rows WHERE label='e_direct'));
 IF out->>'outcome'<>'inserted' OR out->>'attribution_status'<>'direct' OR (out->>'job_id')::uuid<>job_a
 THEN RAISE EXCEPTION 'em2 direct: %',out; END IF;
 ev:=(out->>'id')::uuid;
 SELECT * INTO e FROM public.business_events WHERE id=ev;
 IF e.provider_message_id<>'email:em2-direct-0001@mail.example.com' OR e.channel<>'email' OR e.direction<>'inbound'
  OR e.event_type<>'client.email_in' OR e.metadata->>'capture_mode'<>'live' OR e.event_at<>'2026-10-01T02:00:00Z'
  OR e.payload->>'body' NOT LIKE 'Subject: Re: Patio quote SWP-990001%'
 THEN RAISE EXCEPTION 'em2 direct stored row %',to_jsonb(e); END IF;

 out:=public.capture_business_event((SELECT r FROM em2_rows WHERE label='e_direct_admin_copy'));
 IF out->>'outcome'<>'duplicate' OR (out->>'id')::uuid<>ev THEN RAISE EXCEPTION 'em2 second mailbox copy: %',out; END IF;
 IF (SELECT count(*) FROM public.business_events WHERE provider_message_id='email:em2-direct-0001@mail.example.com')<>1
 THEN RAISE EXCEPTION 'em2 one email stored twice'; END IF;

 out:=public.capture_business_event((SELECT r FROM em2_rows WHERE label='e_identity'));
 IF out->>'outcome'<>'inserted' OR (out->>'job_id')::uuid IS DISTINCT FROM job_b
 THEN RAISE EXCEPTION 'em2 identity: %',out; END IF;

 out:=public.capture_business_event((SELECT r FROM em2_rows WHERE label='e_sent'));
 SELECT * INTO e FROM public.business_events WHERE id=(out->>'id')::uuid;
 IF out->>'outcome'<>'inserted' OR e.job_id::uuid IS DISTINCT FROM job_b OR e.direction<>'outbound' OR e.event_type<>'client.email_out'
 THEN RAISE EXCEPTION 'em2 sent reply: % %',out,to_jsonb(e); END IF;

 out:=public.capture_business_event((SELECT r FROM em2_rows WHERE label='e_group_post'));
 IF out->>'outcome'<>'inserted' OR out->>'attribution_status'<>'direct' OR (out->>'job_id')::uuid<>job_a
 THEN RAISE EXCEPTION 'em2 group post To-tag: %',out; END IF;

 INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,business_event_id,status,sha256,storage_bucket,storage_path,file_name)
  VALUES('email:em2-direct-0001@mail.example.com',repeat('c',64),ev,'stored',repeat('d',64),'context-email-attachments','p/q/sketch.pdf','sketch.pdf');
 IF (SELECT b.job_id::uuid FROM public.context_email_attachments a JOIN public.business_events b ON b.id=a.business_event_id
     WHERE a.provider_message_id='email:em2-direct-0001@mail.example.com') IS DISTINCT FROM job_a
 THEN RAISE EXCEPTION 'em2 attachment does not reach its job'; END IF;

 -- Capture lane off: nothing written.
 UPDATE public.automation_switches SET capture=false WHERE id=1;
 out:=public.capture_business_event(jsonb_set((SELECT r FROM em2_rows WHERE label='e_direct'),'{provider_message_id}','"email:em2-lane-off@x.example"'));
 IF out->>'outcome'<>'capture_disabled' THEN RAISE EXCEPTION 'em2 lane off: %',out; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 6. The cron callers post only while reader, schedule and program flags are
-- all on, with the service key; the sweep posts once per selected source.
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE pg_temp.em2_posts(url text,body jsonb,headers jsonb,timeout_ms integer);
CREATE OR REPLACE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,headers jsonb DEFAULT '{}'::jsonb,
 timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO pg_temp.em2_posts VALUES(url,body,headers,timeout_milliseconds) RETURNING 1::bigint
$$;
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text LANGUAGE sql AS $$ SELECT 'eyJ.em2.fixture'::text $$;
SELECT public.trigger_context_email_poll();
SELECT public.trigger_context_email_sweep();
DO $$ BEGIN IF (SELECT count(*) FROM pg_temp.em2_posts)<>0 THEN RAISE EXCEPTION 'em2 posted with the flags off'; END IF; END $$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name IN ('email_reader_v1','email_capture_v2');
SELECT public.trigger_context_email_poll();
DO $$ BEGIN IF (SELECT count(*) FROM pg_temp.em2_posts)<>0 THEN RAISE EXCEPTION 'em2 posted without the schedule flag'; END IF; END $$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='email_reader_schedule_v1';
SELECT public.trigger_context_email_poll();
DO $$
DECLARE p record;
BEGIN
 SELECT * INTO p FROM pg_temp.em2_posts;
 IF (SELECT count(*) FROM pg_temp.em2_posts)<>1 OR p.url<>'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/outlook-mail-capture'
  OR p.headers->>'Authorization'<>'Bearer eyJ.em2.fixture' OR p.body<>'{"mode":"poll","actor":"cron:outlook-mail-poll"}' OR p.timeout_ms<>5000
 THEN RAISE EXCEPTION 'em2 poll post %',row_to_json(p); END IF;
 DELETE FROM pg_temp.em2_posts;
END $$;
SELECT public.trigger_context_email_sweep();
DO $$
DECLARE want text[];
BEGIN
 SELECT array_agg(source_key ORDER BY source_key) INTO want FROM public.monitored_mailboxes WHERE enabled AND status='active' AND kind IN ('user','group');
 IF cardinality(want)<1 OR (SELECT array_agg(body->>'source' ORDER BY body->>'source') FROM pg_temp.em2_posts) IS DISTINCT FROM want
  OR EXISTS(SELECT 1 FROM pg_temp.em2_posts WHERE body->>'mode'<>'sweep' OR body->>'actor'<>'cron:monitor-inbox-sweep')
 THEN RAISE EXCEPTION 'em2 sweep posts % want %',(SELECT jsonb_agg(body) FROM pg_temp.em2_posts),want; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 7. The schedule on a pg_cron stand-in: created gated, idempotent on
-- re-apply, a re-apply keeps the owner's flag setting, recognised by the
-- switch's wrap.
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY,schedule text NOT NULL,command text NOT NULL,active boolean NOT NULL DEFAULT true,jobname text);
CREATE FUNCTION cron.schedule(job_name text,schedule text,command text) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO cron.job(jobname,schedule,command) VALUES(job_name,schedule,command) RETURNING jobid
$$;
CREATE FUNCTION cron.alter_job(job_id bigint,schedule text DEFAULT NULL,command text DEFAULT NULL,database text DEFAULT NULL,
 username text DEFAULT NULL,active boolean DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
 UPDATE cron.job SET command=coalesce(alter_job.command,job.command) WHERE jobid=job_id
$$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='email_reader_v1';
-- A later slice (B-2, 20261005190000) replaces the lane list; stand this
-- migration's body back up (rolled back below) so its re-apply guard holds.
\ir em3_cron_lanes.sql
-- History daily (20261007050000) widens M4's live-job list, which this
-- migration's guard pins; stand M4's body back up the same way.
SELECT md5(prosrc)<>'49eb23015b724a29058c11b2743954bf' AS em2_list_moved
FROM pg_proc WHERE oid='public.context_ghl_history_live_jobs()'::regprocedure \gset
\if :em2_list_moved
\ir ../20261007050000_context_history_daily/m4_live_jobs.sql
\endif
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.automation_switch_cron_lanes()'::regprocedure)<>'5c1e0e526a74d5b4ad612792c7f076cc'
 THEN RAISE EXCEPTION 'em2 em3_cron_lanes.sql is not the EM3 body'; END IF;
END $$;
\ir ../../../migrations/20261002150000_context_email_reader.sql
\ir ../../../migrations/20261002150000_context_email_reader.sql
DO $$
DECLARE w record;
BEGIN
 IF (SELECT count(*) FROM cron.job WHERE jobname IN ('outlook-mail-poll','monitor-inbox-sweep'))<>2 THEN RAISE EXCEPTION 'em2 re-apply scheduled twice'; END IF;
 IF (SELECT schedule||' '||command FROM cron.job WHERE jobname='outlook-mail-poll')<>'2-59/5 * * * * SELECT public.trigger_context_email_poll() WHERE public.automation_lane_enabled(''capture'')'
  OR (SELECT schedule||' '||command FROM cron.job WHERE jobname='monitor-inbox-sweep')<>'0 18 * * * SELECT public.trigger_context_email_sweep() WHERE public.automation_lane_enabled(''capture'')'
 THEN RAISE EXCEPTION 'em2 jobs %',(SELECT jsonb_agg(row_to_json(j)) FROM cron.job j); END IF;
 IF (SELECT enabled FROM public.feature_flags WHERE flag_name='email_reader_v1') IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'em2 re-apply reset the owner''s flag'; END IF;
 SELECT * INTO w FROM public.automation_switch_wrap_cron_jobs() x WHERE x.cron_jobname='outlook-mail-poll';
 IF w.outcome<>'already_wrapped' THEN RAISE EXCEPTION 'em2 wrap %',row_to_json(w); END IF;
 SELECT * INTO w FROM public.automation_switch_wrap_cron_jobs() x WHERE x.cron_jobname='monitor-inbox-sweep';
 IF w.outcome<>'already_wrapped' THEN RAISE EXCEPTION 'em2 sweep wrap %',row_to_json(w); END IF;
END $$;
ROLLBACK;
