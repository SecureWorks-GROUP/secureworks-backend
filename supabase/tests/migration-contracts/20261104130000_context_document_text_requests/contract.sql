-- Requests contract: named reads, reads on no job, a raised size limit, and the vision path for a
-- requested scan. Every fixture write is rolled back. Documents carry file names and fixture words only.

CREATE FUNCTION pg_temp.q_job(p_number text,p_status text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001',p_status,'fencing',p_number,now()-interval '30 days');
 RETURN j;
END $$;
CREATE FUNCTION pg_temp.q_doc(p_job uuid,p_name text,p_at timestamptz) RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.job_documents(job_id,type,file_name,storage_url,created_at)
 VALUES(p_job,'quote',p_name,p_job::text||'/'||p_name,p_at) RETURNING id
$$;
-- An inbound email, on a job (a writer link) or on no job.
CREATE FUNCTION pg_temp.q_email(p_job uuid,p_key text,p_at timestamptz) RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,job_id,match_method,event_at,provider_message_id,channel,direction,payload,metadata)
 VALUES('supplier.email_in','outlook-mail-capture',CASE WHEN p_job IS NULL THEN 'email' ELSE 'job' END,coalesce(p_job::text,'x'),p_job,
  CASE WHEN p_job IS NOT NULL THEN 'direct_job_id' END,p_at,'email:<'||p_key||'@fixture>','email','inbound',
  jsonb_build_object('body','Invoice attached.'),'{"capture_mode":"live"}') RETURNING id
$$;
CREATE FUNCTION pg_temp.q_att(p_email uuid,p_key text,p_name text,p_sha text,p_size integer DEFAULT 150000) RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,business_event_id,file_name,content_type,size_bytes,sha256,storage_bucket,storage_path,status)
 VALUES('email:<'||p_key||'@fixture>',md5(p_key)||md5(p_name),p_email,p_name,'application/pdf',p_size,p_sha,'context-email-attachments','q/'||p_key||'/'||p_name,'stored')
 RETURNING id
