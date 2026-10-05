-- B-5b contract: the vision reader's database half. Every fixture write is
-- rolled back. Documents carry file names and fixture words only.

CREATE FUNCTION pg_temp.v_job(p_number text,p_status text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001',p_status,'fencing',p_number,now()-interval '30 days');
 RETURN j;
END $$;
CREATE FUNCTION pg_temp.v_doc(p_job uuid,p_name text,p_at timestamptz) RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.job_documents(job_id,type,file_name,storage_url,created_at)
 VALUES(p_job,'work_order',p_name,p_job::text||'/'||p_name,p_at) RETURNING id
$$;
CREATE FUNCTION pg_temp.v_fp(p_doc uuid) RETURNS text LANGUAGE sql AS $$
 SELECT s.fingerprint FROM public.context_document_text_sources() s WHERE s.source_id=p_doc
$$;
-- The text reader's verdict on a document (B-5's own writer).
CREATE FUNCTION pg_temp.v_text(p_job uuid,p_doc uuid,p_kind text,p_result text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.record_context_document_text(jsonb_build_object('source_kind','job_document','source_id',p_doc,'job_id',p_job,
  'fingerprint',pg_temp.v_fp(p_doc),'file_kind',p_kind,'result',p_result,'code',CASE WHEN p_result='no_text_layer' THEN 'no_text_layer' END))
$$;
CREATE FUNCTION pg_temp.v_claim(p_job uuid,p_doc uuid,p_kind text,p_sha text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.claim_context_document_vision(jsonb_build_object('source_kind','job_document','source_id',p_doc,'job_id',p_job,
  'fingerprint',pg_temp.v_fp(p_doc),'file_kind',p_kind,'sha256',p_sha,'page_count',CASE WHEN p_kind='pdf' THEN 2 END,
  'image_count',CASE WHEN p_kind='pdf' THEN 2 ELSE 1 END,'images_cut',false))
$$;
CREATE FUNCTION pg_temp.v_rec(p jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT public.record_context_document_vision(p) $$;
CREATE FUNCTION pg_temp.v_refused(p jsonb) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM public.record_context_document_vision(p); RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
CREATE FUNCTION pg_temp.v_evidence(p_job uuid,p_sha text) RETURNS uuid LANGUAGE sql AS $$
 SELECT (public.capture_business_event(jsonb_build_object(
  'event_type','document.text_extracted','source','context-document-vision','entity_type','job_document','entity_id',p_job::text,
  'job_id',p_job,'match_method','direct_job_id','event_at',now()-interval '1 day',
  'provider_message_id','doctext:'||p_job::text||':'||p_sha,'channel','document','direction','internal',
  'body_preview','WORK ORDER WO-1001','safe_summary','[Document text]','privacy_classification','staff_only','retention_class','7y_audit',
  'payload',jsonb_build_object('document_text',true,'text','WORK ORDER WO-1001. Replace 6 panels.','job_id',p_job::text),
  'metadata',jsonb_build_object('capture_mode','backfill')))->>'id')::uuid
$$;
CREATE FUNCTION pg_temp.v_flag_on() RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.feature_flags(flag_name,enabled,description) VALUES('context_document_vision_v1',true,'b5b fixture')
$$;
CREATE FUNCTION pg_temp.v_today() RETURNS date LANGUAGE sql AS $$ SELECT (clock_timestamp() AT TIME ZONE 'Australia/Perth')::date $$;

-- 1. Nothing widens public access; definer functions pin their search_path.
DO $$
DECLARE f regprocedure;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_document_vision_policy()','public.context_document_vision_flag()',
  'public.context_document_vision_daily_cap()','public.context_document_vision_due(integer)','public.context_document_vision_backoff(integer)',
  'public.claim_context_document_vision(jsonb)','public.record_context_document_vision(jsonb)','public.context_document_vision_leased(uuid)',
  'public.context_document_vision_admission()','public.context_document_vision_status()',
  'public.reserve_context_model_call(text,uuid,uuid)']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('public',f,'EXECUTE')
  THEN RAISE EXCEPTION 'b5b public execute on %',f; END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid=f) IS NULL THEN RAISE EXCEPTION 'b5b % has no fixed search_path',f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_document_vision_flag()','public.context_document_vision_daily_cap()',
  'public.context_document_vision_due(integer)','public.claim_context_document_vision(jsonb)','public.record_context_document_vision(jsonb)',
  'public.context_document_vision_leased(uuid)','public.context_document_vision_admission()','public.context_document_vision_status()']::regprocedure[] LOOP
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=f) THEN RAISE EXCEPTION 'b5b % must be SECURITY DEFINER',f; END IF;
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'b5b service_role must reach %',f; END IF;
 END LOOP;
 IF has_function_privilege('service_role','public.context_document_vision_backoff(integer)','EXECUTE')
 THEN RAISE EXCEPTION 'b5b the backoff helper is internal'; END IF;
 IF NOT has_function_privilege('service_role','public.reserve_context_model_call(text,uuid,uuid)','EXECUTE')
 THEN RAISE EXCEPTION 'b5b the worker must still reach the reservation'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.context_document_vision_reads'::regclass)
  OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.context_document_vision_settings'::regclass)
 THEN RAISE EXCEPTION 'b5b RLS off'; END IF;
 IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid IN ('public.context_document_vision_reads'::regclass,'public.context_document_vision_settings'::regclass))
 THEN RAISE EXCEPTION 'b5b a policy exists'; END IF;
 IF has_table_privilege('anon','public.context_document_vision_reads','SELECT') OR has_table_privilege('authenticated','public.context_document_vision_reads','SELECT')
  OR has_table_privilege('anon','public.context_document_vision_settings','SELECT') OR has_table_privilege('authenticated','public.context_document_vision_settings','UPDATE')
 THEN RAISE EXCEPTION 'b5b public table access'; END IF;
 IF NOT has_table_privilege('service_role','public.context_document_vision_reads','SELECT')
  OR has_table_privilege('service_role','public.context_document_vision_reads','INSERT')
  OR has_table_privilege('service_role','public.context_document_vision_reads','UPDATE')
  OR has_table_privilege('service_role','public.context_document_vision_settings','INSERT')
  OR has_table_privilege('service_role','public.context_document_vision_settings','UPDATE')
 THEN RAISE EXCEPTION 'b5b service_role table grants'; END IF;
 -- No schedule: the worker asks. No flag row is created.
 IF EXISTS(SELECT 1 FROM public.automation_switch_cron_lanes() WHERE cron_jobname LIKE '%vision%')
 THEN RAISE EXCEPTION 'b5b a vision cron lane appeared'; END IF;
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='context_document_vision_v1') THEN RAISE EXCEPTION 'b5b a flag row was created'; END IF;
 IF (public.context_document_vision_policy()->>'event_type')<>'document.text_extracted'
  OR (public.context_document_vision_policy()->>'key_prefix')<>(public.context_document_text_policy()->>'key_prefix')
 THEN RAISE EXCEPTION 'b5b the evidence must be the text reader''s kind and dedupe space'; END IF;
