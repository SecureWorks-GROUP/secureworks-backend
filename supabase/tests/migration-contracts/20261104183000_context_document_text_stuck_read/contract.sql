-- Stuck read contract: the read mark (one attempt, a read that finishes keeps what it had, a file that
-- stops the worker ends failed after the usual tries), the closer of runs left running, and the stale
-- alarm measured from the last run the reader finished. Every fixture write is rolled back. No words.

CREATE FUNCTION pg_temp.s_job(p_number text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001','in_progress','fencing',p_number,now()-interval '30 days');
 RETURN j;
END $$;
CREATE FUNCTION pg_temp.s_doc(p_job uuid,p_name text) RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.job_documents(job_id,type,file_name,storage_url,created_at)
 VALUES(p_job,'quote',p_name,p_job::text||'/'||p_name,now()-interval '9 days') RETURNING id
$$;
CREATE FUNCTION pg_temp.s_fp(p_id uuid) RETURNS text LANGUAGE sql AS $$
 SELECT s.fingerprint FROM public.context_document_text_sources() s WHERE s.source_id=p_id
$$;
-- The evidence row a saved read names: doctext:<job>:<sha256>.
CREATE FUNCTION pg_temp.s_ev(p_job uuid,p_doc uuid,p_sha text) RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,job_id,match_method,event_at,provider_message_id,channel,direction,payload,metadata)
 VALUES('document.text_extracted','context-document-text','job_document',p_doc::text,p_job,'direct_job_id',now()-interval '9 days',
  'doctext:'||p_job::text||':'||p_sha,'document','internal',jsonb_build_object('document_text',true),'{"capture_mode":"backfill"}') RETURNING id
$$;
-- One write of the reader: result and code, as the edge function sends them.
CREATE FUNCTION pg_temp.s_w(p_job uuid,p_doc uuid,p_result text,p_code text DEFAULT NULL,p_sha text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p jsonb;
BEGIN
 p:=jsonb_build_object('source_kind','job_document','source_id',p_doc,'job_id',p_job,'fingerprint',pg_temp.s_fp(p_doc),'file_kind','pdf','result',p_result);
 IF p_code IS NOT NULL THEN p:=p||jsonb_build_object('code',p_code); END IF;
 IF p_result='saved' THEN
  p:=p||jsonb_build_object('sha256',p_sha,'event_id',pg_temp.s_ev(p_job,p_doc,p_sha),'char_count',300,'page_count',2);
 END IF;
 RETURN public.record_context_document_text(p);
END $$;
CREATE FUNCTION pg_temp.s_mark(p_job uuid,p_doc uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT pg_temp.s_w(p_job,p_doc,'error','read_started')
$$;
-- The next try is due now (the fixture's stand-in for waiting out the backoff).
CREATE FUNCTION pg_temp.s_due_now(p_doc uuid) RETURNS void LANGUAGE sql AS $$
 UPDATE public.context_document_texts SET next_at=now()-interval '1 second' WHERE source_id=p_doc AND outcome='pending'
$$;
CREATE FUNCTION pg_temp.s_is_due(p_doc uuid) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM public.context_document_text_due(100) d WHERE d.source_id=p_doc)
$$;
-- What a record says, without its ids and times: outcome, attempts, codes and the wait to the next try.
CREATE FUNCTION pg_temp.s_state(p_doc uuid) RETURNS text LANGUAGE sql AS $$
 SELECT concat_ws('|',t.outcome,t.attempts,coalesce(t.last_code,'-'),coalesce(t.failure_code,'-'),
  coalesce(round(extract(epoch FROM t.next_at-t.updated_at)/60)::text,'-'),(t.finished_at IS NULL)::text,coalesce(t.page_count::text,'-'))
 FROM public.context_document_texts t WHERE t.source_id=p_doc
$$;

-- 1. Access: the closer is service-side only, with a fixed search_path; the replaced functions keep theirs.
BEGIN;
DO $$
DECLARE f regprocedure;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.close_stale_context_document_text_runs()','public.record_context_document_text(jsonb)',
  'public.context_document_text_status()']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('public',f,'EXECUTE')
  THEN RAISE EXCEPTION 'stuck: public execute on %',f; END IF;
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'stuck: service_role cannot run %',f; END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid=f) IS NULL THEN RAISE EXCEPTION 'stuck: % has no fixed search_path',f; END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=f) THEN RAISE EXCEPTION 'stuck: % is not SECURITY DEFINER',f; END IF;
 END LOOP;
 IF has_table_privilege('service_role','public.context_capture_runs','UPDATE') THEN RAISE EXCEPTION 'stuck: service_role may update run rows directly'; END IF;
END $$;
ROLLBACK;