$$;
CREATE FUNCTION pg_temp.q_request(p_kind text,p_id uuid,p_max integer DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.context_document_text_requests(source_kind,source_id,max_pdf_bytes,requested_by,reason)
 VALUES(p_kind,p_id,p_max,'contract','fixture request')
$$;
CREATE FUNCTION pg_temp.q_src(p_id uuid) RETURNS record LANGUAGE sql AS $$
 SELECT s.job_id,s.fingerprint FROM public.context_document_text_sources() s WHERE s.source_id=p_id
$$;
CREATE FUNCTION pg_temp.q_fp(p_id uuid) RETURNS text LANGUAGE sql AS $$
 SELECT s.fingerprint FROM public.context_document_text_sources() s WHERE s.source_id=p_id
$$;
CREATE FUNCTION pg_temp.q_rec(p jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT public.record_context_document_text(p) $$;
CREATE FUNCTION pg_temp.q_refused(p jsonb) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM public.record_context_document_text(p); RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
CREATE FUNCTION pg_temp.q_vrefused(p jsonb) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM public.record_context_document_vision(p); RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
-- The evidence row a requested read on no job saves, as the edge function builds it: no job, keyed
-- doctext:no_job:<sha256>, marked automated. Its words name a live job and its number on purpose.
CREATE FUNCTION pg_temp.q_nojob_row(p_att uuid,p_sha text,p_words text,p_source text DEFAULT 'context-document-text') RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.capture_business_event(jsonb_build_object(
  'event_type','document.text_extracted','source',p_source,'entity_type','email_attachment','entity_id',p_att::text,
  'event_at',now()-interval '6 days','provider_message_id','doctext:no_job:'||p_sha,'channel','document','direction','internal',
  'body_preview',left(p_words,500),'safe_summary','[Document text]','privacy_classification','staff_only','retention_class','7y_audit',
  'payload',jsonb_build_object('document_text',true,'words',true,'channel','document','text',p_words,'job_id',NULL,'automated',true,'no_job',true),
  'metadata',jsonb_build_object('capture_mode','backfill','requested_read',true)))
$$;

-- 1. Access: the request table and the two new functions are service-side only; the ten replaced
--    functions keep theirs.
BEGIN;
DO $$
DECLARE f regprocedure;
BEGIN
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.context_document_text_requests'::regclass) THEN RAISE EXCEPTION 'requests: RLS off'; END IF;
 IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.context_document_text_requests'::regclass) THEN RAISE EXCEPTION 'requests: a policy exists'; END IF;
 IF has_table_privilege('anon','public.context_document_text_requests','SELECT') OR has_table_privilege('authenticated','public.context_document_text_requests','SELECT')
  OR has_table_privilege('anon','public.context_document_text_requests','INSERT') OR has_table_privilege('authenticated','public.context_document_text_requests','INSERT')
 THEN RAISE EXCEPTION 'requests: public table access'; END IF;
 IF NOT has_table_privilege('service_role','public.context_document_text_requests','SELECT')
  OR has_table_privilege('service_role','public.context_document_text_requests','INSERT')
  OR has_table_privilege('service_role','public.context_document_text_requests','UPDATE')
  OR has_table_privilege('service_role','public.context_document_text_requests','DELETE')
 THEN RAISE EXCEPTION 'requests: service_role may only read the requests'; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_document_text_policy()','public.context_document_text_sources()',
  'public.context_document_text_due(integer)','public.context_document_text_requested_due(integer)',
  'public.record_context_document_text(jsonb)','public.context_document_text_status()',
  'public.context_document_vision_due(integer)','public.context_document_vision_requested_due(integer)',
  'public.claim_context_document_vision(jsonb)','public.record_context_document_vision(jsonb)',
  'public.context_document_vision_leased(uuid)','public.context_document_vision_status()']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('public',f,'EXECUTE')
  THEN RAISE EXCEPTION 'requests: public execute on %',f; END IF;
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'requests: service_role cannot run %',f; END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid=f) IS NULL THEN RAISE EXCEPTION 'requests: % has no fixed search_path',f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_document_text_requested_due(integer)','public.context_document_vision_requested_due(integer)']::regprocedure[] LOOP
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=f) THEN RAISE EXCEPTION 'requests: % must be SECURITY DEFINER',f; END IF;
 END LOOP;
 IF public.context_document_text_policy()->>'no_job_key'<>'no_job' OR (public.context_document_text_policy()->>'request_max_pdf_bytes')::integer<>20000000
  OR (public.context_document_text_policy()->>'batch_limit')::integer<>20 OR public.context_document_text_policy()->>'key_prefix'<>'doctext:'
 THEN RAISE EXCEPTION 'requests: policy %',public.context_document_text_policy(); END IF;
END $$;
-- The request table's bounds.
DO $$
BEGIN
 BEGIN
  INSERT INTO public.context_document_text_requests(source_kind,source_id,max_pdf_bytes,requested_by,reason) VALUES('email_attachment',gen_random_uuid(),20000001,'contract','x');
  RAISE EXCEPTION 'requests: a limit over 20 MB was taken';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO public.context_document_text_requests(source_kind,source_id,max_pdf_bytes,requested_by,reason) VALUES('email_attachment',gen_random_uuid(),5000000,'contract','x');
  RAISE EXCEPTION 'requests: a limit at or under the 5 MB default was taken';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO public.context_document_text_requests(source_kind,source_id,requested_by,reason) VALUES('email_attachment',gen_random_uuid(),'contract',' ');
  RAISE EXCEPTION 'requests: a blank reason was taken';
 EXCEPTION WHEN check_violation THEN NULL; END;
 -- A read on no job is only ever an email attachment's, and only one per attachment.
 BEGIN
  INSERT INTO public.context_document_texts(source_kind,source_id,job_id,source_fingerprint,file_kind,outcome,attempts,finished_at)
  VALUES('job_document',gen_random_uuid(),NULL,md5('x'),'pdf','no_text_layer',1,now());
  RAISE EXCEPTION 'requests: a job document was recorded on no job';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO public.context_document_vision_reads(source_kind,source_id,job_id,source_fingerprint,file_kind,outcome,attempts,finished_at)
  VALUES('job_document',gen_random_uuid(),NULL,md5('x'),'pdf','no_text',1,now());
  RAISE EXCEPTION 'requests: a job document vision read was recorded on no job';
 EXCEPTION WHEN check_violation THEN NULL; END;
 IF NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid='public.context_document_texts_one_no_job'::regclass AND i.indisunique)
  OR NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid='public.context_document_vision_reads_one_no_job'::regclass AND i.indisunique)
 THEN RAISE EXCEPTION 'requests: no one-per-attachment index for reads on no job'; END IF;