END $$;

-- 2. The flag fails closed; a claim with the flag off writes nothing.
BEGIN;
DO $$
DECLARE j uuid:=pg_temp.v_job('SWF-9101','scheduled'); d uuid; r jsonb;
BEGIN
 IF (public.context_document_vision_flag()->>'enabled')::boolean THEN RAISE EXCEPTION 'b5b missing flag must read off'; END IF;
 IF public.context_document_vision_flag()->>'state'<>'missing' THEN RAISE EXCEPTION 'b5b flag state'; END IF;
 d:=pg_temp.v_doc(j,'scan.pdf',now()-interval '3 days');
 PERFORM pg_temp.v_text(j,d,'pdf','no_text_layer');
 r:=pg_temp.v_claim(j,d,'pdf',repeat('a1',32));
 IF r->>'outcome'<>'flag_off' THEN RAISE EXCEPTION 'b5b claim with the flag off: %',r; END IF;
 IF EXISTS(SELECT 1 FROM public.context_document_vision_reads) OR EXISTS(SELECT 1 FROM public.context_model_call_reservations WHERE phase='vision')
 THEN RAISE EXCEPTION 'b5b a flag-off claim wrote something'; END IF;
 IF (public.context_document_vision_admission()->>'code')<>'flag_off' THEN RAISE EXCEPTION 'b5b admission must say flag_off'; END IF;
 INSERT INTO public.feature_flags(flag_name,enabled,description) VALUES('context_document_vision_v1',false,'b5b fixture');
 IF (public.context_document_vision_flag()->>'enabled')::boolean THEN RAISE EXCEPTION 'b5b off flag must read off'; END IF;
