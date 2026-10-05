-- B-5 (context gap plan, done-definition row 5 "Documents"): the database half
-- of the document text reader. The edge function context-document-text is the
-- other half.
--
-- The words inside a job's documents (our quotes, reports, purchase and work
-- orders, builder work orders, PDFs attached to job email) become evidence:
-- one business_events row per document, holding the document's text layer,
-- placed on the document's own job, deduped by the document's content hash.
-- The reader reads only the PDF TEXT LAYER, with the bounded extractor already
-- used by make-safe intake (ops-api/makesafe_pdf_text.ts: 5 MB, 25 pages,
-- 40,000 characters, never throws). It calls no model. A scan or a photo has
-- no text layer: it is recorded no_text_layer so the scorecard can count it
-- and the vision reader (B-5b) can take it next.
--
-- What it does:
--  1. context_document_text_policy(): every threshold, in one place.
--  2. context_document_text_flag(): reads feature_flags.context_document_text_v1.
--     A missing or unreadable row reads as off (fail closed). This migration
--     creates no flag row; the desk turns it on (data/cio-ctx-doc-text/).
--  3. context_document_texts: one record per document per job the reader has
--     tried (outcome, attempts, next try, file kind, content hash, pages and
--     characters, the evidence row). Never words. RLS on with no policy,
--     nothing for PUBLIC, anon or authenticated; service_role may only read it.
--  4. record_context_document_text(jsonb): the table's one writer. A download
--     or save failure waits 15 min, 1 h, 6 h, 24 h; the read after the last
--     wait that still fails is terminal failed:<code>. Every other outcome is
--     terminal at once. A terminal record is reopened only when the document
--     itself changed (its stored location, name or version: the fingerprint).
--  5. context_document_text_sources(): every document on a live job (M4's
--     context_ghl_history_live_jobs(), the one live-job definition):
--       job_documents rows, and
--       context_email_attachments rows stored by the email reader whose email
--       sits on a live job (linked status).
--     With its fingerprint and its own time (the upload, or the email's time).
--  6. context_document_text_due(limit): the sources due a read now: never
--     tried, pending and due, or changed since a terminal outcome; newest
--     first, 20 a run. capture_mode is live for a document from the last 48
--     hours (it wakes a read like any new evidence, cadence K1) and backfill
--     for an older one (it never wakes a read on its own; the edge function
--     lists its jobs for reading through the one history re-list,
--     context_catchup_list_backfill, B-1).
--  7. context_document_text_status(): the scorecard's numbers for live jobs:
--     documents in total, with text, no text layer (pdf and image), not
--     supported, too large, too many pages, unreadable, no file, failed,
--     pending, never tried, changed since read; the reader's runs; and the
--     alarms document_text_stale and document_text_failing, raised only while
--     the capture lane and the flag are on. Counts and codes only.
--  8. trigger_context_document_text(): posts to the edge function with the
--     service key from public.sw_service_key(), only while the flag is on.
--  9. pg_cron job context-document-text every 10 minutes, wrapped in
--     WHERE public.automation_lane_enabled('capture'), and listed in
--     automation_switch_cron_lanes() under capture.
--
-- No flag or switch is turned on, no business_events row is written, and no
-- grant, policy or view is added for anon or authenticated. Every new or
-- re-created function: fixed search_path, EXECUTE revoked from PUBLIC, anon,
-- authenticated.
--
-- Replaces one function: automation_switch_cron_lanes() (the GHL history
-- schedule body of 20261005190000, md5 8c99245789cadf661d4b6be1207f0887,
-- plus one row).
-- Reads, never replaces: capture_business_event(jsonb) (C1a, called by the
-- edge function), record_capture_run(jsonb) (F1b, called by the edge
-- function), context_ghl_history_live_jobs() (M4), automation_lane_enabled
-- (text), context_linked_status(text), sw_service_key(), and the one history
-- re-list context_catchup_list_backfill (B-1, 20261005180000; called by the
-- edge function).
-- The guard refuses unless each is still that pre-image or already this
-- migration's result (a re-apply).
--
-- Rollback: supabase/rollbacks/20261005210000_context_document_text_down.sql
-- (unschedules the job, restores the 20261005190000 lane list, drops the new functions and
-- the table). Evidence rows already saved stay in business_events.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; cmd text; cols text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.automation_switch_cron_lanes()',ARRAY['8c99245789cadf661d4b6be1207f0887','99e6d70e80a79e548f2478b65fc6cd78'],false),
  ('public.capture_business_event(jsonb)',ARRAY['4819869e6dcc40d5cd19a7eba295392c'],false),
  ('public.record_capture_run(jsonb)',ARRAY['db03c98a6da49f128595342f5a93f84c'],false),
  ('public.context_ghl_history_live_jobs()',ARRAY['49eb23015b724a29058c11b2743954bf'],false),
  ('public.automation_lane_enabled(text)',ARRAY['818a13be854748e2d272bdd648c88b59'],false)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF to_regprocedure('public.sw_service_key()') IS NULL THEN problems:=problems||'public.sw_service_key() missing'::text; END IF;
 IF to_regprocedure('public.context_linked_status(text)') IS NULL THEN problems:=problems||'public.context_linked_status(text) missing'::text; END IF;
 -- The one history re-list the edge function calls for backfill rows (B-1).
 IF to_regprocedure('public.context_catchup_list_backfill(text,timestamptz,boolean,integer,integer)') IS NULL
 THEN problems:=problems||'public.context_catchup_list_backfill missing (apply 20261005180000 first)'::text; END IF;
 -- The source columns the reader selects (job_documents.pdf_url and
 -- storage_url are live columns; email attachments are the EM2 table).
 IF (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=to_regclass('public.job_documents')
   AND a.attname IN ('id','job_id','type','file_name','storage_url','pdf_url','version','created_at') AND a.attnum>0 AND NOT a.attisdropped)<>8
 THEN problems:=problems||'job_documents lacks one of id, job_id, type, file_name, storage_url, pdf_url, version, created_at'::text; END IF;
 IF to_regclass('public.context_email_attachments') IS NULL THEN
  problems:=problems||'context_email_attachments missing (apply 20261002150000 first)'::text;
 END IF;
 IF to_regclass('public.context_document_texts') IS NOT NULL THEN
  SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid='public.context_document_texts'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM 'id:uuid,source_kind:text,source_id:uuid,job_id:uuid,source_fingerprint:text,file_kind:text,outcome:text,attempts:integer,next_at:timestamp with time zone,last_code:text,failure_code:text,sha256:text,page_count:integer,char_count:integer,truncated:boolean,event_id:uuid,created_at:timestamp with time zone,updated_at:timestamp with time zone,finished_at:timestamp with time zone'
  THEN problems:=problems||format('context_document_texts exists with columns %s',cols); END IF;
 END IF;
 IF to_regclass('public.feature_flags') IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='context_document_text_v1')
  AND to_regclass('public.context_document_texts') IS NULL
 THEN problems:=problems||'feature flag context_document_text_v1 already exists before the first apply'::text; END IF;
 IF to_regclass('cron.job') IS NOT NULL THEN
  EXECUTE 'SELECT string_agg(command,'' | '') FROM cron.job WHERE jobname=''context-document-text''' INTO cmd;
  IF cmd IS NOT NULL AND cmd<>'SELECT public.trigger_context_document_text() WHERE public.automation_lane_enabled(''capture'')' THEN
   problems:=problems||'cron job context-document-text exists with another command'::text;
  END IF;
 END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_document_text_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. Thresholds.