END $$;
ROLLBACK;

-- 2. Nothing else moves: with no request, every document keeps exactly its 20261005210000
--    fingerprint, an unplaced email's attachment is still no source, and nothing new is due.
BEGIN;
DO $$
DECLARE live_job uuid:=pg_temp.q_job('SWF-9301','scheduled'); d uuid; e_on uuid; e_off uuid; a_on uuid; a_off uuid; fp text;
BEGIN
 d:=pg_temp.q_doc(live_job,'quote-Q3001.pdf',now()-interval '3 days');
 e_on:=pg_temp.q_email(live_job,'q-on',now()-interval '3 days');
 e_off:=pg_temp.q_email(NULL,'q-off',now()-interval '3 days');
 IF (SELECT job_id FROM public.business_events WHERE id=e_off) IS NOT NULL THEN RAISE EXCEPTION 'requests fixture: the loose email was placed'; END IF;
 a_on:=pg_temp.q_att(e_on,'q-on','PO-1.pdf',repeat('1',64));
 a_off:=pg_temp.q_att(e_off,'q-off','INV-1.pdf',repeat('2',64));
 SELECT md5(concat_ws('|',coalesce(x.storage_url,''),coalesce(x.pdf_url,''),coalesce(x.file_name,''),coalesce(x.version::text,''))) INTO fp
 FROM public.job_documents x WHERE x.id=d;
 IF pg_temp.q_fp(d) IS DISTINCT FROM fp THEN RAISE EXCEPTION 'requests: a job document''s fingerprint changed with no request'; END IF;
 SELECT md5(concat_ws('|',a.storage_bucket,a.storage_path,coalesce(a.sha256,''),coalesce(a.file_name,''))) INTO fp
 FROM public.context_email_attachments a WHERE a.id=a_on;
 IF pg_temp.q_fp(a_on) IS DISTINCT FROM fp THEN RAISE EXCEPTION 'requests: an attachment''s fingerprint changed with no request'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_document_text_sources() s WHERE s.source_id=a_off)
  OR EXISTS(SELECT 1 FROM public.context_document_text_requested_due(100) s WHERE s.source_id IN (d,a_on,a_off))
 THEN RAISE EXCEPTION 'requests: an unrequested document was offered as requested, or an unplaced attachment was offered'; END IF;
 IF (SELECT count(*) FROM public.context_document_text_due(100) s WHERE s.source_id IN (d,a_on))<>2 THEN RAISE EXCEPTION 'requests: the ordinary due list lost a document'; END IF;
END $$;
ROLLBACK;

-- 3. A requested attachment whose email is on no job: a source on no job, handed out only by the
--    requested list (always history), recorded on no job, and its evidence row never placed.
BEGIN;
DO $$
DECLARE live_job uuid:=pg_temp.q_job('SWF-9302','in_progress'); e_off uuid; e_on uuid; e_dead uuid; a_off uuid; a_on uuid; a_dead uuid; a_doc uuid;
 sha text:=repeat('a3',32); fp text; r jsonb; ev uuid; t record; e record; n integer;