END $$;
ROLLBACK;

-- 3. The shared budget: vision only on both lanes, under the ceiling, within
-- its daily cap; the job reads keep their share; other phases unchanged.
BEGIN;
DO $$
DECLARE d date:=pg_temp.v_today(); r jsonb; n integer;
BEGIN
 DELETE FROM public.context_model_call_reservations WHERE run_date=d;
 -- Vision never takes a run.
 BEGIN
  r:=public.reserve_context_model_call('vision',gen_random_uuid(),gen_random_uuid());
  RAISE EXCEPTION 'b5b vision with a run was admitted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Invalid model call identity' THEN RAISE; END IF;
 END;
 r:=public.reserve_context_model_call('vision',NULL,NULL);
 IF r->>'outcome'<>'reserved' THEN RAISE EXCEPTION 'b5b first vision call must be reserved, got %',r; END IF;
 IF (SELECT phase FROM public.context_model_call_reservations WHERE id=(r->>'reservation_id')::uuid)<>'vision'
 THEN RAISE EXCEPTION 'b5b the reservation is not marked vision'; END IF;
 -- Lanes: capture off pauses vision but not attribution; extraction off pauses vision.
 UPDATE public.automation_switches SET capture=false WHERE id=1;
 IF public.reserve_context_model_call('vision',NULL,NULL)->>'outcome'<>'paused' THEN RAISE EXCEPTION 'b5b vision with capture off'; END IF;
 IF public.reserve_context_model_call('attribution',NULL,NULL)->>'outcome'<>'reserved' THEN RAISE EXCEPTION 'b5b attribution must not need capture'; END IF;
 UPDATE public.automation_switches SET capture=true, extraction=false WHERE id=1;
 IF public.reserve_context_model_call('vision',NULL,NULL)->>'outcome'<>'paused' THEN RAISE EXCEPTION 'b5b vision with extraction off'; END IF;
 UPDATE public.automation_switches SET extraction=true WHERE id=1;
 -- The ceiling: once 200 of the day's calls are used, vision stops and the
 -- job reads keep the other 200.
 DELETE FROM public.context_model_call_reservations WHERE run_date=d;
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,reserved_at)
  SELECT d,g,'bucket',clock_timestamp() FROM generate_series(1,199) g;
 IF public.reserve_context_model_call('vision',NULL,NULL)->>'outcome'<>'reserved' THEN RAISE EXCEPTION 'b5b call 200 must be admitted to vision'; END IF;
 r:=public.reserve_context_model_call('vision',NULL,NULL);
 IF r->>'outcome'<>'vision_reserve' THEN RAISE EXCEPTION 'b5b the job reads must keep their share, got %',r; END IF;
 IF public.reserve_context_model_call('bucket',NULL,NULL)->>'outcome'<>'reserved' THEN RAISE EXCEPTION 'b5b other phases must go on past the vision ceiling'; END IF;
 -- The daily cap: the policy default, then the desk's setting.
 DELETE FROM public.context_model_call_reservations WHERE run_date=d;
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,reserved_at)
  SELECT d,g,'vision',clock_timestamp() FROM generate_series(1,100) g;
 r:=public.reserve_context_model_call('vision',NULL,NULL);
 IF r->>'outcome'<>'vision_budget' OR (r->>'limit')::int<>100 THEN RAISE EXCEPTION 'b5b default daily cap, got %',r; END IF;
 INSERT INTO public.context_document_vision_settings(id,daily_cap,updated_by,note) VALUES(1,120,'b5b fixture','raise');
 IF public.reserve_context_model_call('vision',NULL,NULL)->>'outcome'<>'reserved' THEN RAISE EXCEPTION 'b5b the desk cap must apply'; END IF;
 UPDATE public.context_document_vision_settings SET daily_cap=0;
 IF public.context_document_vision_daily_cap()<>0 THEN RAISE EXCEPTION 'b5b cap 0'; END IF;
 IF public.reserve_context_model_call('vision',NULL,NULL)->>'outcome'<>'vision_budget' THEN RAISE EXCEPTION 'b5b cap 0 must stop vision'; END IF;
 BEGIN
  UPDATE public.context_document_vision_settings SET daily_cap=301;
  RAISE EXCEPTION 'b5b a cap over the maximum was stored';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 -- Attribution's own budget is unchanged and vision does not spend it.
 DELETE FROM public.context_model_call_reservations WHERE run_date=d;
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,reserved_at)
  SELECT d,g,CASE WHEN g<=59 THEN 'attribution' ELSE 'vision' END,clock_timestamp() FROM generate_series(1,90) g;
 IF public.reserve_context_model_call('attribution',NULL,NULL)->>'outcome'<>'reserved' THEN RAISE EXCEPTION 'b5b the 60th attribution call'; END IF;
 IF public.reserve_context_model_call('attribution',NULL,NULL)->>'outcome'<>'attribution_budget' THEN RAISE EXCEPTION 'b5b attribution budget lost'; END IF;
 -- The 400 cap holds for vision too.
 DELETE FROM public.context_document_vision_settings;
 DELETE FROM public.context_model_call_reservations WHERE run_date=d;
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,reserved_at)
  SELECT d,g,'bucket',clock_timestamp() FROM generate_series(1,400) g;
 IF public.reserve_context_model_call('vision',NULL,NULL)->>'outcome'<>'cap' THEN RAISE EXCEPTION 'b5b vision past the 400 cap'; END IF;
 SELECT count(*) INTO n FROM public.context_model_call_reservations WHERE run_date=d;
 IF n<>400 THEN RAISE EXCEPTION 'b5b a refused call reserved a slot'; END IF;
