-- B-5 contract: the document text reader's database half. Every fixture write
-- is rolled back. Documents carry file names and fixture words only.

CREATE FUNCTION pg_temp.b5_job(p_number text,p_status text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001',p_status,'fencing',p_number,now()-interval '30 days');
 RETURN j;
END $$;
CREATE FUNCTION pg_temp.b5_doc(p_job uuid,p_name text,p_type text,p_at timestamptz,p_url text DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.job_documents(job_id,type,file_name,storage_url,created_at)
 VALUES(p_job,p_type,p_name,coalesce(p_url,p_job::text||'/'||p_name),p_at) RETURNING id
$$;
CREATE FUNCTION pg_temp.b5_row(p_job uuid,p_sha text,p_mode text,p_words text DEFAULT 'QUOTE Q-1001. Supply and install 24 m of Colorbond fence.') RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.capture_business_event(jsonb_build_object(
  'event_type','document.text_extracted','source','context-document-text','entity_type','job_document','entity_id',p_job::text,
  'job_id',p_job,'match_method','direct_job_id','event_at',now()-interval '1 day',
  'provider_message_id','doctext:'||p_job::text||':'||p_sha,'channel','document','direction','internal',
  'body_preview',left(p_words,500),'safe_summary','[Document text]','privacy_classification','staff_only','retention_class','7y_audit',
  'payload',jsonb_build_object('document_text',true,'text',p_words,'job_id',p_job::text),
  'metadata',jsonb_build_object('capture_mode',p_mode)))
$$;
CREATE FUNCTION pg_temp.b5_rec(p jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT public.record_context_document_text(p) $$;
CREATE FUNCTION pg_temp.b5_refused(p jsonb) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM public.record_context_document_text(p); RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;

BEGIN;
-- 1. Nothing widens public access.
DO $$
DECLARE f regprocedure;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_document_text_policy()','public.context_document_text_flag()',
  'public.record_context_document_text(jsonb)','public.context_document_text_sources()','public.context_document_text_due(integer)',
  'public.context_document_text_status()','public.trigger_context_document_text()','public.automation_switch_cron_lanes()']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('public',f,'EXECUTE')
  THEN RAISE EXCEPTION 'b5 public execute on %',f; END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid=f) IS NULL THEN RAISE EXCEPTION 'b5 % has no fixed search_path',f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_document_text_flag()','public.record_context_document_text(jsonb)',
  'public.context_document_text_sources()','public.context_document_text_due(integer)',
  'public.context_document_text_status()','public.trigger_context_document_text()']::regprocedure[] LOOP
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=f) THEN RAISE EXCEPTION 'b5 % must be SECURITY DEFINER',f; END IF;
 END LOOP;
 IF has_function_privilege('service_role','public.trigger_context_document_text()','EXECUTE')
 THEN RAISE EXCEPTION 'b5 the cron caller must not be callable by service_role'; END IF;
 IF NOT has_function_privilege('service_role','public.record_context_document_text(jsonb)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_document_text_due(integer)','EXECUTE')
 THEN RAISE EXCEPTION 'b5 service_role must reach the writer and the selection'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.context_document_texts'::regclass) THEN RAISE EXCEPTION 'b5 RLS off'; END IF;
 IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.context_document_texts'::regclass) THEN RAISE EXCEPTION 'b5 a policy exists'; END IF;
 IF has_table_privilege('anon','public.context_document_texts','SELECT') OR has_table_privilege('authenticated','public.context_document_texts','SELECT')
  OR has_table_privilege('anon','public.context_document_texts','INSERT') OR has_table_privilege('authenticated','public.context_document_texts','UPDATE')
 THEN RAISE EXCEPTION 'b5 public table access'; END IF;
 IF NOT has_table_privilege('service_role','public.context_document_texts','SELECT')
  OR has_table_privilege('service_role','public.context_document_texts','INSERT')
  OR has_table_privilege('service_role','public.context_document_texts','UPDATE')
  OR has_table_privilege('service_role','public.context_document_texts','DELETE')
 THEN RAISE EXCEPTION 'b5 service_role table grants'; END IF;
 -- The capture lane owns the job; the earlier jobs keep their lanes.
 IF NOT EXISTS(SELECT 1 FROM public.automation_switch_cron_lanes() WHERE cron_jobname='context-document-text' AND lane='capture')
 THEN RAISE EXCEPTION 'b5 context-document-text is not a capture-lane job'; END IF;
 IF NOT (ARRAY['monitor-inbox-poll','ghl-message-reconcile','ghl-call-transcript-fetch','outlook-mail-poll','monitor-inbox-sweep','ghl-history-schedule']
   <@ ARRAY(SELECT cron_jobname FROM public.automation_switch_cron_lanes() WHERE lane='capture'))
  OR NOT EXISTS(SELECT 1 FROM public.automation_switch_cron_lanes() WHERE cron_jobname='contact-matching' AND lane='attribution')
 THEN RAISE EXCEPTION 'b5 an earlier lane entry was lost'; END IF;