CREATE OR REPLACE FUNCTION public.context_document_text_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'flag','context_document_text_v1',
  'run_source','context_document_text',
  'event_source','context-document-text',
  'event_type','document.text_extracted',
  'key_prefix','doctext:',
  -- Documents read per run (every 10 minutes), newest first.
  'batch_limit',20,
  -- A document from the last 48 hours is new evidence (capture_mode live,
  -- wakes a read); an older one is history (backfill, listed for reading).
  'live_window_hours',48,
  -- Waits after a failed download or save; the read after the last wait that
  -- fails again is terminal.
  'backoff_minutes',jsonb_build_array(15,60,360,1440),
  -- Priority on the catch-up list for jobs given history documents.
  'catchup_priority',2,
  -- Alarms.
  'stale_minutes',30,
  'failing_min_attempts',5,
  'failing_error_ratio',0.2)
$$;

-- 2. The flag. Fails closed: no table, no row, or an error is off.
CREATE OR REPLACE FUNCTION public.context_document_text_flag() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE on_flag boolean; changed timestamptz;
BEGIN
 IF to_regclass('public.feature_flags') IS NULL THEN RETURN jsonb_build_object('enabled',false,'updated_at',NULL,'state','missing'); END IF;
 EXECUTE 'SELECT f.enabled,f.updated_at FROM public.feature_flags f WHERE f.flag_name=$1 ORDER BY f.updated_at DESC NULLS LAST LIMIT 1'
  INTO on_flag,changed USING 'context_document_text_v1';
 RETURN jsonb_build_object('enabled',coalesce(on_flag,false),'updated_at',changed,'state',CASE WHEN on_flag IS NULL THEN 'missing' ELSE 'present' END);