END $$;
ROLLBACK;

-- 4. Due: only documents the text reader found no text layer in, on live
-- jobs, for their current bytes; newest first with capture modes.
BEGIN;
DO $$
DECLARE live_job uuid:=pg_temp.v_job('SWF-9102','scheduled'); dead_job uuid:=pg_temp.v_job('SWF-9103','cancelled');
 d_new uuid; d_old uuid; d_text uuid; d_untried uuid; d_dead uuid; ids uuid[]; modes text[];
BEGIN
 d_new:=pg_temp.v_doc(live_job,'site-photo.jpg',now()-interval '2 hours');
 d_old:=pg_temp.v_doc(live_job,'scanned-po.pdf',now()-interval '20 days');
 d_text:=pg_temp.v_doc(live_job,'quote.pdf',now()-interval '1 hour');
 d_untried:=pg_temp.v_doc(live_job,'other-scan.pdf',now()-interval '1 hour');
 d_dead:=pg_temp.v_doc(dead_job,'dead-scan.pdf',now()-interval '1 hour');
 PERFORM pg_temp.v_text(live_job,d_new,'image','no_text_layer');
 PERFORM pg_temp.v_text(live_job,d_old,'pdf','no_text_layer');
 PERFORM pg_temp.v_text(live_job,d_text,'pdf','unreadable');
 SELECT array_agg(x.source_id ORDER BY x.doc_at DESC), array_agg(x.capture_mode ORDER BY x.doc_at DESC) INTO ids, modes
 FROM public.context_document_vision_due(50) x WHERE x.job_id IN (live_job,dead_job);
 IF ids IS DISTINCT FROM ARRAY[d_new,d_old] THEN RAISE EXCEPTION 'b5b due: expected the photo then the scan, got %',ids; END IF;
 IF modes IS DISTINCT FROM ARRAY['live','backfill'] THEN RAISE EXCEPTION 'b5b due: capture modes %',modes; END IF;
 -- A document changed since the text reader's verdict is not handed over.
 UPDATE public.job_documents SET storage_url=storage_url||'?v=2' WHERE id=d_old;
 IF EXISTS(SELECT 1 FROM public.context_document_vision_due(50) x WHERE x.source_id=d_old)
 THEN RAISE EXCEPTION 'b5b due: a changed document must wait for the text reader first'; END IF;