BEGIN
 e_off:=pg_temp.q_email(NULL,'q3-off',now()-interval '6 hours');
 e_on:=pg_temp.q_email(live_job,'q3-on',now()-interval '6 days');
 e_dead:=pg_temp.q_email(pg_temp.q_job('SWF-9303','cancelled'),'q3-dead',now()-interval '6 days');
 a_off:=pg_temp.q_att(e_off,'q3-off','INV-90770.pdf',sha);
 a_on:=pg_temp.q_att(e_on,'q3-on','PO-2.pdf',repeat('3',64));
 a_dead:=pg_temp.q_att(e_dead,'q3-dead','INV-3.pdf',repeat('4',64));
 a_doc:=pg_temp.q_doc(live_job,'plan.pdf',now()-interval '6 days');
 PERFORM pg_temp.q_request('email_attachment',a_off);
 PERFORM pg_temp.q_request('email_attachment',a_on);
 PERFORM pg_temp.q_request('email_attachment',a_dead);
 -- Sources: the unplaced one on no job, the placed one on its job, the one on a dead job not at all.
 IF NOT EXISTS(SELECT 1 FROM public.context_document_text_sources() s WHERE s.source_id=a_off AND s.job_id IS NULL AND s.job_number IS NULL)
 THEN RAISE EXCEPTION 'requests: the requested unplaced attachment is not a source on no job'; END IF;
 IF (SELECT s.job_id FROM public.context_document_text_sources() s WHERE s.source_id=a_on) IS DISTINCT FROM live_job
  OR (SELECT count(*) FROM public.context_document_text_sources() s WHERE s.source_id=a_on)<>1
 THEN RAISE EXCEPTION 'requests: a requested attachment on a live job must stay on that job, once'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_document_text_sources() s WHERE s.source_id=a_dead)
 THEN RAISE EXCEPTION 'requests: an attachment on a job that is not live was offered'; END IF;
 -- The interlock: the ordinary due list never shows a requested document.
 IF EXISTS(SELECT 1 FROM public.context_document_text_due(100) s WHERE s.source_id IN (a_off,a_on))
 THEN RAISE EXCEPTION 'requests: the ordinary due list showed a requested document'; END IF;
 SELECT count(*) INTO n FROM public.context_document_text_requested_due(100) s
  WHERE s.source_id=a_off AND s.job_id IS NULL AND s.capture_mode='backfill' AND s.max_pdf_bytes IS NULL AND s.attempts=0;
 IF n<>1 THEN RAISE EXCEPTION 'requests: the requested list must show the unplaced attachment once, on no job, as history (it is 6 hours old)'; END IF;
 IF (SELECT s.capture_mode FROM public.context_document_text_requested_due(100) s WHERE s.source_id=a_on)<>'backfill'
 THEN RAISE EXCEPTION 'requests: a 6-day-old attachment is history'; END IF;
 fp:=pg_temp.q_fp(a_off);
 -- Refusals: no job only for a requested attachment whose email is on no job.
 IF pg_temp.q_refused(jsonb_build_object('source_kind','job_document','source_id',a_doc,'fingerprint',fp,'file_kind','pdf','result','no_text_layer'))
  <>'document_text_source_not_found' THEN RAISE EXCEPTION 'requests: a job document was taken on no job'; END IF;
 IF pg_temp.q_refused(jsonb_build_object('source_kind','email_attachment','source_id',a_on,'job_id',NULL,'fingerprint',fp,'file_kind','pdf','result','no_text_layer'))
  <>'document_text_source_not_found' THEN RAISE EXCEPTION 'requests: an attachment whose email is on a job was taken on no job'; END IF;
 DELETE FROM public.context_document_text_requests WHERE source_id=a_off;
 IF pg_temp.q_refused(jsonb_build_object('source_kind','email_attachment','source_id',a_off,'fingerprint',fp,'file_kind','pdf','result','no_text_layer'))
  <>'document_text_source_not_found' THEN RAISE EXCEPTION 'requests: an unrequested attachment was taken on no job'; END IF;
 PERFORM pg_temp.q_request('email_attachment',a_off);
 -- Saved on no job: the evidence row lands on no job although its words name a live job's number.
 r:=pg_temp.q_nojob_row(a_off,sha,'TAX INVOICE INV-90770. Deliver to SWF-9302. 6 x posts.');
 IF r->>'outcome'<>'inserted' THEN RAISE EXCEPTION 'requests: capture %',r; END IF;
 ev:=(r->>'id')::uuid;
 SELECT * INTO e FROM public.business_events WHERE id=ev;
 IF e.job_id IS NOT NULL OR e.attribution_status IS DISTINCT FROM 'automated' THEN
  RAISE EXCEPTION 'requests: the no-job evidence row was placed (job %, status %)',e.job_id,e.attribution_status;
 END IF;
 IF pg_temp.q_refused(jsonb_build_object('source_kind','email_attachment','source_id',a_off,'fingerprint',fp,'file_kind','pdf','result','saved',
   'sha256',repeat('ff',32),'event_id',ev))<>'document_text_event_not_found' THEN RAISE EXCEPTION 'requests: a saved read must name its own evidence row'; END IF;
 r:=pg_temp.q_rec(jsonb_build_object('source_kind','email_attachment','source_id',a_off,'job_id',NULL,'fingerprint',fp,'file_kind','pdf','result','saved',
  'sha256',sha,'event_id',ev,'page_count',1,'char_count',52,'truncated',false));
 IF r->>'outcome'<>'saved' THEN RAISE EXCEPTION 'requests: record saved %',r; END IF;
 SELECT * INTO t FROM public.context_document_texts WHERE source_id=a_off;
 IF t.job_id IS NOT NULL OR t.outcome<>'saved' OR t.event_id IS DISTINCT FROM ev OR t.char_count<>52 THEN RAISE EXCEPTION 'requests: record %',row_to_json(t); END IF;
 IF EXISTS(SELECT 1 FROM public.context_document_text_requested_due(100) s WHERE s.source_id=a_off)
 THEN RAISE EXCEPTION 'requests: a saved requested document is still due'; END IF;
 IF pg_temp.q_rec(jsonb_build_object('source_kind','email_attachment','source_id',a_off,'fingerprint',fp,'file_kind','pdf','result','no_text_layer'))->>'outcome'<>'unchanged'
 THEN RAISE EXCEPTION 'requests: a terminal read on no job must stay'; END IF;
 IF (SELECT count(*) FROM public.context_document_texts WHERE source_id=a_off)<>1 THEN RAISE EXCEPTION 'requests: two records for one read on no job'; END IF;
 -- A placed evidence row is never accepted as a read on no job.
 UPDATE public.business_events SET job_id=live_job WHERE id=ev;
 DELETE FROM public.context_document_texts WHERE source_id=a_off;
 IF pg_temp.q_refused(jsonb_build_object('source_kind','email_attachment','source_id',a_off,'fingerprint',fp,'file_kind','pdf','result','saved',
   'sha256',sha,'event_id',ev))<>'document_text_event_not_found' THEN RAISE EXCEPTION 'requests: a placed row was accepted as a read on no job'; END IF;