END $$;

-- 2. The flag fails closed, and the cron caller is idle while it is off (no
-- net schema exists here: a post would raise).
DO $$
BEGIN
 IF (public.context_document_text_flag()->>'enabled')::boolean THEN RAISE EXCEPTION 'b5 missing flag must read off'; END IF;
 IF public.context_document_text_flag()->>'state'<>'missing' THEN RAISE EXCEPTION 'b5 flag state'; END IF;
 PERFORM public.trigger_context_document_text();
 INSERT INTO public.feature_flags(flag_name,enabled,description) VALUES('context_document_text_v1',false,'b5 fixture');
 IF (public.context_document_text_flag()->>'enabled')::boolean THEN RAISE EXCEPTION 'b5 off flag must read off'; END IF;
 PERFORM public.trigger_context_document_text();
END $$;
ROLLBACK;

-- 3. Sources: documents on live jobs only, and attachments of email placed on
-- a live job; the due list, its order and capture mode.
BEGIN;
DO $$
DECLARE live_job uuid:=pg_temp.b5_job('SWF-9001','scheduled'); dead_job uuid:=pg_temp.b5_job('SWF-9002','cancelled');
 d_new uuid; d_old uuid; d_dead uuid; ev_placed uuid; ev_loose uuid; a_placed uuid; a_loose uuid; a_skipped uuid;
 n integer; modes text[]; kinds text[];