END $$;
ROLLBACK;

-- 5. Claim and answer: one lease per reservation, the answer saves evidence,
-- a second claim waits, the same bytes cost no call, lapsed leases come back.
BEGIN;
DO $$
DECLARE j uuid:=pg_temp.v_job('SWF-9104','in_progress'); d uuid; d2 uuid; d3 uuid; sha text:=repeat('b2',32); sha3 text:=repeat('c3',32);
 r jsonb; resv uuid; ev uuid; v record; n integer; fp text;
BEGIN
 PERFORM pg_temp.v_flag_on();
 d:=pg_temp.v_doc(j,'scan.pdf',now()-interval '3 days');
 d2:=pg_temp.v_doc(j,'scan-copy.pdf',now()-interval '3 days');
 d3:=pg_temp.v_doc(j,'photo.jpg',now()-interval '3 days');
 PERFORM pg_temp.v_text(j,d,'pdf','no_text_layer');
 PERFORM pg_temp.v_text(j,d2,'pdf','no_text_layer');
 PERFORM pg_temp.v_text(j,d3,'image','no_text_layer');
 IF (public.context_document_vision_admission()->>'open')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'b5b admission closed: %',public.context_document_vision_admission(); END IF;
 r:=pg_temp.v_claim(j,d,'pdf',sha);
 IF r->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'b5b claim: %',r; END IF;
 resv:=(r->>'reservation_id')::uuid;
 SELECT * INTO v FROM public.context_document_vision_reads WHERE source_id=d;
 IF v.outcome<>'leased' OR v.attempts<>1 OR v.reservation_id IS DISTINCT FROM resv OR v.lease_until<=now() THEN RAISE EXCEPTION 'b5b lease record %',row_to_json(v); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_model_call_reservations WHERE id=resv AND phase='vision') THEN RAISE EXCEPTION 'b5b the claim reserved no vision call'; END IF;
 -- Leased: not due, a second claim waits, and an answer without the reservation is refused.
 IF EXISTS(SELECT 1 FROM public.context_document_vision_due(50) x WHERE x.source_id=d) THEN RAISE EXCEPTION 'b5b a leased document is due'; END IF;
 IF pg_temp.v_claim(j,d,'pdf',sha)->>'outcome'<>'not_due' THEN RAISE EXCEPTION 'b5b double claim'; END IF;
 fp:=pg_temp.v_fp(d);
 IF pg_temp.v_refused(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',j,'fingerprint',fp,'file_kind','pdf','result','no_text'))
  <>'document_vision_leased' THEN RAISE EXCEPTION 'b5b a write over a live lease'; END IF;
 IF pg_temp.v_refused(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',j,'fingerprint',fp,'file_kind','pdf','result','no_text',
   'reservation_id',gen_random_uuid(),'sha256',sha))<>'document_vision_lease_lost' THEN RAISE EXCEPTION 'b5b another reservation answered'; END IF;
 IF pg_temp.v_refused(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',j,'fingerprint',fp,'file_kind','pdf','result','no_text',
   'reservation_id',resv,'sha256',repeat('ff',32)))<>'document_vision_sha256_mismatch' THEN RAISE EXCEPTION 'b5b other bytes answered'; END IF;
 -- The leased read carries what the evidence row needs.
 IF (SELECT x.capture_mode FROM public.context_document_vision_leased(resv) x)<>'backfill'
  OR (SELECT x.file_name FROM public.context_document_vision_leased(resv) x)<>'scan.pdf'
  OR (SELECT x.image_count FROM public.context_document_vision_leased(resv) x)<>2
 THEN RAISE EXCEPTION 'b5b leased read'; END IF;
 -- The answer: saved names its evidence row.
 IF pg_temp.v_refused(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',j,'fingerprint',fp,'file_kind','pdf','result','saved',
   'reservation_id',resv,'sha256',sha,'event_id',gen_random_uuid()))<>'document_vision_event_not_found' THEN RAISE EXCEPTION 'b5b saved without its row'; END IF;
 ev:=pg_temp.v_evidence(j,sha);
 r:=pg_temp.v_rec(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',j,'fingerprint',fp,'file_kind','pdf','result','saved',
   'reservation_id',resv,'sha256',sha,'event_id',ev,'model','gpt-6-luna','confidence',0.91,'char_count',37,'people_visible',false));
 IF r->>'outcome'<>'saved' THEN RAISE EXCEPTION 'b5b saved: %',r; END IF;
 SELECT * INTO v FROM public.context_document_vision_reads WHERE source_id=d;
 IF v.event_id<>ev OR v.model<>'gpt-6-luna' OR v.confidence<>0.91 OR v.finished_at IS NULL OR v.attempts<>1 THEN RAISE EXCEPTION 'b5b saved record %',row_to_json(v); END IF;
 IF EXISTS(SELECT 1 FROM public.context_document_vision_leased(resv)) THEN RAISE EXCEPTION 'b5b a finished lease still reads'; END IF;
 IF pg_temp.v_claim(j,d,'pdf',sha)->>'outcome'<>'not_due' THEN RAISE EXCEPTION 'b5b a finished document was claimed again'; END IF;
 -- The same bytes on this job (a second copy of the scan) cost no call.
 SELECT count(*) INTO n FROM public.context_model_call_reservations WHERE phase='vision';
 r:=pg_temp.v_claim(j,d2,'pdf',sha);
 IF r->>'outcome'<>'same_bytes_saved' OR (r->>'event_id')::uuid<>ev THEN RAISE EXCEPTION 'b5b same bytes: %',r; END IF;
 IF (SELECT count(*) FROM public.context_model_call_reservations WHERE phase='vision')<>n THEN RAISE EXCEPTION 'b5b same bytes spent a call'; END IF;
 IF (SELECT outcome FROM public.context_document_vision_reads WHERE source_id=d2)<>'saved' THEN RAISE EXCEPTION 'b5b same bytes record'; END IF;
 -- A lapsed lease comes back due; after the last attempt it closes failed.
 r:=pg_temp.v_claim(j,d3,'image',sha3);
 IF r->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'b5b photo claim: %',r; END IF;
 UPDATE public.context_document_vision_reads SET lease_until=now()-interval '1 minute' WHERE source_id=d3;
 IF NOT EXISTS(SELECT 1 FROM public.context_document_vision_due(50) x WHERE x.source_id=d3) THEN RAISE EXCEPTION 'b5b a lapsed lease is not due'; END IF;
 IF pg_temp.v_claim(j,d3,'image',sha3)->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'b5b reclaim after a lapse'; END IF;
 -- The first reservation lost its lease to the reclaim: its answer is refused.
 IF pg_temp.v_refused(jsonb_build_object('source_kind','job_document','source_id',d3,'job_id',j,'fingerprint',pg_temp.v_fp(d3),'file_kind','image',
   'result','no_text','reservation_id',(r->>'reservation_id')::uuid,'sha256',sha3))<>'document_vision_lease_lost'
 THEN RAISE EXCEPTION 'b5b the lapsed reservation answered after a reclaim'; END IF;
 IF (SELECT attempts FROM public.context_document_vision_reads WHERE source_id=d3)<>2 THEN RAISE EXCEPTION 'b5b a reclaim must count an attempt'; END IF;