END $$;
ROLLBACK;

-- 4. The ladder never places a requested read on no job, with the unlinked rules on as in
--    production (the fixtures run with them off, which the section above covered).
BEGIN;
DO $$
DECLARE live_job uuid:=pg_temp.q_job('SWF-9304','in_progress'); a uuid; r jsonb; e record;
BEGIN
 INSERT INTO public.feature_flags(flag_name,enabled,description) VALUES('context_unlinked_rules_v1',true,'requests fixture')
  ON CONFLICT (flag_name) DO UPDATE SET enabled=true, updated_at=now();
 IF NOT public.context_unlinked_rules_enabled() THEN RAISE EXCEPTION 'requests fixture: rules still off'; END IF;
 a:=pg_temp.q_att(pg_temp.q_email(NULL,'q4-off',now()-interval '6 days'),'q4-off','INV-4.pdf',repeat('a4',32));
 r:=pg_temp.q_nojob_row(a,repeat('a4',32),'TAX INVOICE 10095132. Job SWF-9304. Site 12 Fixture Street.');
 SELECT * INTO e FROM public.business_events WHERE id=(r->>'id')::uuid;
 IF r->>'outcome'<>'inserted' OR e.job_id IS NOT NULL OR e.attribution_status IS DISTINCT FROM 'automated' THEN
  RAISE EXCEPTION 'requests: with the rules on the no-job row was placed (outcome %, job %, status %)',r->>'outcome',e.job_id,e.attribution_status;
 END IF;
 -- Control: the same words without the automated mark ARE placed on the job they name, so the mark
 -- is what keeps a read on no job off every job.
 r:=public.capture_business_event(jsonb_build_object(
  'event_type','document.text_extracted','source','context-document-text','entity_type','email_attachment','entity_id',a::text,
  'event_at',now()-interval '6 days','provider_message_id','doctext:control:'||repeat('a4',32),'channel','document','direction','internal',
  'body_preview','TAX INVOICE 10095132. Job SWF-9304.','safe_summary','[Document text]','privacy_classification','staff_only','retention_class','7y_audit',
  'payload',jsonb_build_object('document_text',true,'text','TAX INVOICE 10095132. Job SWF-9304.'),
  'metadata',jsonb_build_object('capture_mode','backfill')));
 IF (SELECT job_id FROM public.business_events WHERE id=(r->>'id')::uuid) IS DISTINCT FROM live_job THEN
  RAISE EXCEPTION 'requests fixture: the control row was not placed, so this section proves nothing';
 END IF;