-- 2. A read that finishes keeps exactly what it had: the same writes with a mark before each give the
--    same outcome, attempts, codes and next wait as without.
BEGIN;
DO $$
DECLARE j uuid:=pg_temp.s_job('SWF-9401'); a uuid; b uuid; i integer; seq text[]; w text; n integer:=0;
BEGIN
 FOREACH seq SLICE 1 IN ARRAY ARRAY[
  ARRAY['saved','-','-','-','-'],
  ARRAY['no_text_layer','-','-','-','-'],
  ARRAY['unreadable','-','-','-','-'],
  ARRAY['error','saved','-','-','-'],
  ARRAY['error','error','no_file','-','-'],
  ARRAY['error','error','error','error','error']] LOOP
  n:=n+1;
  a:=pg_temp.s_doc(j,format('plain-%s.pdf',n)); b:=pg_temp.s_doc(j,format('marked-%s.pdf',n));
  FOR i IN 1..5 LOOP
   w:=seq[i];
   CONTINUE WHEN w='-';
   PERFORM pg_temp.s_due_now(a); PERFORM pg_temp.s_due_now(b);
   PERFORM pg_temp.s_w(j,a,w,CASE w WHEN 'error' THEN 'capture_rpc_threw' WHEN 'no_text_layer' THEN 'no_text_layer' WHEN 'unreadable' THEN 'pdf_parse_failed' WHEN 'no_file' THEN 'object_missing' END,lpad(to_hex(n),64,'a'));
   PERFORM pg_temp.s_mark(j,b);
   IF pg_temp.s_is_due(b) THEN RAISE EXCEPTION 'stuck: a document is due while its read is under way'; END IF;
   PERFORM pg_temp.s_w(j,b,w,CASE w WHEN 'error' THEN 'capture_rpc_threw' WHEN 'no_text_layer' THEN 'no_text_layer' WHEN 'unreadable' THEN 'pdf_parse_failed' WHEN 'no_file' THEN 'object_missing' END,lpad(to_hex(n),64,'b'));
  END LOOP;
  IF pg_temp.s_state(a) IS DISTINCT FROM pg_temp.s_state(b) THEN
   RAISE EXCEPTION 'stuck: a mark and its outcome counted differently from the outcome alone (% %): without % with %',n,seq,pg_temp.s_state(a),pg_temp.s_state(b);
  END IF;
 END LOOP;
 -- The ordinary path itself is unchanged: one saved read is one attempt; five errors end failed:<code>.
 IF pg_temp.s_state(b) IS DISTINCT FROM 'failed|5|capture_rpc_threw|capture_rpc_threw|-|false|-' THEN RAISE EXCEPTION 'stuck: five errors %',pg_temp.s_state(b); END IF;
END $$;
ROLLBACK;

-- 3. A file that stops the worker: only marks arrive. Each is one attempt with the usual wait; the
--    fifth ends the record failed:read_started, out of the due list and counted failed.
BEGIN;
DO $$
DECLARE j uuid:=pg_temp.s_job('SWF-9402'); d uuid; i integer; s1 jsonb; s2 jsonb; waits integer[]:=ARRAY[15,60,360,1440];
BEGIN
 d:=pg_temp.s_doc(j,'stops-the-worker.pdf');
 s1:=public.context_document_text_status();
 IF NOT pg_temp.s_is_due(d) THEN RAISE EXCEPTION 'stuck fixture: the document is not due'; END IF;
 FOR i IN 1..4 LOOP
  PERFORM pg_temp.s_mark(j,d);
  IF pg_temp.s_state(d) IS DISTINCT FROM format('pending|%s|read_started|-|%s|true|-',i,waits[i]) THEN
   RAISE EXCEPTION 'stuck: after % stopped reads the record is %',i,pg_temp.s_state(d);
  END IF;
  IF pg_temp.s_is_due(d) THEN RAISE EXCEPTION 'stuck: a stopped read is due again before its wait'; END IF;
  PERFORM pg_temp.s_due_now(d);
  IF NOT pg_temp.s_is_due(d) THEN RAISE EXCEPTION 'stuck: a stopped read is not due after its wait'; END IF;
 END LOOP;
 PERFORM pg_temp.s_mark(j,d);
 IF pg_temp.s_state(d) IS DISTINCT FROM 'failed|5|read_started|read_started|-|false|-' THEN
  RAISE EXCEPTION 'stuck: after 5 stopped reads the record is %',pg_temp.s_state(d);
 END IF;
 IF pg_temp.s_is_due(d) THEN RAISE EXCEPTION 'stuck: a document failed by stopped reads is still due'; END IF;
 s2:=public.context_document_text_status();
 IF (s2->'documents'->>'failed')::integer<>(s1->'documents'->>'failed')::integer+1
  OR (s2->'documents'->>'never_tried')::integer<>(s1->'documents'->>'never_tried')::integer-1
  OR (s2->>'due_now')::integer<>(s1->>'due_now')::integer-1
 THEN RAISE EXCEPTION 'stuck: status before % after %',s1->'documents',s2->'documents'; END IF;