END $$;
ROLLBACK;

-- 6. Errors back off and then fail; a model route error is not the
-- document's; a document out of attempts closes; a change reopens.
BEGIN;
DO $$
DECLARE j uuid:=pg_temp.v_job('SWF-9105','scheduled'); d uuid; d2 uuid; sha text:=repeat('d4',32); r jsonb; resv uuid; v record; fp text; i integer;
BEGIN
 PERFORM pg_temp.v_flag_on();
 d:=pg_temp.v_doc(j,'handwritten.jpg',now()-interval '5 days');
 d2:=pg_temp.v_doc(j,'blurry.jpg',now()-interval '5 days');
 PERFORM pg_temp.v_text(j,d,'image','no_text_layer');
 PERFORM pg_temp.v_text(j,d2,'image','no_text_layer');
 fp:=pg_temp.v_fp(d);
 -- A route error (login, rate limit) leaves the attempt count where it was.
 r:=pg_temp.v_claim(j,d,'image',sha); resv:=(r->>'reservation_id')::uuid;
 r:=pg_temp.v_rec(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',j,'fingerprint',fp,'file_kind','image',
   'result','error','code','model_route_rate_limited','reservation_id',resv,'sha256',sha));
 SELECT * INTO v FROM public.context_document_vision_reads WHERE source_id=d;
 IF v.outcome<>'pending' OR v.attempts<>0 OR v.next_at<now()+interval '59 minutes' OR v.reservation_id IS NOT NULL THEN RAISE EXCEPTION 'b5b route error %',row_to_json(v); END IF;
 -- Document errors: 1 h, 6 h, 24 h, then failed.
 FOR i IN 1..4 LOOP
  UPDATE public.context_document_vision_reads SET next_at=now()-interval '1 second' WHERE source_id=d;
  r:=pg_temp.v_claim(j,d,'image',sha);
  IF r->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'b5b claim % %',i,r; END IF;
  r:=pg_temp.v_rec(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',j,'fingerprint',fp,'file_kind','image',
    'result','error','code','model_answer_invalid','reservation_id',(r->>'reservation_id')::uuid,'sha256',sha));
  SELECT * INTO v FROM public.context_document_vision_reads WHERE source_id=d;
  IF i<4 AND (v.outcome<>'pending' OR v.attempts<>i
   OR v.next_at<now()+make_interval(mins=>(ARRAY[60,360,1440])[i])-interval '1 minute') THEN RAISE EXCEPTION 'b5b backoff % %',i,row_to_json(v); END IF;
 END LOOP;
 IF v.outcome<>'failed' OR v.failure_code<>'model_answer_invalid' OR r->>'outcome'<>'failed:model_answer_invalid' THEN RAISE EXCEPTION 'b5b terminal failure %',row_to_json(v); END IF;
 IF EXISTS(SELECT 1 FROM public.context_document_vision_due(50) x WHERE x.source_id=d) THEN RAISE EXCEPTION 'b5b a failed document is due'; END IF;
 -- A lease that lapses on the last attempt closes failed at the next claim, with no call.
 r:=pg_temp.v_claim(j,d2,'image',repeat('e5',32));
 UPDATE public.context_document_vision_reads SET attempts=4, lease_until=now()-interval '1 minute' WHERE source_id=d2;
 i:=(SELECT count(*) FROM public.context_model_call_reservations WHERE phase='vision');
 r:=pg_temp.v_claim(j,d2,'image',repeat('e5',32));
 IF r->>'outcome'<>'not_due' OR (SELECT failure_code FROM public.context_document_vision_reads WHERE source_id=d2)<>'lease_expired'
  OR (SELECT count(*) FROM public.context_model_call_reservations WHERE phase='vision')<>i THEN RAISE EXCEPTION 'b5b exhausted lease: %',r; END IF;
 -- The document changes: the text reader judges it again, then vision reopens.
 UPDATE public.job_documents SET storage_url=storage_url||'?v=2' WHERE id=d;
 PERFORM pg_temp.v_text(j,d,'image','no_text_layer');
 IF NOT EXISTS(SELECT 1 FROM public.context_document_vision_due(50) x WHERE x.source_id=d AND x.attempts=0) THEN RAISE EXCEPTION 'b5b a changed document must reopen'; END IF;
 r:=pg_temp.v_claim(j,d,'image',repeat('f6',32));
 IF r->>'outcome'<>'claimed' OR (SELECT attempts FROM public.context_document_vision_reads WHERE source_id=d)<>1 THEN RAISE EXCEPTION 'b5b reopen claim: %',r; END IF;
 -- No writing, and low confidence, are terminal and save nothing.
 r:=pg_temp.v_rec(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',j,'fingerprint',pg_temp.v_fp(d),'file_kind','image',
   'result','low_confidence','code','below_min_confidence','reservation_id',(r->>'reservation_id')::uuid,'sha256',repeat('f6',32),
   'model','gpt-6-luna','confidence',0.2,'people_visible',true));
 SELECT * INTO v FROM public.context_document_vision_reads WHERE source_id=d;
 IF v.outcome<>'low_confidence' OR v.event_id IS NOT NULL OR NOT v.people_visible OR v.finished_at IS NULL THEN RAISE EXCEPTION 'b5b low confidence %',row_to_json(v); END IF;
 -- Refusals.
 IF pg_temp.v_refused('{"source_kind":"job_document"}') NOT LIKE 'document_vision_%' THEN RAISE EXCEPTION 'b5b refuse incomplete'; END IF;
 IF pg_temp.v_refused(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',j,'fingerprint',fp,'file_kind','image','result','error'))
  <>'document_vision_code_required' THEN RAISE EXCEPTION 'b5b an error needs a code'; END IF;
 IF pg_temp.v_refused(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',j,'fingerprint',fp,'file_kind','image','result','no_text','confidence',1.5))
  <>'document_vision_confidence_invalid' THEN RAISE EXCEPTION 'b5b confidence range'; END IF;
 IF pg_temp.v_refused(jsonb_build_object('source_kind','job_document','source_id',gen_random_uuid(),'job_id',j,'fingerprint',fp,'file_kind','image','result','no_text'))
  <>'document_vision_source_not_found' THEN RAISE EXCEPTION 'b5b a document the text reader never saw'; END IF;
 IF pg_temp.v_refused(jsonb_build_object('source_kind','job_document','source_id',d,'job_id',j,'fingerprint',fp,'file_kind','other','result','no_text'))
  <>'document_vision_file_kind_invalid' THEN RAISE EXCEPTION 'b5b other file kinds'; END IF;
END $$;
ROLLBACK;

-- 7. Status and admission: counts and codes only, alarms only while on.
BEGIN;
DO $$
DECLARE j uuid:=pg_temp.v_job('SWF-9106','scheduled'); d uuid; d2 uuid; s jsonb;
BEGIN
 d:=pg_temp.v_doc(j,'scan-a.pdf',now()-interval '4 days');
 d2:=pg_temp.v_doc(j,'photo-b.png',now()-interval '4 days');
 PERFORM pg_temp.v_text(j,d,'pdf','no_text_layer');
 PERFORM pg_temp.v_text(j,d2,'image','no_text_layer');
 s:=public.context_document_vision_status();
 IF (s->'documents'->>'waiting_for_vision')::int<2 OR (s->'documents'->>'never_tried')::int<2 OR (s->>'due_now')::int<2
 THEN RAISE EXCEPTION 'b5b status counts %',s->'documents'; END IF;
 IF jsonb_array_length(s->'alarms')<>0 THEN RAISE EXCEPTION 'b5b alarms while the flag is off'; END IF;
 IF s::text LIKE '%scan-a%' THEN RAISE EXCEPTION 'b5b status carries a file name'; END IF;
 PERFORM pg_temp.v_flag_on();
 UPDATE public.feature_flags SET updated_at=now()-interval '7 hours' WHERE flag_name='context_document_vision_v1';
 s:=public.context_document_vision_status();
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'alarms') a WHERE a->>'key'='document_vision_stale')
 THEN RAISE EXCEPTION 'b5b stale alarm missing: %',s->'alarms'; END IF;
 IF NOT (s->'admission'->>'open')::boolean THEN RAISE EXCEPTION 'b5b admission %',s->'admission'; END IF;
 UPDATE public.automation_switches SET extraction=false WHERE id=1;
 IF public.context_document_vision_admission()->>'code'<>'paused' THEN RAISE EXCEPTION 'b5b admission with a lane off'; END IF;
 IF jsonb_array_length(public.context_document_vision_status()->'alarms')<>0 THEN RAISE EXCEPTION 'b5b alarms while a lane is off'; END IF;
END $$;
ROLLBACK;