EXCEPTION WHEN OTHERS THEN
 RETURN jsonb_build_object('enabled',false,'updated_at',NULL,'state','unreadable');
END $$;
COMMENT ON FUNCTION public.context_document_text_flag() IS
 'feature_flags.context_document_text_v1 as {enabled, updated_at, state}. Missing or unreadable reads as off. Owned by gap plan B-5 (document text).';

-- 3. The read records.
CREATE TABLE IF NOT EXISTS public.context_document_texts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_kind text NOT NULL CHECK (source_kind IN ('job_document','email_attachment')),
 source_id uuid NOT NULL,
 job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
 source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{32}$'),
 file_kind text NOT NULL CHECK (file_kind IN ('pdf','image','other')),
 outcome text NOT NULL CHECK (outcome IN ('pending','saved','no_text_layer','not_supported','too_large','too_many_pages','unreadable','no_file','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
 next_at timestamptz,
 last_code text CHECK (last_code IS NULL OR last_code ~ '^[a-z0-9][a-z0-9_.:-]{0,79}$'),
 failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9][a-z0-9_.:-]{0,79}$'),
 sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
 page_count integer CHECK (page_count IS NULL OR page_count>=0),
 char_count integer CHECK (char_count IS NULL OR char_count>=0),
 truncated boolean,
 event_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 CONSTRAINT context_document_texts_one UNIQUE (source_kind,source_id,job_id),
 CONSTRAINT context_document_texts_terminal CHECK ((outcome='pending')=(finished_at IS NULL)),
 CONSTRAINT context_document_texts_pending_next CHECK (outcome<>'pending' OR next_at IS NOT NULL),
 CONSTRAINT context_document_texts_failed_code CHECK ((outcome='failed')=(failure_code IS NOT NULL)),
 CONSTRAINT context_document_texts_saved_event CHECK (outcome<>'saved' OR (event_id IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS context_document_texts_pending ON public.context_document_texts (next_at) WHERE outcome='pending';
CREATE INDEX IF NOT EXISTS context_document_texts_job ON public.context_document_texts (job_id);
ALTER TABLE public.context_document_texts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_document_texts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.context_document_texts TO service_role;
COMMENT ON TABLE public.context_document_texts IS
 'One record per document per job the document text reader has tried (gap plan B-5): outcome, attempts, file kind, content hash, pages and characters, the evidence row. Written only by record_context_document_text(). Never words.';

-- 4. The one writer of context_document_texts.
CREATE OR REPLACE FUNCTION public.record_context_document_text(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_document_text_policy();
 now_time timestamptz:=clock_timestamp();
 kind text; src uuid; job uuid; fp text; fk text; res text; code text; sha text; ev uuid;
 r public.context_document_texts; existed boolean; reopened boolean:=false;
 steps jsonb:=policy->'backoff_minutes'; max_attempts integer; n_attempts integer;
BEGIN
 IF p IS NULL OR jsonb_typeof(p)<>'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('source_kind','source_id','job_id','fingerprint','file_kind',
   'result','code','sha256','page_count','char_count','truncated','event_id'))
 THEN RAISE EXCEPTION 'document_text_invalid'; END IF;
 kind:=p->>'source_kind'; fp:=p->>'fingerprint'; fk:=p->>'file_kind'; res:=p->>'result'; code:=nullif(p->>'code',''); sha:=nullif(p->>'sha256','');
 IF kind IS NULL OR kind NOT IN ('job_document','email_attachment') THEN RAISE EXCEPTION 'document_text_source_invalid'; END IF;
 IF fp IS NULL OR fp !~ '^[0-9a-f]{32}$' THEN RAISE EXCEPTION 'document_text_fingerprint_invalid'; END IF;
 IF fk IS NULL OR fk NOT IN ('pdf','image','other') THEN RAISE EXCEPTION 'document_text_file_kind_invalid'; END IF;
 IF res IS NULL OR res NOT IN ('saved','no_text_layer','not_supported','too_large','too_many_pages','unreadable','no_file','error')
 THEN RAISE EXCEPTION 'document_text_result_invalid'; END IF;
 IF code IS NOT NULL AND code !~ '^[a-z0-9][a-z0-9_.:-]{0,79}$' THEN RAISE EXCEPTION 'document_text_code_invalid'; END IF;
 IF res='error' AND code IS NULL THEN RAISE EXCEPTION 'document_text_code_required'; END IF;
 IF sha IS NOT NULL AND sha !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'document_text_sha256_invalid'; END IF;
 BEGIN
  src:=(p->>'source_id')::uuid; job:=(p->>'job_id')::uuid; ev:=(p->>'event_id')::uuid;
 EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'document_text_invalid';
 END;
 IF src IS NULL OR job IS NULL THEN RAISE EXCEPTION 'document_text_invalid'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=job) THEN RAISE EXCEPTION 'document_text_job_not_found'; END IF;
 -- The source must be this job's document.
 IF kind='job_document' AND NOT EXISTS(SELECT 1 FROM public.job_documents d WHERE d.id=src AND d.job_id=job) THEN
  RAISE EXCEPTION 'document_text_source_not_found';
 END IF;
 IF kind='email_attachment' AND NOT EXISTS(SELECT 1 FROM public.context_email_attachments a
   JOIN public.business_events e ON e.id=a.business_event_id WHERE a.id=src AND e.job_id=job) THEN
  RAISE EXCEPTION 'document_text_source_not_found';
 END IF;
 -- A saved read names the evidence row it saved: doctext:<job>:<sha256>.
 IF res='saved' THEN
  IF sha IS NULL OR ev IS NULL THEN RAISE EXCEPTION 'document_text_invalid'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.business_events e WHERE e.id=ev
    AND e.provider_message_id=(policy->>'key_prefix')||job::text||':'||sha) THEN
   RAISE EXCEPTION 'document_text_event_not_found';
  END IF;
 END IF;

 SELECT * INTO r FROM public.context_document_texts t WHERE t.source_kind=kind AND t.source_id=src AND t.job_id=job FOR UPDATE;
 existed:=FOUND;
 IF existed AND r.outcome<>'pending' THEN
  IF r.source_fingerprint=fp THEN
   RETURN jsonb_build_object('outcome','unchanged','state',r.outcome,'attempts',r.attempts);
  END IF;
  -- The document changed since its terminal outcome: a fresh read.
  reopened:=true;
  r.attempts:=0; r.failure_code:=NULL; r.sha256:=NULL; r.page_count:=NULL; r.char_count:=NULL; r.truncated:=NULL; r.event_id:=NULL;
 END IF;
 IF NOT existed THEN
  r.id:=gen_random_uuid(); r.source_kind:=kind; r.source_id:=src; r.job_id:=job; r.attempts:=0; r.created_at:=now_time;
 END IF;
 r.source_fingerprint:=fp; r.file_kind:=fk; r.updated_at:=now_time; r.last_code:=coalesce(code,res);
 IF sha IS NOT NULL THEN r.sha256:=sha; END IF;
 IF jsonb_typeof(p->'page_count')='number' AND (p->>'page_count')::numeric>=0 THEN r.page_count:=(p->>'page_count')::integer; END IF;
 IF jsonb_typeof(p->'char_count')='number' AND (p->>'char_count')::numeric>=0 THEN r.char_count:=(p->>'char_count')::integer; END IF;
 IF jsonb_typeof(p->'truncated')='boolean' THEN r.truncated:=(p->>'truncated')::boolean; END IF;
 max_attempts:=jsonb_array_length(steps)+1;

 IF res='error' THEN
  n_attempts:=r.attempts+1; r.attempts:=n_attempts;
  IF n_attempts>=max_attempts THEN
   r.outcome:='failed'; r.failure_code:=code; r.next_at:=NULL; r.finished_at:=now_time;
  ELSE
   r.outcome:='pending'; r.finished_at:=NULL;
   r.next_at:=now_time+make_interval(mins=>(steps->>(n_attempts-1))::integer);
  END IF;
 ELSE
  r.attempts:=r.attempts+1; r.outcome:=res; r.next_at:=NULL; r.finished_at:=now_time; r.failure_code:=NULL;
  r.event_id:=CASE WHEN res='saved' THEN ev END;
 END IF;

 IF existed THEN
  UPDATE public.context_document_texts t SET source_fingerprint=r.source_fingerprint,file_kind=r.file_kind,outcome=r.outcome,
   attempts=r.attempts,next_at=r.next_at,last_code=r.last_code,failure_code=r.failure_code,sha256=r.sha256,page_count=r.page_count,
   char_count=r.char_count,truncated=r.truncated,event_id=r.event_id,updated_at=r.updated_at,finished_at=r.finished_at
  WHERE t.id=r.id;
 ELSE
  INSERT INTO public.context_document_texts (id,source_kind,source_id,job_id,source_fingerprint,file_kind,outcome,attempts,next_at,
   last_code,failure_code,sha256,page_count,char_count,truncated,event_id,created_at,updated_at,finished_at)
  VALUES (r.id,r.source_kind,r.source_id,r.job_id,r.source_fingerprint,r.file_kind,r.outcome,r.attempts,r.next_at,
   r.last_code,r.failure_code,r.sha256,r.page_count,r.char_count,r.truncated,r.event_id,r.created_at,r.updated_at,r.finished_at);
 END IF;

 RETURN jsonb_build_object('outcome',CASE WHEN r.outcome='failed' THEN 'failed:'||r.failure_code ELSE r.outcome END,
  'state',r.outcome,'attempts',r.attempts,'next_at',r.next_at,'reopened',reopened);