END $$;
ROLLBACK;

-- 4. The fifth read finishes after all: its outcome replaces the mark that ended the record failed.
--    A mark never reopens a finished record, and the 20261104130000 reader's large_read_started mark
--    completes the same way.
BEGIN;
DO $$
DECLARE j uuid:=pg_temp.s_job('SWF-9403'); d uuid; e uuid; i integer; r jsonb;
BEGIN
 d:=pg_temp.s_doc(j,'slow-but-fine.pdf');
 FOR i IN 1..5 LOOP PERFORM pg_temp.s_mark(j,d); PERFORM pg_temp.s_due_now(d); END LOOP;
 IF pg_temp.s_state(d) NOT LIKE 'failed|5|read_started|read_started|%' THEN RAISE EXCEPTION 'stuck fixture: %',pg_temp.s_state(d); END IF;
 r:=pg_temp.s_w(j,d,'no_text_layer','no_text_layer');
 IF pg_temp.s_state(d) IS DISTINCT FROM 'no_text_layer|5|no_text_layer|-|-|false|-' THEN RAISE EXCEPTION 'stuck: the fifth read''s outcome was not kept: % %',r,pg_temp.s_state(d); END IF;
 r:=pg_temp.s_mark(j,d);
 IF r->>'outcome'<>'unchanged' OR pg_temp.s_state(d) NOT LIKE 'no_text_layer|5|%' THEN RAISE EXCEPTION 'stuck: a mark reopened a finished record: %',r; END IF;
 -- The fifth read ends in an error after all: failed with that error's own code.
 e:=pg_temp.s_doc(j,'fails-for-real.pdf');
 FOR i IN 1..5 LOOP PERFORM pg_temp.s_mark(j,e); PERFORM pg_temp.s_due_now(e); END LOOP;
 PERFORM pg_temp.s_w(j,e,'error','download_storage_error');
 IF pg_temp.s_state(e) IS DISTINCT FROM 'failed|5|download_storage_error|download_storage_error|-|false|-' THEN RAISE EXCEPTION 'stuck: the fifth error %',pg_temp.s_state(e); END IF;
 -- The 20261104130000 large-read mark: one attempt with its outcome.
 e:=pg_temp.s_doc(j,'large.pdf');
 PERFORM pg_temp.s_w(j,e,'error','large_read_started');
 PERFORM pg_temp.s_w(j,e,'saved',NULL,repeat('e',64));
 IF pg_temp.s_state(e) IS DISTINCT FROM 'saved|1|saved|-|-|false|2' THEN RAISE EXCEPTION 'stuck: large_read_started and its read %',pg_temp.s_state(e); END IF;
END $$;
ROLLBACK;

-- 5. The closer: every run of this reader still running 10 minutes after it started, and nothing else.
BEGIN;
DO $$
DECLARE r jsonb; old uuid:=gen_random_uuid(); fresh uuid:=gen_random_uuid(); done uuid:=gen_random_uuid(); other uuid:=gen_random_uuid(); c public.context_capture_runs;
BEGIN
 INSERT INTO public.context_capture_runs(id,source,status,started_at,updated_at,finished_at,counts) VALUES
  (old,'context_document_text','running',now()-interval '11 minutes',now()-interval '11 minutes',NULL,'{}'),
  (fresh,'context_document_text','running',now()-interval '5 minutes',now()-interval '5 minutes',NULL,'{}'),
  (done,'context_document_text','succeeded',now()-interval '40 minutes',now()-interval '39 minutes',now()-interval '39 minutes','{"selected":2}'),
  (other,'ghl_message_reconcile','running',now()-interval '2 hours',now()-interval '2 hours',NULL,'{}');
 r:=public.close_stale_context_document_text_runs();
 IF (r->>'closed')::integer<1 OR r->>'source'<>'context_document_text' THEN RAISE EXCEPTION 'stuck: closer returned %',r; END IF;
 SELECT * INTO c FROM public.context_capture_runs WHERE id=old;
 IF c.status<>'failed' OR c.error_code<>'run_stale' OR c.finished_at IS NULL OR c.counts<>'{}'::jsonb THEN RAISE EXCEPTION 'stuck: the stale run is %',row_to_json(c); END IF;
 IF (SELECT status FROM public.context_capture_runs WHERE id=fresh)<>'running' THEN RAISE EXCEPTION 'stuck: a run inside its window was closed'; END IF;
 IF (SELECT row(status,finished_at,error_code)::text FROM public.context_capture_runs WHERE id=done)
    IS DISTINCT FROM (SELECT row('succeeded'::text,started_at+interval '1 minute',NULL::text)::text FROM public.context_capture_runs WHERE id=done)
 THEN RAISE EXCEPTION 'stuck: a closed run was changed'; END IF;
 IF (SELECT status FROM public.context_capture_runs WHERE id=other)<>'running' THEN RAISE EXCEPTION 'stuck: another source''s run was closed'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_capture_runs WHERE source='context_document_text' AND status='running' AND started_at<now()-interval '10 minutes')
 THEN RAISE EXCEPTION 'stuck: a stale run is still running'; END IF;
 r:=public.close_stale_context_document_text_runs();
 IF (r->>'closed')::integer<>0 THEN RAISE EXCEPTION 'stuck: a second close closed %',r; END IF;