BEGIN
 d_new:=pg_temp.b5_doc(live_job,'quote-Q1001.pdf','quote',now()-interval '2 hours');
 d_old:=pg_temp.b5_doc(live_job,'work-order-SWF-9001.pdf','work_order',now()-interval '20 days');
 d_dead:=pg_temp.b5_doc(dead_job,'quote-Q1002.pdf','quote',now()-interval '1 hour');
 -- An email on the live job (a writer link) and one on no job.
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,job_id,match_method,event_at,provider_message_id,channel,direction,payload,metadata)
 VALUES('email.received','outlook-mail-capture','job',live_job::text,live_job,'direct_job_id',now()-interval '3 days','email:<b5-placed@fixture>','email','inbound',
  jsonb_build_object('body','Please find the purchase order attached.'),'{"capture_mode":"live"}') RETURNING id INTO ev_placed;
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,event_at,provider_message_id,channel,direction,payload,metadata)
 VALUES('email.received','outlook-mail-capture','email','x',now()-interval '1 day','email:<b5-loose@fixture>','email','inbound',
  jsonb_build_object('body','Newsletter.'),'{"capture_mode":"live"}') RETURNING id INTO ev_loose;
 IF (SELECT job_id FROM public.business_events WHERE id=ev_placed) IS DISTINCT FROM live_job
  OR NOT public.context_linked_status((SELECT attribution_status FROM public.business_events WHERE id=ev_placed))
 THEN RAISE EXCEPTION 'b5 fixture email not placed on the live job'; END IF;
 INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,business_event_id,file_name,content_type,size_bytes,sha256,storage_bucket,storage_path,status)
 VALUES('email:<b5-placed@fixture>',repeat('a',64),ev_placed,'PO-56001.pdf','application/pdf',1000,repeat('1',64),'context-email-attachments','b5/a.pdf','stored')
 RETURNING id INTO a_placed;
 INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,business_event_id,file_name,content_type,size_bytes,sha256,storage_bucket,storage_path,status)
 VALUES('email:<b5-loose@fixture>',repeat('b',64),ev_loose,'flyer.pdf','application/pdf',1000,repeat('2',64),'context-email-attachments','b5/b.pdf','stored')
 RETURNING id INTO a_loose;
 INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,business_event_id,file_name,content_type,status)
 VALUES('email:<b5-placed@fixture>',repeat('c',64),ev_placed,'logo.png','image/png','skipped_inline') RETURNING id INTO a_skipped;

 SELECT count(*) INTO n FROM public.context_document_text_sources() s WHERE s.source_id IN (d_new,d_old,d_dead,a_placed,a_loose,a_skipped);
 IF n<>3 THEN RAISE EXCEPTION 'b5 sources: expected 3 (two live-job documents and the placed email''s stored attachment), got %',n; END IF;
 IF EXISTS(SELECT 1 FROM public.context_document_text_sources() s WHERE s.source_id IN (d_dead,a_loose,a_skipped))
 THEN RAISE EXCEPTION 'b5 sources: a document off a live job, on an unplaced email or not stored was offered'; END IF;
 IF (SELECT s.job_id FROM public.context_document_text_sources() s WHERE s.source_id=a_placed) IS DISTINCT FROM live_job
 THEN RAISE EXCEPTION 'b5 sources: the attachment must sit on its email''s job'; END IF;

 SELECT array_agg(d.capture_mode ORDER BY d.doc_at DESC), array_agg(d.source_kind ORDER BY d.doc_at DESC) INTO modes, kinds
 FROM public.context_document_text_due(100) d WHERE d.source_id IN (d_new,d_old,a_placed);
 IF modes IS DISTINCT FROM ARRAY['live','backfill','backfill'] THEN RAISE EXCEPTION 'b5 due: capture modes %',modes; END IF;
 IF kinds IS DISTINCT FROM ARRAY['job_document','email_attachment','job_document'] THEN RAISE EXCEPTION 'b5 due: order %',kinds; END IF;
END $$;
ROLLBACK;

-- 4. The writer: saved names its evidence row; terminal outcomes stay; a
-- changed document reopens; errors back off then fail; refusals.
BEGIN;
DO $$
DECLARE j uuid:=pg_temp.b5_job('SWF-9003','in_progress'); d uuid; d2 uuid; sha text:=repeat('ab',32); res jsonb; ev uuid; r record; i integer;
 fp1 text; fp2 text;