END $$;
COMMENT ON FUNCTION public.record_context_document_text(jsonb) IS
 'The one writer of context_document_texts (gap plan B-5). result: saved | no_text_layer | not_supported | too_large | too_many_pages | unreadable | no_file | error. Owns the backoff (waits of 15m, 1h, 6h, 24h; the read after the last wait that fails again is terminal failed:<code>); every other result is terminal at once; a terminal record reopens only when the document''s fingerprint changed. Refusal codes: document_text_invalid, _source_invalid, _fingerprint_invalid, _file_kind_invalid, _result_invalid, _code_invalid, _code_required, _sha256_invalid, _job_not_found, _source_not_found, _event_not_found.';

-- 5. Every document on a live job.
CREATE OR REPLACE FUNCTION public.context_document_text_sources()
RETURNS TABLE (source_kind text, source_id uuid, job_id uuid, job_number text, file_name text, doc_type text, content_type text,
 storage_bucket text, storage_path text, storage_url text, pdf_url text, fingerprint text, doc_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH live AS (
  SELECT l.job_id, min(l.job_number) AS job_number FROM public.context_ghl_history_live_jobs() l GROUP BY l.job_id
 )
 SELECT 'job_document'::text, d.id, d.job_id, lv.job_number, d.file_name, d.type, NULL::text,
  NULL::text, NULL::text, d.storage_url, d.pdf_url,
  md5(concat_ws('|',coalesce(d.storage_url,''),coalesce(d.pdf_url,''),coalesce(d.file_name,''),coalesce(d.version::text,''))),
  d.created_at
 FROM public.job_documents d JOIN live lv ON lv.job_id=d.job_id
 UNION ALL
 SELECT 'email_attachment'::text, a.id, e.job_id, lv.job_number, a.file_name, 'email_attachment'::text, a.content_type,
  a.storage_bucket, a.storage_path, NULL::text, NULL::text,
  md5(concat_ws('|',a.storage_bucket,a.storage_path,coalesce(a.sha256,''),coalesce(a.file_name,''))),
  coalesce(e.event_at,e.occurred_at)
 FROM public.context_email_attachments a
 JOIN public.business_events e ON e.id=a.business_event_id
 JOIN live lv ON lv.job_id=e.job_id
 WHERE a.status='stored' AND public.context_linked_status(e.attribution_status)
$$;
COMMENT ON FUNCTION public.context_document_text_sources() IS
 'Every document on a live job (gap plan B-5; live jobs are M4''s context_ghl_history_live_jobs()): job_documents rows, and email attachments the email reader stored whose email sits on a live job. With a fingerprint of its stored location, name and version, and its own time. Read only.';

-- 6. Documents due a read now.
CREATE OR REPLACE FUNCTION public.context_document_text_due(p_limit integer DEFAULT 20)
RETURNS TABLE (source_kind text, source_id uuid, job_id uuid, job_number text, file_name text, doc_type text, content_type text,
 storage_bucket text, storage_path text, storage_url text, pdf_url text, fingerprint text, doc_at timestamptz,
 capture_mode text, attempts integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT s.source_kind, s.source_id, s.job_id, s.job_number, s.file_name, s.doc_type, s.content_type,
  s.storage_bucket, s.storage_path, s.storage_url, s.pdf_url, s.fingerprint, s.doc_at,
  CASE WHEN s.doc_at>=now()-make_interval(hours=>(public.context_document_text_policy()->>'live_window_hours')::integer)
   THEN 'live' ELSE 'backfill' END,
  CASE WHEN t.outcome='pending' THEN t.attempts ELSE 0 END
 FROM public.context_document_text_sources() s
 LEFT JOIN public.context_document_texts t ON t.source_kind=s.source_kind AND t.source_id=s.source_id AND t.job_id=s.job_id
 WHERE t.id IS NULL
  OR (t.outcome='pending' AND t.next_at<=now())
  OR (t.outcome<>'pending' AND t.source_fingerprint<>s.fingerprint)
 ORDER BY s.doc_at DESC NULLS LAST, s.source_id
 LIMIT greatest(1,least(coalesce(p_limit,20),100))
$$;
COMMENT ON FUNCTION public.context_document_text_due(integer) IS
 'Documents on live jobs due a text read now (gap plan B-5): never tried, pending with the next try due, or changed since a terminal outcome; newest first. capture_mode is live for a document from the last 48 hours, else backfill.';

-- 7. The status block.
CREATE OR REPLACE FUNCTION public.context_document_text_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_document_text_policy();
 now_time timestamptz:=now();
 flag jsonb:=public.context_document_text_flag();
 flag_on boolean:=(flag->>'enabled')::boolean;
 lane_on boolean:=public.automation_lane_enabled('capture');
 last_run jsonb; last_run_at timestamptz; runs jsonb; attempts_24h bigint; errors_24h bigint;
 docs jsonb; due integer; alarms jsonb:='[]'::jsonb; since timestamptz;
BEGIN
 SELECT jsonb_build_object('run_id',c.id,'status',c.status,'started_at',c.started_at,'finished_at',c.finished_at,
   'error_code',c.error_code,'counts',c.counts), c.started_at
 INTO last_run,last_run_at FROM public.context_capture_runs c WHERE c.source=policy->>'run_source' ORDER BY c.started_at DESC LIMIT 1;
 SELECT coalesce(jsonb_object_agg(s.status,s.n),'{}'::jsonb) INTO runs FROM (
  SELECT c.status,count(*) n FROM public.context_capture_runs c
  WHERE c.source=policy->>'run_source' AND c.started_at>now_time-interval '24 hours' GROUP BY c.status) s;
 SELECT coalesce(sum(CASE WHEN jsonb_typeof(c.counts->'selected')='number' THEN (c.counts->>'selected')::bigint ELSE 0 END),0),
  coalesce(sum(CASE WHEN jsonb_typeof(c.counts->'errors')='number' THEN (c.counts->>'errors')::bigint ELSE 0 END),0)
 INTO attempts_24h,errors_24h FROM public.context_capture_runs c
 WHERE c.source=policy->>'run_source' AND c.started_at>now_time-interval '24 hours';

 WITH j AS (
  SELECT s.*, t.outcome, t.file_kind, t.next_at, t.source_fingerprint
  FROM public.context_document_text_sources() s
  LEFT JOIN public.context_document_texts t ON t.source_kind=s.source_kind AND t.source_id=s.source_id AND t.job_id=s.job_id
 )
 SELECT jsonb_build_object(
  'total',count(*),
  'jobs',count(DISTINCT j.job_id),
  'with_text',count(*) FILTER (WHERE j.outcome='saved' AND j.source_fingerprint=j.fingerprint),
  'no_text_layer',count(*) FILTER (WHERE j.outcome='no_text_layer' AND j.source_fingerprint=j.fingerprint),
  'no_text_layer_pdf',count(*) FILTER (WHERE j.outcome='no_text_layer' AND j.file_kind='pdf' AND j.source_fingerprint=j.fingerprint),
  'no_text_layer_image',count(*) FILTER (WHERE j.outcome='no_text_layer' AND j.file_kind='image' AND j.source_fingerprint=j.fingerprint),
  'not_supported',count(*) FILTER (WHERE j.outcome='not_supported' AND j.source_fingerprint=j.fingerprint),
  'too_large',count(*) FILTER (WHERE j.outcome='too_large' AND j.source_fingerprint=j.fingerprint),
  'too_many_pages',count(*) FILTER (WHERE j.outcome='too_many_pages' AND j.source_fingerprint=j.fingerprint),
  'unreadable',count(*) FILTER (WHERE j.outcome='unreadable' AND j.source_fingerprint=j.fingerprint),
  'no_file',count(*) FILTER (WHERE j.outcome='no_file' AND j.source_fingerprint=j.fingerprint),
  'failed',count(*) FILTER (WHERE j.outcome='failed' AND j.source_fingerprint=j.fingerprint),
  'pending',count(*) FILTER (WHERE j.outcome='pending'),
  'never_tried',count(*) FILTER (WHERE j.outcome IS NULL),
  'changed_since_read',count(*) FILTER (WHERE j.outcome IS NOT NULL AND j.outcome<>'pending' AND j.source_fingerprint<>j.fingerprint)),
  count(*) FILTER (WHERE j.outcome IS NULL OR (j.outcome='pending' AND j.next_at<=now_time)
   OR (j.outcome<>'pending' AND j.source_fingerprint<>j.fingerprint))::integer
 INTO docs,due FROM j;

 IF lane_on AND flag_on THEN
  since:=coalesce(last_run_at,(flag->>'updated_at')::timestamptz);
  IF due>0 AND since IS NOT NULL AND now_time-since>make_interval(mins=>(policy->>'stale_minutes')::integer) THEN
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','document_text_stale','severity','warning','since',since,'due',due,
    'last_run_status',last_run->>'status','last_run_error',last_run->>'error_code',
    'what_to_do','Documents are waiting for a text read but the 10-minute reader has not run for 30 minutes. Check the context-document-text cron job and edge function logs, and the capture lane.'));
  END IF;
  IF attempts_24h>=(policy->>'failing_min_attempts')::integer AND errors_24h>(policy->>'failing_error_ratio')::numeric*attempts_24h THEN
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','document_text_failing','severity','warning','since',now_time-interval '24 hours',
    'attempts_24h',attempts_24h,'errors_24h',errors_24h,
    'what_to_do','More than 1 in 5 document reads failed in 24 hours. Check the failure codes in context_document_texts and the storage buckets.'));
  END IF;
 END IF;

 RETURN jsonb_build_object('as_of',now_time,'policy',policy,'flag',flag,'capture_lane',lane_on,
  'reader',jsonb_build_object('last_run',last_run,'runs_24h',runs,'selected_24h',attempts_24h,'errors_24h',errors_24h),
  'documents',docs,'due_now',coalesce(due,0),'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_document_text_status() IS
 'Document text status (gap plan B-5): for every document on a live job, how many carry their text as evidence, how many have no text layer (pdf and image, for the vision reader B-5b), the other outcomes, pending and never tried; the reader''s runs; the alarms document_text_stale and document_text_failing. Counts and codes only, never words.';

-- 8. The cron caller. Idle while the flag is off: no HTTP call at all.
CREATE OR REPLACE FUNCTION public.trigger_context_document_text() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT (public.context_document_text_flag()->>'enabled')::boolean THEN
  RETURN;
 END IF;
 PERFORM net.http_post(
  url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/context-document-text',
  body := jsonb_build_object('actor','cron:context-document-text'),
  headers := jsonb_build_object('Authorization','Bearer '||public.sw_service_key(),'Content-Type','application/json'),
  timeout_milliseconds := 5000
 );
END $$;
COMMENT ON FUNCTION public.trigger_context_document_text() IS
 'pg_cron context-document-text (every 10 minutes, capture lane): posts to the context-document-text edge function with the service key while feature flag context_document_text_v1 is on. Owned by gap plan B-5.';

-- 9. The capture lane owns the new job: the 20261005190000 body plus one row.
CREATE OR REPLACE FUNCTION public.automation_switch_cron_lanes()
RETURNS TABLE (cron_jobname text, lane text)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT * FROM (VALUES
    -- capture: pollers that write evidence rows into business_events
    ('monitor-inbox-poll', 'capture'),
    ('ghl-message-reconcile', 'capture'),
    ('ghl-call-transcript-fetch', 'capture'),
    ('outlook-mail-poll', 'capture'),
    ('monitor-inbox-sweep', 'capture'),
    ('ghl-history-schedule', 'capture'),
    ('context-document-text', 'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;

-- Scheduled already gated, so the switch's wrap reports already_wrapped and its
-- unwrap can remove the suffix. Skipped where pg_cron is absent (contract runner).
DO $cron$
BEGIN
 IF to_regclass('cron.job') IS NULL THEN
  RAISE NOTICE 'context-document-text: pg_cron absent, not scheduled';
  RETURN;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='context-document-text') THEN
  PERFORM cron.schedule('context-document-text','7-59/10 * * * *',
   $cmd$SELECT public.trigger_context_document_text() WHERE public.automation_lane_enabled('capture')$cmd$);
 END IF;
END $cron$;

-- 10. Grants. Service-side only.
REVOKE ALL ON FUNCTION public.context_document_text_policy(),public.context_document_text_flag(),
 public.record_context_document_text(jsonb),public.context_document_text_sources(),public.context_document_text_due(integer),
 public.context_document_text_status(),public.trigger_context_document_text() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_document_text_policy(),public.context_document_text_flag(),
 public.record_context_document_text(jsonb),public.context_document_text_sources(),public.context_document_text_due(integer),
 public.context_document_text_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.trigger_context_document_text() TO postgres;
REVOKE ALL ON FUNCTION public.automation_switch_cron_lanes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_switch_cron_lanes() TO service_role, postgres;