END $$;
ROLLBACK;

-- 6. The stale alarm: documents due, the reader on, a run starting every few minutes and none finished
--    for 35 minutes (30 Oct to 3 Nov 2026) is stale; runs closed as stale do not count as finished; one
--    run the reader finished a minute ago clears it; the flag off raises nothing.
BEGIN;
DO $$
DECLARE j uuid:=pg_temp.s_job('SWF-9404'); s jsonb; a jsonb;
BEGIN
 PERFORM pg_temp.s_doc(j,'waiting.pdf');
 DELETE FROM public.context_capture_runs WHERE source='context_document_text';
 DELETE FROM public.feature_flags WHERE flag_name='context_document_text_v1';
 INSERT INTO public.feature_flags(flag_name,enabled,description,updated_at) VALUES('context_document_text_v1',true,'stuck fixture',now()-interval '30 days');
 IF NOT public.automation_lane_enabled('capture') THEN RAISE EXCEPTION 'stuck fixture: the capture lane is off'; END IF;
 INSERT INTO public.context_capture_runs(source,status,started_at,updated_at,finished_at,counts) VALUES
  ('context_document_text','succeeded',now()-interval '36 minutes',now()-interval '35 minutes',now()-interval '35 minutes','{"selected":3,"errors":0}'),
  ('context_document_text','running',now()-interval '25 minutes',now()-interval '25 minutes',NULL,'{}'),
  ('context_document_text','running',now()-interval '4 minutes',now()-interval '4 minutes',NULL,'{}');
 s:=public.context_document_text_status();
 IF (s->>'due_now')::integer<1 THEN RAISE EXCEPTION 'stuck fixture: nothing due %',s->'documents'; END IF;
 SELECT x INTO a FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='document_text_stale';
 IF a IS NULL THEN RAISE EXCEPTION 'stuck: a reader that starts runs and never finishes raised no stale alarm (alarms %)',s->'alarms'; END IF;
 IF (a->>'unfinished_runs_24h')::integer<>1 OR a->>'last_completed_at' IS NULL OR a->>'last_run_status'<>'running'
  OR (s->'reader'->>'unfinished_runs_24h')::integer<>1 THEN RAISE EXCEPTION 'stuck: stale alarm %',a; END IF;
 -- The next run closes the stopped ones: still no run finished, still stale.
 PERFORM public.close_stale_context_document_text_runs();
 s:=public.context_document_text_status();
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='document_text_stale')
 THEN RAISE EXCEPTION 'stuck: a run closed as stale counted as finished'; END IF;
 IF (s->'reader'->>'unfinished_runs_24h')::integer<>1 THEN RAISE EXCEPTION 'stuck: unfinished runs %',s->'reader'; END IF;
 -- A run the reader finished a minute ago: not stale.
 INSERT INTO public.context_capture_runs(source,status,started_at,updated_at,finished_at,counts,error_code) VALUES
  ('context_document_text','partial',now()-interval '2 minutes',now()-interval '1 minute',now()-interval '1 minute','{"selected":20}','time_budget');
 s:=public.context_document_text_status();
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='document_text_stale')
 THEN RAISE EXCEPTION 'stuck: stale alarm after a finished run %',s->'alarms'; END IF;
 -- The flag off: no alarm at all (unchanged).
 DELETE FROM public.context_capture_runs WHERE source='context_document_text' AND status='partial';
 UPDATE public.feature_flags SET enabled=false WHERE flag_name='context_document_text_v1';
 s:=public.context_document_text_status();
 IF jsonb_array_length(s->'alarms')<>0 THEN RAISE EXCEPTION 'stuck: alarm while the flag is off %',s->'alarms'; END IF;
END $$;
ROLLBACK;