BEGIN
 d:=pg_temp.b5_doc(j,'report.pdf','general',now()-interval '1 day');
 d2:=pg_temp.b5_doc(j,'photo.jpg','site_photo',now()-interval '1 day');
 fp1:=(SELECT x.fingerprint FROM public.context_document_text_sources() x WHERE x.source_id=d);
 -- Refusals.
 IF pg_temp.b5_refused('{"source_kind":"job_document"}') NOT LIKE 'document_text_%' THEN RAISE EXCEPTION 'b5 refuse incomplete'; END IF;
 IF pg_temp.b5_refused(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',j,'fingerprint',fp1,'file_kind','pdf','result','error'))
  <>'document_text_code_required' THEN RAISE EXCEPTION 'b5 an error needs a code'; END IF;
 IF pg_temp.b5_refused(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',j,'fingerprint',fp1,'file_kind','pdf','result','saved',
   'sha256',sha,'event_id',gen_random_uuid())) <>'document_text_event_not_found' THEN RAISE EXCEPTION 'b5 saved needs its evidence row'; END IF;
 IF pg_temp.b5_refused(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',pg_temp.b5_job('SWF-9004','scheduled'),
   'fingerprint',fp1,'file_kind','pdf','result','no_text_layer')) <>'document_text_source_not_found' THEN RAISE EXCEPTION 'b5 the source must be the job''s'; END IF;
 IF pg_temp.b5_refused(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',j,'fingerprint',fp1,'file_kind','pdf','result','saved',
   'sha256',sha,'event_id',gen_random_uuid(),'words','x')) <>'document_text_invalid' THEN RAISE EXCEPTION 'b5 no words key accepted'; END IF;

 -- Saved: the evidence row, through the one writer, lands on the job.
 res:=pg_temp.b5_row(j,sha,'live');
 IF res->>'outcome'<>'inserted' THEN RAISE EXCEPTION 'b5 capture %',res; END IF;
 ev:=(res->>'id')::uuid;
 IF (SELECT job_id FROM public.business_events WHERE id=ev) IS DISTINCT FROM j
  OR NOT public.context_linked_status((SELECT attribution_status FROM public.business_events WHERE id=ev))
 THEN RAISE EXCEPTION 'b5 the document row must sit on its own job'; END IF;
 -- It is readable evidence: the one unread definition hands it to the reader.
 IF NOT EXISTS(SELECT 1 FROM public.context_unread_rows(ARRAY[j]) u WHERE u.id=ev)
 THEN RAISE EXCEPTION 'b5 the document row is not unread readable evidence'; END IF;
 -- A second copy of the same bytes on the same job is the same row.
 IF pg_temp.b5_row(j,sha,'live')->>'outcome'<>'duplicate' THEN RAISE EXCEPTION 'b5 same bytes on one job must dedupe'; END IF;

 res:=pg_temp.b5_rec(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',j,'fingerprint',fp1,'file_kind','pdf','result','saved',
  'sha256',sha,'event_id',ev,'page_count',2,'char_count',812,'truncated',false));
 IF res->>'outcome'<>'saved' THEN RAISE EXCEPTION 'b5 saved %',res; END IF;
 SELECT * INTO r FROM public.context_document_texts WHERE source_id=d;
 IF r.event_id<>ev OR r.sha256<>sha OR r.page_count<>2 OR r.char_count<>812 OR r.finished_at IS NULL THEN RAISE EXCEPTION 'b5 saved record'; END IF;
 -- No longer due; terminal and unchanged on a repeat.
 IF EXISTS(SELECT 1 FROM public.context_document_text_due(100) x WHERE x.source_id=d) THEN RAISE EXCEPTION 'b5 a saved document is still due'; END IF;
 IF pg_temp.b5_rec(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',j,'fingerprint',fp1,'file_kind','pdf','result','no_text_layer'))->>'outcome'<>'unchanged'
 THEN RAISE EXCEPTION 'b5 a terminal record must not move'; END IF;
 -- The document changed (re-uploaded under another location): due again, reopened.
 UPDATE public.job_documents SET storage_url=j::text||'/report-v2.pdf' WHERE id=d;
 IF NOT EXISTS(SELECT 1 FROM public.context_document_text_due(100) x WHERE x.source_id=d) THEN RAISE EXCEPTION 'b5 a changed document is not due'; END IF;
 fp2:=(SELECT x.fingerprint FROM public.context_document_text_sources() x WHERE x.source_id=d);
 IF fp2=fp1 THEN RAISE EXCEPTION 'b5 the fingerprint must follow the stored location'; END IF;
 res:=pg_temp.b5_rec(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',j,'fingerprint',fp2,'file_kind','pdf','result','no_text_layer','code','no_text_layer'));
 IF res->>'outcome'<>'no_text_layer' OR NOT (res->>'reopened')::boolean THEN RAISE EXCEPTION 'b5 reopen %',res; END IF;
 IF (SELECT event_id FROM public.context_document_texts WHERE source_id=d) IS NOT NULL THEN RAISE EXCEPTION 'b5 a reopened record keeps no old event'; END IF;

 -- Errors: 15 min, 1 h, 6 h, 24 h, then failed.
 FOR i IN 1..4 LOOP
  res:=pg_temp.b5_rec(jsonb_build_object('source_kind','job_document','source_id',d2,'job_id',j,'fingerprint',fp1,'file_kind','image','result','error','code','download_http_503'));
  IF res->>'state'<>'pending' THEN RAISE EXCEPTION 'b5 error % must wait',i; END IF;
 END LOOP;
 IF (SELECT next_at FROM public.context_document_texts WHERE source_id=d2) < clock_timestamp()+interval '23 hours'
 THEN RAISE EXCEPTION 'b5 the fourth wait is 24 hours'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_document_text_due(100) x WHERE x.source_id=d2) THEN RAISE EXCEPTION 'b5 a waiting document is due'; END IF;
 res:=pg_temp.b5_rec(jsonb_build_object('source_kind','job_document','source_id',d2,'job_id',j,'fingerprint',fp1,'file_kind','image','result','error','code','download_http_503'));
 IF res->>'outcome'<>'failed:download_http_503' THEN RAISE EXCEPTION 'b5 fifth error %',res; END IF;
END $$;
ROLLBACK;

-- 4b. With P4's placement rules on, the writer's job still holds (custody).
BEGIN;
DO $$
DECLARE j uuid:=pg_temp.b5_job('SWF-9006','scheduled'); res jsonb;
BEGIN
 INSERT INTO public.feature_flags(flag_name,enabled,description) VALUES('context_unlinked_rules_v1',true,'b5 fixture')
 ON CONFLICT (flag_name) DO UPDATE SET enabled=true;
 res:=pg_temp.b5_row(j,repeat('ef',32),'live');
 IF res->>'outcome'<>'inserted' OR (res->>'job_id')::uuid IS DISTINCT FROM j OR res->>'attribution_status'<>'direct'
 THEN RAISE EXCEPTION 'b5 rules on: the document row left its job %',res; END IF;
END $$;
ROLLBACK;

-- 5. Status: counts for live jobs, and no alarms while the flag is off.
BEGIN;
DO $$
DECLARE j uuid:=pg_temp.b5_job('SWF-9005','accepted'); a uuid; b uuid; c uuid; s jsonb; ev uuid; sha text:=repeat('cd',32);
BEGIN
 a:=pg_temp.b5_doc(j,'quote.pdf','quote',now()-interval '1 day');
 b:=pg_temp.b5_doc(j,'scan.pdf','other',now()-interval '1 day');
 c:=pg_temp.b5_doc(j,'site.jpg','site_photo',now()-interval '1 day');
 ev:=(pg_temp.b5_row(j,sha,'backfill')->>'id')::uuid;
 PERFORM pg_temp.b5_rec(jsonb_build_object('source_kind','job_document','source_id',a,'job_id',j,
  'fingerprint',(SELECT x.fingerprint FROM public.context_document_text_sources() x WHERE x.source_id=a),'file_kind','pdf','result','saved','sha256',sha,'event_id',ev));
 PERFORM pg_temp.b5_rec(jsonb_build_object('source_kind','job_document','source_id',b,'job_id',j,
  'fingerprint',(SELECT x.fingerprint FROM public.context_document_text_sources() x WHERE x.source_id=b),'file_kind','pdf','result','no_text_layer'));
 s:=public.context_document_text_status();
 IF (s->'documents'->>'with_text')::integer<1 OR (s->'documents'->>'no_text_layer_pdf')::integer<1 OR (s->'documents'->>'never_tried')::integer<1
 THEN RAISE EXCEPTION 'b5 status counts %',s->'documents'; END IF;
 IF (s->'documents'->>'total')::integer<>(SELECT count(*) FROM public.context_document_text_sources()) THEN RAISE EXCEPTION 'b5 status total'; END IF;
 IF jsonb_array_length(s->'alarms')<>0 THEN RAISE EXCEPTION 'b5 no alarm while the flag is off'; END IF;
 -- A backfill document row is never a waking row on its own (K1): it is
 -- read when its job is listed for reading.
 IF (SELECT metadata->>'capture_mode' FROM public.business_events WHERE id=ev)<>'backfill' THEN RAISE EXCEPTION 'b5 capture mode kept'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 5b. A history document row lists its job for reading through the one
-- history re-list the edge function calls (B-1, context_catchup_list_backfill).
DO $$
DECLARE j uuid:=pg_temp.b5_job('SWF-9007','scheduled'); res jsonb;
BEGIN
 PERFORM pg_temp.b5_row(j,repeat('9a',32),'backfill');
 res:=public.context_catchup_list_backfill('context-document-text',now()-interval '1 day',false,500,2);
 IF NOT EXISTS(SELECT 1 FROM public.context_catchup_jobs c WHERE c.job_id=j AND c.done_at IS NULL)
 THEN RAISE EXCEPTION 'b5 re-list: the job with a history document was not listed %',res; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 6. The schedule on a pg_cron stand-in: created gated, once, on a re-apply.
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY,schedule text NOT NULL,command text NOT NULL,active boolean NOT NULL DEFAULT true,jobname text);
CREATE FUNCTION cron.schedule(job_name text,schedule text,command text) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO cron.job(jobname,schedule,command) VALUES(job_name,schedule,command) RETURNING jobid
$$;
-- Later slices (history daily, 20261007050000; history depth, 20261007080000)
-- add their jobs to the lane list, and history daily widens M4's live-job
-- list, both pinned by this migration's guard; stand those bodies back up
-- (rolled back below) so the re-apply is tested against the pre-images it
-- was written for.
SELECT md5(prosrc) NOT IN ('8c99245789cadf661d4b6be1207f0887','99e6d70e80a79e548f2478b65fc6cd78') AS b5_lanes_moved
FROM pg_proc WHERE oid='public.automation_switch_cron_lanes()'::regprocedure \gset
\if :b5_lanes_moved
\ir b5_cron_lanes.sql
\endif
SELECT md5(prosrc)<>'49eb23015b724a29058c11b2743954bf' AS b5_list_moved
FROM pg_proc WHERE oid='public.context_ghl_history_live_jobs()'::regprocedure \gset
\if :b5_list_moved
\ir ../20261007050000_context_history_daily/m4_live_jobs.sql
\endif
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.automation_switch_cron_lanes()'::regprocedure)
   NOT IN ('8c99245789cadf661d4b6be1207f0887','99e6d70e80a79e548f2478b65fc6cd78')
 THEN RAISE EXCEPTION 'b5 b5_cron_lanes.sql is not the B-5 body'; END IF;
END $$;
\ir ../../../migrations/20261005210000_context_document_text.sql
\ir ../../../migrations/20261005210000_context_document_text.sql
DO $$
BEGIN
 IF (SELECT count(*) FROM cron.job WHERE jobname='context-document-text')<>1 THEN RAISE EXCEPTION 'b5 re-apply scheduled twice'; END IF;
 IF (SELECT schedule||' '||command FROM cron.job WHERE jobname='context-document-text')
   <>'7-59/10 * * * * SELECT public.trigger_context_document_text() WHERE public.automation_lane_enabled(''capture'')'
 THEN RAISE EXCEPTION 'b5 job %',(SELECT jsonb_agg(row_to_json(j)) FROM cron.job j); END IF;
END $$;
ROLLBACK;