END $$;
ROLLBACK;

-- 5. A raised size limit on a live job's document reopens its terminal too_large read once, at
--    that limit; removing the request puts the old fingerprint back.
BEGIN;
DO $$
DECLARE live_job uuid:=pg_temp.q_job('SWF-9305','in_progress'); e_on uuid; a uuid; fp_old text; fp_new text; r jsonb; t record;
BEGIN
 e_on:=pg_temp.q_email(live_job,'q5-on',now()-interval '80 days');
 a:=pg_temp.q_att(e_on,'q5-on','quote.pdf',repeat('5',64),5412737);
 fp_old:=pg_temp.q_fp(a);
 r:=pg_temp.q_rec(jsonb_build_object('source_kind','email_attachment','source_id',a,'job_id',live_job,'fingerprint',fp_old,'file_kind','pdf',
  'result','too_large','code','pdf_too_large','sha256',repeat('5',64)));
 IF r->>'outcome'<>'too_large' THEN RAISE EXCEPTION 'requests fixture: %',r; END IF;
 IF EXISTS(SELECT 1 FROM public.context_document_text_due(100) s WHERE s.source_id=a) THEN RAISE EXCEPTION 'requests fixture: a terminal read is due'; END IF;
 PERFORM pg_temp.q_request('email_attachment',a,20000000);
 fp_new:=pg_temp.q_fp(a);
 IF fp_new IS NOT DISTINCT FROM fp_old THEN RAISE EXCEPTION 'requests: a raised limit must change the fingerprint'; END IF;
 IF fp_new<>md5(concat_ws('|','context-email-attachments','q/q5-on/quote.pdf',repeat('5',64),'quote.pdf')||'|max:20000000')
 THEN RAISE EXCEPTION 'requests: the raised fingerprint is not the old one plus |max:<bytes>'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_document_text_requested_due(100) s WHERE s.source_id=a AND s.job_id=live_job AND s.max_pdf_bytes=20000000)
 THEN RAISE EXCEPTION 'requests: the raised document is not in the requested list with its limit'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_document_text_due(100) s WHERE s.source_id=a) THEN RAISE EXCEPTION 'requests: the ordinary list must not read a raised document at 5 MB'; END IF;
 -- The edge function's crash guard (an error before the large read), then the read: reopens, then saves.
 r:=pg_temp.q_rec(jsonb_build_object('source_kind','email_attachment','source_id',a,'job_id',live_job,'fingerprint',fp_new,'file_kind','pdf',
  'result','error','code','large_read_started','sha256',repeat('5',64)));
 IF r->>'outcome'<>'pending' OR NOT (r->>'reopened')::boolean THEN RAISE EXCEPTION 'requests: the raised read did not reopen: %',r; END IF;
 r:=pg_temp.q_rec(jsonb_build_object('source_kind','email_attachment','source_id',a,'job_id',live_job,'fingerprint',fp_new,'file_kind','pdf',
  'result','no_text_layer','code','no_text_layer','sha256',repeat('5',64),'page_count',3));
 SELECT * INTO t FROM public.context_document_texts WHERE source_id=a;
 IF t.outcome<>'no_text_layer' OR t.attempts<>2 OR t.source_fingerprint<>fp_new OR t.page_count<>3 THEN RAISE EXCEPTION 'requests: raised read record %',row_to_json(t); END IF;
 IF EXISTS(SELECT 1 FROM public.context_document_text_requested_due(100) s WHERE s.source_id=a)
 THEN RAISE EXCEPTION 'requests: a terminal raised read is due again'; END IF;
 DELETE FROM public.context_document_text_requests WHERE source_id=a;
 IF pg_temp.q_fp(a) IS DISTINCT FROM fp_old THEN RAISE EXCEPTION 'requests: removing the request must restore the old fingerprint'; END IF;
END $$;
ROLLBACK;

-- 6. Status: a read on no job is matched to its source (not counted as never tried).
BEGIN;
DO $$
DECLARE a uuid; s1 jsonb; s2 jsonb; fp text;
BEGIN
 a:=pg_temp.q_att(pg_temp.q_email(NULL,'q6-off',now()-interval '6 days'),'q6-off','INV-6.pdf',repeat('a6',32));
 PERFORM pg_temp.q_request('email_attachment',a);
 s1:=public.context_document_text_status();
 fp:=pg_temp.q_fp(a);
 PERFORM pg_temp.q_rec(jsonb_build_object('source_kind','email_attachment','source_id',a,'fingerprint',fp,'file_kind','pdf','result','no_text_layer','code','no_text_layer','sha256',repeat('a6',32)));
 s2:=public.context_document_text_status();
 IF (s2->'documents'->>'never_tried')::integer<>(s1->'documents'->>'never_tried')::integer-1
  OR (s2->'documents'->>'no_text_layer')::integer<>(s1->'documents'->>'no_text_layer')::integer+1
  OR (s2->>'due_now')::integer<>(s1->>'due_now')::integer-1
 THEN RAISE EXCEPTION 'requests: status before % after %',s1->'documents',s2->'documents'; END IF;
END $$;
ROLLBACK;

-- 7. Vision: a requested scan on no job is handed out only by the requested vision list, claimed,
--    leased and saved on no job; a second claim waits; the status matches it.
BEGIN;
DO $$
DECLARE a uuid; a2 uuid; sha text:=repeat('b7',32); fp text; r jsonb; resv uuid; l record; v record; ev uuid; s1 jsonb; s2 jsonb;
BEGIN
 INSERT INTO public.feature_flags(flag_name,enabled,description) VALUES('context_document_vision_v1',true,'requests fixture')
  ON CONFLICT (flag_name) DO UPDATE SET enabled=true, updated_at=now();
 a:=pg_temp.q_att(pg_temp.q_email(NULL,'q7-off',now()-interval '6 days'),'q7-off','metroll-1056504.pdf',sha);
 a2:=pg_temp.q_att(pg_temp.q_email(NULL,'q7-off2',now()-interval '6 days'),'q7-off2','scan.pdf',repeat('c7',32));
 PERFORM pg_temp.q_request('email_attachment',a);
 fp:=pg_temp.q_fp(a);
 PERFORM pg_temp.q_rec(jsonb_build_object('source_kind','email_attachment','source_id',a,'fingerprint',fp,'file_kind','pdf','result','no_text_layer','code','no_text_layer','sha256',sha,'page_count',3));
 IF EXISTS(SELECT 1 FROM public.context_document_vision_due(50) x WHERE x.source_id=a) THEN RAISE EXCEPTION 'requests: the ordinary vision list showed a requested scan'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_document_vision_requested_due(50) x WHERE x.source_id=a AND x.job_id IS NULL AND x.capture_mode='backfill')
 THEN RAISE EXCEPTION 'requests: the requested scan is not in the requested vision list on no job'; END IF;
 s1:=public.context_document_vision_status();
 -- An unrequested unplaced scan is never claimable on no job.
 r:=public.claim_context_document_vision(jsonb_build_object('source_kind','email_attachment','source_id',a2,'fingerprint',md5('x'),'file_kind','pdf','sha256',repeat('c7',32),'image_count',1));
 IF r->>'outcome'<>'not_due' THEN RAISE EXCEPTION 'requests: an unrequested scan was claimed on no job: %',r; END IF;
 IF (public.context_document_vision_admission()->>'open')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'requests fixture: vision admission closed: %',public.context_document_vision_admission(); END IF;
 r:=public.claim_context_document_vision(jsonb_build_object('source_kind','email_attachment','source_id',a,'job_id',NULL,'fingerprint',fp,'file_kind','pdf','sha256',sha,
  'page_count',3,'image_count',3,'images_cut',false));
 IF r->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'requests: vision claim on no job %',r; END IF;
 resv:=(r->>'reservation_id')::uuid;
 IF public.claim_context_document_vision(jsonb_build_object('source_kind','email_attachment','source_id',a,'fingerprint',fp,'file_kind','pdf','sha256',sha,'image_count',3))->>'outcome'<>'not_due'
 THEN RAISE EXCEPTION 'requests: a leased scan on no job was claimed twice'; END IF;
 SELECT * INTO l FROM public.context_document_vision_leased(resv);
 IF l.source_id IS DISTINCT FROM a OR l.job_id IS NOT NULL OR l.capture_mode<>'backfill' OR l.file_name<>'metroll-1056504.pdf' THEN RAISE EXCEPTION 'requests: lease %',row_to_json(l); END IF;
 r:=pg_temp.q_nojob_row(a,sha,'[Document text: scanned pages read by a vision model.] PICKUP 1056504.','context-document-vision');
 ev:=(r->>'id')::uuid;
 IF pg_temp.q_vrefused(jsonb_build_object('source_kind','email_attachment','source_id',a,'fingerprint',fp,'file_kind','pdf','result','saved','reservation_id',resv,
   'sha256',sha,'event_id',gen_random_uuid()))<>'document_vision_event_not_found' THEN RAISE EXCEPTION 'requests: a vision save must name its own row'; END IF;
 r:=public.record_context_document_vision(jsonb_build_object('source_kind','email_attachment','source_id',a,'job_id',NULL,'fingerprint',fp,'file_kind','pdf',
  'result','saved','reservation_id',resv,'sha256',sha,'event_id',ev,'model','gpt-6-luna','confidence',0.9,'char_count',60,'people_visible',false));
 IF r->>'outcome'<>'saved' THEN RAISE EXCEPTION 'requests: vision record %',r; END IF;
 SELECT * INTO v FROM public.context_document_vision_reads WHERE source_id=a;
 IF v.job_id IS NOT NULL OR v.outcome<>'saved' OR v.event_id IS DISTINCT FROM ev THEN RAISE EXCEPTION 'requests: vision read %',row_to_json(v); END IF;
 IF EXISTS(SELECT 1 FROM public.context_document_vision_requested_due(50) x WHERE x.source_id=a) THEN RAISE EXCEPTION 'requests: a saved scan is still due'; END IF;
 s2:=public.context_document_vision_status();
 IF (s2->'documents'->>'with_text')::integer<>(s1->'documents'->>'with_text')::integer+1
  OR (s2->'documents'->>'never_tried')::integer<>(s1->'documents'->>'never_tried')::integer-1
 THEN RAISE EXCEPTION 'requests: vision status before % after %',s1->'documents',s2->'documents'; END IF;
 IF (SELECT count(*) FROM public.context_document_vision_reads WHERE source_id=a)<>1 THEN RAISE EXCEPTION 'requests: two vision records for one scan on no job'; END IF;
END $$;
ROLLBACK;
