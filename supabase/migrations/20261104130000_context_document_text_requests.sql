-- Named read requests for the document text reader (Scope Engine A4 support, CIO 3 Nov 2026 17:20Z).
--
-- Why: the text reader (B-5, 20261005210000) reads only documents on a live job, so a supplier bill
-- emailed to us and never placed on a job is never read, and a PDF over 5 MB is recorded too_large for
-- good (a terminal record reopens only when the document's fingerprint changes). Scope Engine's patio
-- row A4 needs the words of 16 stored, unplaced supplier bills and of one 5.4 MB quote on a live job.
--
-- What it does:
--  1. context_document_text_requests: one row per document someone asks the reader to read, with who
--     asked and why, and optionally a higher PDF size limit (5,000,001 to 20,000,000 bytes; pages and
--     characters keep their limits, 25 and 40,000). RLS on with no policy; service_role may only read
--     it. Rows are filed by a reviewed script (postgres), never by the reader.
--  2. An email attachment named by a request whose email is on NO job is read on no job:
--     context_document_texts.job_id and context_document_vision_reads.job_id may now be NULL, only for
--     an email attachment, at most one such record per attachment. Its evidence row
--     (document.text_extracted) carries no job, is keyed doctext:no_job:<sha-256 of the bytes>, and is
--     marked automated so the attribution ladder never places it on a job (the reader's text names job
--     numbers and addresses the ladder would otherwise follow). Nothing is placed or moved: the email,
--     the attachment and every job stay as they are. An attachment whose email is on a job is read on
--     that job exactly as before; one whose email is on a job that is not live is not read (as before).
--  3. A request with a higher size limit gives its document a new fingerprint (the old one plus
--     "|max:<bytes>"), so a terminal too_large record reopens once and the document is read again at
--     that limit. Documents with no request keep exactly their old fingerprint, so nothing else is
--     re-read.
--  4. Requested documents are handed out only by the two new functions
--     context_document_text_requested_due(limit) and context_document_vision_requested_due(limit),
--     which only the new edge functions call. context_document_text_due and context_document_vision_due
--     keep their signatures and leave every requested document out, so an edge function deployed before
--     this change never sees a document on no job and never reads a raised size at 5 MB.
--  5. The policy gains no_job_key ('no_job') and request_max_pdf_bytes (20,000,000).
--  6. Every join of a read record to its source now matches a NULL job to a NULL job (IS NOT DISTINCT
--     FROM): sources, due, status, the text writer, and the vision due, claim, writer, lease and status.
--     For a document on a job each reads exactly as before.
--
-- No flag or switch is turned on, no request row is filed, no business_events row is written, and no
-- grant, policy or view is added for anon or authenticated. Every new or re-created function: fixed
-- search_path, EXECUTE revoked from PUBLIC, anon, authenticated.
--
-- Replaces ten functions, guarded on their live bodies (md5 of prosrc, read from production 3 Nov 2026
-- and equal to the contract stack): context_document_text_policy() 0c40a543..., context_document_text_sources()
-- 3a8554d4..., context_document_text_due(integer) 39a9301a..., record_context_document_text(jsonb) a1cb2fdd...,
-- context_document_text_status() 5b032575..., context_document_vision_due(integer) 82c241b4...,
-- claim_context_document_vision(jsonb) 917a31af..., record_context_document_vision(jsonb) 318b0ff1...,
-- context_document_vision_leased(uuid) 3c82eb91..., context_document_vision_status() 081a4f08....
-- Reads, never replaces: context_ghl_history_live_jobs(), context_linked_status(text),
-- context_document_vision_policy(), reserve_context_model_call (through the claim) and
-- capture_business_event (called by the edge functions). The guard refuses unless each replaced body
-- is still that pre-image or already this migration's result (a re-apply).
--
-- Rollback: supabase/rollbacks/20261104130000_context_document_text_requests_down.sql (restores the ten
-- bodies byte for byte, deletes the no-job read records, restores job_id NOT NULL, drops the request
-- table and the two new functions). Evidence rows already saved stay in business_events.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; cols text; nn boolean;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_document_text_policy()',ARRAY['0c40a54309ab625cdc35c935026ef240','e672da9e885bfbaeef5007c0cd756060']),
  ('public.context_document_text_sources()',ARRAY['3a8554d41d1b10718599c55d65e56110','87a37fec51c8968cda757d056b083568']),
  ('public.context_document_text_due(integer)',ARRAY['39a9301aabb3ee602b25ccaa0b7105eb','5db9fb144443a9ce3e83cb6d13b4c2f9']),
  ('public.record_context_document_text(jsonb)',ARRAY['a1cb2fdddb7a3f008274c7ca077282ba','c09711fa2928f366daecb41deed7e3ed']),
  ('public.context_document_text_status()',ARRAY['5b0325757d95f2dc3497332b34108c44','69cafa2747e11a63c10179195054865a']),
  ('public.context_document_vision_due(integer)',ARRAY['82c241b4054ae531da2959ae93d752b8','5f843b615f8c21e155e08da9580358ba']),
  ('public.claim_context_document_vision(jsonb)',ARRAY['917a31afd7eabcace99f060bf8311a7c','673a48233da0ac9f40d3d8415076b424']),
  ('public.record_context_document_vision(jsonb)',ARRAY['318b0ff112334a6b7b012e46ae3d1be2','8f13831740b81b7da9ad6240372c0540']),
  ('public.context_document_vision_leased(uuid)',ARRAY['3c82eb91f1d3c457f9c003c274d5b594','616286959c9d638eee2a1558a625cfd2']),
  ('public.context_document_vision_status()',ARRAY['081a4f082618072351a8e9dfee6790f9','5dfc83c4eba046329dee9dda60ff5f7e'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 -- The two new functions are absent, or already this migration's (a re-apply).
 FOR x IN SELECT * FROM (VALUES
  ('public.context_document_text_requested_due(integer)','5e74fdf94f066111ac7e3f5771a225bb'),
  ('public.context_document_vision_requested_due(integer)','0c22d66b98714327b668bb66aca883be')
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NOT NULL AND live<>x.accepted THEN problems:=problems||format('%s exists with md5 %s',x.sig,live); END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
   AND p.proname IN ('context_document_text_due','context_document_vision_due','context_document_text_requested_due','context_document_vision_requested_due')
   AND p.oid NOT IN (coalesce(to_regprocedure('public.context_document_text_due(integer)'),0),coalesce(to_regprocedure('public.context_document_vision_due(integer)'),0),
    coalesce(to_regprocedure('public.context_document_text_requested_due(integer)'),0),coalesce(to_regprocedure('public.context_document_vision_requested_due(integer)'),0)))
 THEN problems:=problems||'another overload of a due function exists'::text; END IF;
 -- The read records, exactly as 20261005210000 and 20261006001000 made them; job_id NOT NULL, or
 -- already nullable with this migration's check (a re-apply).
 IF to_regclass('public.context_document_texts') IS NULL THEN
  problems:=problems||'context_document_texts missing (apply 20261005210000 first)'::text;
 ELSE
  SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid='public.context_document_texts'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM 'id:uuid,source_kind:text,source_id:uuid,job_id:uuid,source_fingerprint:text,file_kind:text,outcome:text,attempts:integer,next_at:timestamp with time zone,last_code:text,failure_code:text,sha256:text,page_count:integer,char_count:integer,truncated:boolean,event_id:uuid,created_at:timestamp with time zone,updated_at:timestamp with time zone,finished_at:timestamp with time zone'
  THEN problems:=problems||format('context_document_texts has columns %s',cols); END IF;
  SELECT a.attnotnull INTO nn FROM pg_attribute a WHERE a.attrelid='public.context_document_texts'::regclass AND a.attname='job_id';
  IF NOT nn AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.context_document_texts'::regclass AND conname='context_document_texts_no_job_attachment')
  THEN problems:=problems||'context_document_texts.job_id is nullable without this migration''s check'::text; END IF;
 END IF;
 IF to_regclass('public.context_document_vision_reads') IS NULL THEN
  problems:=problems||'context_document_vision_reads missing (apply 20261006001000 first)'::text;
 ELSE
  SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid='public.context_document_vision_reads'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM 'id:uuid,source_kind:text,source_id:uuid,job_id:uuid,source_fingerprint:text,file_kind:text,outcome:text,attempts:integer,next_at:timestamp with time zone,lease_until:timestamp with time zone,reservation_id:uuid,last_code:text,failure_code:text,sha256:text,page_count:integer,image_count:integer,images_cut:boolean,char_count:integer,truncated:boolean,model:text,confidence:numeric(4,3),people_visible:boolean,event_id:uuid,created_at:timestamp with time zone,updated_at:timestamp with time zone,finished_at:timestamp with time zone'
  THEN problems:=problems||format('context_document_vision_reads has columns %s',cols); END IF;
  SELECT a.attnotnull INTO nn FROM pg_attribute a WHERE a.attrelid='public.context_document_vision_reads'::regclass AND a.attname='job_id';
  IF NOT nn AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.context_document_vision_reads'::regclass AND conname='context_document_vision_reads_no_job_attachment')
  THEN problems:=problems||'context_document_vision_reads.job_id is nullable without this migration''s check'::text; END IF;
 END IF;
 IF to_regclass('public.context_document_text_requests') IS NOT NULL THEN
  SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid='public.context_document_text_requests'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM 'source_kind:text,source_id:uuid,max_pdf_bytes:integer,requested_by:text,reason:text,requested_at:timestamp with time zone'
  THEN problems:=problems||format('context_document_text_requests exists with columns %s',cols); END IF;
 END IF;
 IF to_regclass('public.context_email_attachments') IS NULL THEN problems:=problems||'context_email_attachments missing'::text; END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_document_text_requests_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The requests.
CREATE TABLE IF NOT EXISTS public.context_document_text_requests (
 source_kind text NOT NULL CHECK (source_kind IN ('job_document','email_attachment')),
 source_id uuid NOT NULL,
 -- A higher PDF size limit for this document, or NULL for the default (5 MB).
 max_pdf_bytes integer CHECK (max_pdf_bytes IS NULL OR max_pdf_bytes BETWEEN 5000001 AND 20000000),
 requested_by text NOT NULL CHECK (btrim(requested_by)<>'' AND length(requested_by)<=80),
 reason text NOT NULL CHECK (btrim(reason)<>'' AND length(reason)<=300),
 requested_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT context_document_text_requests_pkey PRIMARY KEY (source_kind,source_id)
);
ALTER TABLE public.context_document_text_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_document_text_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.context_document_text_requests TO service_role;
COMMENT ON TABLE public.context_document_text_requests IS
 'Documents someone asked the document text reader to read (20261104130000): who asked, why, and optionally a higher PDF size limit (5,000,001 to 20,000,000 bytes; pages and characters keep their limits). An email attachment named here whose email is on no job is read on no job (doctext:no_job:<sha256>, marked automated, never placed). Filed by a reviewed script as postgres; service_role may only read it. Never words.';

-- 2. A read on no job, only for an email attachment, at most one per attachment.
ALTER TABLE public.context_document_texts ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE public.context_document_vision_reads ALTER COLUMN job_id DROP NOT NULL;
DO $c$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.context_document_texts'::regclass AND conname='context_document_texts_no_job_attachment') THEN
  ALTER TABLE public.context_document_texts ADD CONSTRAINT context_document_texts_no_job_attachment
   CHECK (job_id IS NOT NULL OR source_kind='email_attachment');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.context_document_vision_reads'::regclass AND conname='context_document_vision_reads_no_job_attachment') THEN
  ALTER TABLE public.context_document_vision_reads ADD CONSTRAINT context_document_vision_reads_no_job_attachment
   CHECK (job_id IS NOT NULL OR source_kind='email_attachment');
 END IF;
END $c$;
CREATE UNIQUE INDEX IF NOT EXISTS context_document_texts_one_no_job ON public.context_document_texts (source_kind,source_id) WHERE job_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS context_document_vision_reads_one_no_job ON public.context_document_vision_reads (source_kind,source_id) WHERE job_id IS NULL;

-- 3. Thresholds: the 20261005210000 body plus no_job_key and request_max_pdf_bytes.
CREATE OR REPLACE FUNCTION public.context_document_text_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'flag','context_document_text_v1',
  'run_source','context_document_text',
  'event_source','context-document-text',
  'event_type','document.text_extracted',
  'key_prefix','doctext:',
  -- A requested read of an email attachment whose email is on no job is keyed
  -- doctext:no_job:<sha256> and placed on no job (20261104130000).
  'no_job_key','no_job',
  -- Documents read per run (every 10 minutes), newest first.
  'batch_limit',20,
  -- A document from the last 48 hours is new evidence (capture_mode live,
  -- wakes a read); an older one is history (backfill, listed for reading).
  'live_window_hours',48,
  -- Waits after a failed download or save; the read after the last wait that
  -- fails again is terminal.
  'backoff_minutes',jsonb_build_array(15,60,360,1440),
  -- The most a read request may raise one PDF's size limit to (20261104130000);
  -- pages (25) and characters (40,000) keep their limits.
  'request_max_pdf_bytes',20000000,
  -- Priority on the catch-up list for jobs given history documents.
  'catchup_priority',2,
  -- Alarms.
  'stale_minutes',30,
  'failing_min_attempts',5,
  'failing_error_ratio',0.2)
$$;

-- 4. Every document the reader reads: on a live job, or named by a request whose email is on no job.
CREATE OR REPLACE FUNCTION public.context_document_text_sources()
RETURNS TABLE (source_kind text, source_id uuid, job_id uuid, job_number text, file_name text, doc_type text, content_type text,
 storage_bucket text, storage_path text, storage_url text, pdf_url text, fingerprint text, doc_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH live AS (
  SELECT l.job_id, min(l.job_number) AS job_number FROM public.context_ghl_history_live_jobs() l GROUP BY l.job_id
 )
 -- A request's higher size limit is part of the fingerprint (|max:<bytes>), so a terminal read reopens
 -- once at that limit; with no request the fingerprint is exactly the 20261005210000 one.
 SELECT 'job_document'::text, d.id, d.job_id, lv.job_number, d.file_name, d.type, NULL::text,
  NULL::text, NULL::text, d.storage_url, d.pdf_url,
  md5(concat_ws('|',coalesce(d.storage_url,''),coalesce(d.pdf_url,''),coalesce(d.file_name,''),coalesce(d.version::text,''))
   ||coalesce('|max:'||q.max_pdf_bytes::text,'')),
  d.created_at
 FROM public.job_documents d JOIN live lv ON lv.job_id=d.job_id
 LEFT JOIN public.context_document_text_requests q ON q.source_kind='job_document' AND q.source_id=d.id
 UNION ALL
 SELECT 'email_attachment'::text, a.id, e.job_id, lv.job_number, a.file_name, 'email_attachment'::text, a.content_type,
  a.storage_bucket, a.storage_path, NULL::text, NULL::text,
  md5(concat_ws('|',a.storage_bucket,a.storage_path,coalesce(a.sha256,''),coalesce(a.file_name,''))
   ||coalesce('|max:'||q.max_pdf_bytes::text,'')),
  coalesce(e.event_at,e.occurred_at)
 FROM public.context_email_attachments a
 JOIN public.business_events e ON e.id=a.business_event_id
 JOIN live lv ON lv.job_id=e.job_id
 LEFT JOIN public.context_document_text_requests q ON q.source_kind='email_attachment' AND q.source_id=a.id
 WHERE a.status='stored' AND public.context_linked_status(e.attribution_status)
 UNION ALL
 -- A requested attachment whose email is on no job: read on no job.
 SELECT 'email_attachment'::text, a.id, NULL::uuid, NULL::text, a.file_name, 'email_attachment'::text, a.content_type,
  a.storage_bucket, a.storage_path, NULL::text, NULL::text,
  md5(concat_ws('|',a.storage_bucket,a.storage_path,coalesce(a.sha256,''),coalesce(a.file_name,''))
   ||coalesce('|max:'||q.max_pdf_bytes::text,'')),
  coalesce(e.event_at,e.occurred_at)
 FROM public.context_document_text_requests q
 JOIN public.context_email_attachments a ON a.id=q.source_id
 JOIN public.business_events e ON e.id=a.business_event_id
 WHERE q.source_kind='email_attachment' AND a.status='stored' AND e.job_id IS NULL
$$;
COMMENT ON FUNCTION public.context_document_text_sources() IS
 'Every document the text reader reads (gap plan B-5; requests 20261104130000): job_documents rows on a live job (M4''s context_ghl_history_live_jobs()), email attachments the email reader stored whose email sits on a live job, and email attachments named in context_document_text_requests whose email is on no job (job_id NULL). With a fingerprint of its stored location, name and version (plus |max:<bytes> when a request raises its size limit), and its own time. Read only.';

-- 5. Documents due a read now, as before: every requested document is left out (the requested list
--    has them), so an edge function from before this change never sees one.
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
 LEFT JOIN public.context_document_texts t ON t.source_kind=s.source_kind AND t.source_id=s.source_id AND t.job_id IS NOT DISTINCT FROM s.job_id
 WHERE (t.id IS NULL
  OR (t.outcome='pending' AND t.next_at<=now())
  OR (t.outcome<>'pending' AND t.source_fingerprint<>s.fingerprint))
  AND NOT EXISTS(SELECT 1 FROM public.context_document_text_requests q WHERE q.source_kind=s.source_kind AND q.source_id=s.source_id)
 ORDER BY s.doc_at DESC NULLS LAST, s.source_id
 LIMIT greatest(1,least(coalesce(p_limit,20),100))
$$;
COMMENT ON FUNCTION public.context_document_text_due(integer) IS
 'Documents on live jobs due a text read now (gap plan B-5): never tried, pending with the next try due, or changed since a terminal outcome; newest first. capture_mode is live for a document from the last 48 hours, else backfill. A document named in context_document_text_requests is never listed here: context_document_text_requested_due lists it (20261104130000).';

-- 6. Requested documents due a read now, with the size limit each may be read at.
CREATE OR REPLACE FUNCTION public.context_document_text_requested_due(p_limit integer DEFAULT 20)
RETURNS TABLE (source_kind text, source_id uuid, job_id uuid, job_number text, file_name text, doc_type text, content_type text,
 storage_bucket text, storage_path text, storage_url text, pdf_url text, fingerprint text, doc_at timestamptz,
 capture_mode text, attempts integer, max_pdf_bytes integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT s.source_kind, s.source_id, s.job_id, s.job_number, s.file_name, s.doc_type, s.content_type,
  s.storage_bucket, s.storage_path, s.storage_url, s.pdf_url, s.fingerprint, s.doc_at,
  -- A read on no job wakes no read: always history.
  CASE WHEN s.job_id IS NOT NULL
    AND s.doc_at>=now()-make_interval(hours=>(public.context_document_text_policy()->>'live_window_hours')::integer)
   THEN 'live' ELSE 'backfill' END,
  CASE WHEN t.outcome='pending' THEN t.attempts ELSE 0 END,
  -- LEAST ignores a NULL, so no raised limit stays NULL (the default).
  CASE WHEN q.max_pdf_bytes IS NOT NULL
   THEN least(q.max_pdf_bytes,(public.context_document_text_policy()->>'request_max_pdf_bytes')::integer) END
 FROM public.context_document_text_sources() s
 JOIN public.context_document_text_requests q ON q.source_kind=s.source_kind AND q.source_id=s.source_id
 LEFT JOIN public.context_document_texts t ON t.source_kind=s.source_kind AND t.source_id=s.source_id AND t.job_id IS NOT DISTINCT FROM s.job_id
 WHERE t.id IS NULL
  OR (t.outcome='pending' AND t.next_at<=now())
  OR (t.outcome<>'pending' AND t.source_fingerprint<>s.fingerprint)
 ORDER BY s.doc_at DESC NULLS LAST, s.source_id
 LIMIT greatest(1,least(coalesce(p_limit,20),100))
$$;
COMMENT ON FUNCTION public.context_document_text_requested_due(integer) IS
 'Documents named in context_document_text_requests due a text read now (20261104130000): never tried, pending with the next try due, or changed since a terminal outcome (a request''s higher size limit changes the fingerprint); newest first. job_id is NULL for an attachment whose email is on no job (capture_mode always backfill). max_pdf_bytes is the request''s size limit (NULL: the default), never above the policy''s request_max_pdf_bytes.';

-- 7. The one writer of context_document_texts: the 20261005210000 body, with a read on no job.
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
 IF src IS NULL THEN RAISE EXCEPTION 'document_text_invalid'; END IF;
 IF job IS NULL THEN
  -- Requests (20261104130000): only an email attachment a request names, whose email is on no job,
  -- is read on no job.
  IF kind<>'email_attachment' OR NOT EXISTS(SELECT 1 FROM public.context_document_text_requests q
    JOIN public.context_email_attachments a ON a.id=q.source_id
    JOIN public.business_events e ON e.id=a.business_event_id
    WHERE q.source_kind='email_attachment' AND q.source_id=src AND e.job_id IS NULL) THEN
   RAISE EXCEPTION 'document_text_source_not_found';
  END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=job) THEN RAISE EXCEPTION 'document_text_job_not_found'; END IF;
  -- The source must be this job's document.
  IF kind='job_document' AND NOT EXISTS(SELECT 1 FROM public.job_documents d WHERE d.id=src AND d.job_id=job) THEN
   RAISE EXCEPTION 'document_text_source_not_found';
  END IF;
  IF kind='email_attachment' AND NOT EXISTS(SELECT 1 FROM public.context_email_attachments a
    JOIN public.business_events e ON e.id=a.business_event_id WHERE a.id=src AND e.job_id=job) THEN
   RAISE EXCEPTION 'document_text_source_not_found';
  END IF;
 END IF;
 -- A saved read names the evidence row it saved: doctext:<job>:<sha256>, or doctext:no_job:<sha256>
 -- on no job (and that row is on no job).
 IF res='saved' THEN
  IF sha IS NULL OR ev IS NULL THEN RAISE EXCEPTION 'document_text_invalid'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.business_events e WHERE e.id=ev
    AND e.provider_message_id=(policy->>'key_prefix')||coalesce(job::text,policy->>'no_job_key')||':'||sha
    AND (job IS NOT NULL OR e.job_id IS NULL)) THEN
   RAISE EXCEPTION 'document_text_event_not_found';
  END IF;
 END IF;

 SELECT * INTO r FROM public.context_document_texts t WHERE t.source_kind=kind AND t.source_id=src AND t.job_id IS NOT DISTINCT FROM job FOR UPDATE;
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
 'The one writer of context_document_texts (gap plan B-5). result: saved | no_text_layer | not_supported | too_large | too_many_pages | unreadable | no_file | error. Owns the backoff (waits of 15m, 1h, 6h, 24h; the read after the last wait that fails again is terminal failed:<code>); every other result is terminal at once; a terminal record reopens only when the document''s fingerprint changed. Requests (20261104130000): job_id may be NULL only for an email attachment named in context_document_text_requests whose email is on no job; its saved evidence row is doctext:no_job:<sha256> and carries no job. Refusal codes: document_text_invalid, _source_invalid, _fingerprint_invalid, _file_kind_invalid, _result_invalid, _code_invalid, _code_required, _sha256_invalid, _job_not_found, _source_not_found, _event_not_found.';

-- 8. The status block: the 20261005210000 body, a read on no job matched to its source.
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
  LEFT JOIN public.context_document_texts t ON t.source_kind=s.source_kind AND t.source_id=s.source_id AND t.job_id IS NOT DISTINCT FROM s.job_id
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

-- 9. Vision: documents due a vision read, as before; every requested document is left out.
CREATE OR REPLACE FUNCTION public.context_document_vision_due(p_limit integer DEFAULT 5)
RETURNS TABLE (source_kind text, source_id uuid, job_id uuid, job_number text, file_name text, doc_type text, content_type text,
 storage_bucket text, storage_path text, storage_url text, pdf_url text, fingerprint text, doc_at timestamptz,
 capture_mode text, attempts integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT s.source_kind, s.source_id, s.job_id, s.job_number, s.file_name, s.doc_type, s.content_type,
  s.storage_bucket, s.storage_path, s.storage_url, s.pdf_url, s.fingerprint, s.doc_at,
  CASE WHEN s.doc_at>=now()-make_interval(hours=>(public.context_document_vision_policy()->>'live_window_hours')::integer)
   THEN 'live' ELSE 'backfill' END,
  CASE WHEN v.outcome IN ('pending','leased') THEN v.attempts ELSE 0 END
 FROM public.context_document_text_sources() s
 JOIN public.context_document_texts t ON t.source_kind=s.source_kind AND t.source_id=s.source_id AND t.job_id IS NOT DISTINCT FROM s.job_id
  AND t.outcome='no_text_layer' AND t.file_kind IN ('pdf','image') AND t.source_fingerprint=s.fingerprint
 LEFT JOIN public.context_document_vision_reads v ON v.source_kind=s.source_kind AND v.source_id=s.source_id AND v.job_id IS NOT DISTINCT FROM s.job_id
 WHERE (v.id IS NULL
  OR (v.outcome='pending' AND v.next_at<=now())
  OR (v.outcome='leased' AND v.lease_until<=now())
  OR (v.outcome NOT IN ('pending','leased') AND v.source_fingerprint<>s.fingerprint))
  AND NOT EXISTS(SELECT 1 FROM public.context_document_text_requests q WHERE q.source_kind=s.source_kind AND q.source_id=s.source_id)
 ORDER BY s.doc_at DESC NULLS LAST, s.source_id
 LIMIT greatest(1,least(coalesce(p_limit,5),50))
$$;
COMMENT ON FUNCTION public.context_document_vision_due(integer) IS
 'Documents on live jobs that the text reader (B-5) recorded no_text_layer for their current bytes, due a vision read now (gap plan B-5b): never tried, pending with the next try due, a lapsed lease, or changed since a terminal outcome. Newest first. capture_mode is live for a document from the last 48 hours, else backfill. A document named in context_document_text_requests is never listed here: context_document_vision_requested_due lists it (20261104130000).';

-- 10. Vision: requested documents due a vision read.
CREATE OR REPLACE FUNCTION public.context_document_vision_requested_due(p_limit integer DEFAULT 5)
RETURNS TABLE (source_kind text, source_id uuid, job_id uuid, job_number text, file_name text, doc_type text, content_type text,
 storage_bucket text, storage_path text, storage_url text, pdf_url text, fingerprint text, doc_at timestamptz,
 capture_mode text, attempts integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT s.source_kind, s.source_id, s.job_id, s.job_number, s.file_name, s.doc_type, s.content_type,
  s.storage_bucket, s.storage_path, s.storage_url, s.pdf_url, s.fingerprint, s.doc_at,
  CASE WHEN s.job_id IS NOT NULL
    AND s.doc_at>=now()-make_interval(hours=>(public.context_document_vision_policy()->>'live_window_hours')::integer)
   THEN 'live' ELSE 'backfill' END,
  CASE WHEN v.outcome IN ('pending','leased') THEN v.attempts ELSE 0 END
 FROM public.context_document_text_sources() s
 JOIN public.context_document_text_requests q ON q.source_kind=s.source_kind AND q.source_id=s.source_id
 JOIN public.context_document_texts t ON t.source_kind=s.source_kind AND t.source_id=s.source_id AND t.job_id IS NOT DISTINCT FROM s.job_id
  AND t.outcome='no_text_layer' AND t.file_kind IN ('pdf','image') AND t.source_fingerprint=s.fingerprint
 LEFT JOIN public.context_document_vision_reads v ON v.source_kind=s.source_kind AND v.source_id=s.source_id AND v.job_id IS NOT DISTINCT FROM s.job_id
 WHERE v.id IS NULL
  OR (v.outcome='pending' AND v.next_at<=now())
  OR (v.outcome='leased' AND v.lease_until<=now())
  OR (v.outcome NOT IN ('pending','leased') AND v.source_fingerprint<>s.fingerprint)
 ORDER BY s.doc_at DESC NULLS LAST, s.source_id
 LIMIT greatest(1,least(coalesce(p_limit,5),50))
$$;
COMMENT ON FUNCTION public.context_document_vision_requested_due(integer) IS
 'Documents named in context_document_text_requests that the text reader recorded no_text_layer for their current bytes, due a vision read now (20261104130000), on their job or on no job (job_id NULL, capture_mode backfill). Newest first.';

-- 11. Vision claim: the 20261006001000 body, a read on no job.
CREATE OR REPLACE FUNCTION public.claim_context_document_vision(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_document_vision_policy();
 now_time timestamptz:=clock_timestamp();
 kind text; src uuid; job uuid; fp text; fk text; sha text; pages integer; images integer; cut boolean;
 r public.context_document_vision_reads; existed boolean; ev uuid; res jsonb;
 max_attempts integer:=jsonb_array_length(policy->'backoff_minutes')+1;
 job_key text;
BEGIN
 IF p IS NULL OR jsonb_typeof(p)<>'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('source_kind','source_id','job_id','fingerprint','file_kind',
   'sha256','page_count','image_count','images_cut'))
 THEN RAISE EXCEPTION 'document_vision_invalid'; END IF;
 kind:=p->>'source_kind'; fp:=p->>'fingerprint'; fk:=p->>'file_kind'; sha:=p->>'sha256';
 IF kind IS NULL OR kind NOT IN ('job_document','email_attachment') THEN RAISE EXCEPTION 'document_vision_source_invalid'; END IF;
 IF fp IS NULL OR fp !~ '^[0-9a-f]{32}$' THEN RAISE EXCEPTION 'document_vision_fingerprint_invalid'; END IF;
 IF fk IS NULL OR fk NOT IN ('pdf','image') THEN RAISE EXCEPTION 'document_vision_file_kind_invalid'; END IF;
 IF sha IS NULL OR sha !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'document_vision_sha256_invalid'; END IF;
 IF jsonb_typeof(p->'image_count') IS DISTINCT FROM 'number' OR (p->>'image_count')::numeric NOT BETWEEN 1 AND (policy->>'max_images')::integer
 THEN RAISE EXCEPTION 'document_vision_image_count_invalid'; END IF;
 images:=(p->>'image_count')::integer;
 IF p ? 'page_count' AND jsonb_typeof(p->'page_count')<>'null' THEN
  IF jsonb_typeof(p->'page_count')<>'number' OR (p->>'page_count')::numeric<0 THEN RAISE EXCEPTION 'document_vision_invalid'; END IF;
  pages:=(p->>'page_count')::integer;
 END IF;
 cut:=CASE WHEN jsonb_typeof(p->'images_cut')='boolean' THEN (p->>'images_cut')::boolean ELSE false END;
 BEGIN
  src:=(p->>'source_id')::uuid; job:=(p->>'job_id')::uuid;
 EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'document_vision_invalid';
 END;
 -- Requests (20261104130000): job NULL is a read on no job; the sources check below admits it only
 -- for a requested attachment whose email is on no job.
 IF src IS NULL THEN RAISE EXCEPTION 'document_vision_invalid'; END IF;
 job_key:=coalesce(job::text,public.context_document_text_policy()->>'no_job_key');

 IF NOT (public.context_document_vision_flag()->>'enabled')::boolean THEN
  RETURN jsonb_build_object('outcome','flag_off');
 END IF;
 -- One claimer per document at a time.
 PERFORM pg_advisory_xact_lock(20261006,hashtext(kind||':'||src::text||':'||job_key));
 -- Still a current no_text_layer document on a live job, or a requested one on no job.
 IF NOT EXISTS(SELECT 1 FROM public.context_document_text_sources() s
   JOIN public.context_document_texts t ON t.source_kind=s.source_kind AND t.source_id=s.source_id AND t.job_id IS NOT DISTINCT FROM s.job_id
   WHERE s.source_kind=kind AND s.source_id=src AND s.job_id IS NOT DISTINCT FROM job AND s.fingerprint=fp
    AND t.outcome='no_text_layer' AND t.file_kind IN ('pdf','image') AND t.source_fingerprint=fp)
 THEN RETURN jsonb_build_object('outcome','not_due','code','not_a_current_scan'); END IF;

 SELECT * INTO r FROM public.context_document_vision_reads v WHERE v.source_kind=kind AND v.source_id=src AND v.job_id IS NOT DISTINCT FROM job FOR UPDATE;
 existed:=FOUND;
 IF existed THEN
  IF r.outcome NOT IN ('pending','leased') AND r.source_fingerprint=fp THEN RETURN jsonb_build_object('outcome','not_due','code','finished'); END IF;
  IF r.outcome='pending' AND r.next_at>now_time THEN RETURN jsonb_build_object('outcome','not_due','code','waiting'); END IF;
  IF r.outcome='leased' AND r.lease_until>now_time THEN RETURN jsonb_build_object('outcome','not_due','code','leased'); END IF;
  IF r.outcome NOT IN ('pending','leased') OR r.source_fingerprint<>fp THEN
   -- The document changed: a fresh read.
   r.attempts:=0; r.failure_code:=NULL; r.event_id:=NULL; r.char_count:=NULL; r.truncated:=NULL; r.model:=NULL;
   r.confidence:=NULL; r.people_visible:=NULL; r.reservation_id:=NULL;
  END IF;
 ELSE
  r.id:=gen_random_uuid(); r.source_kind:=kind; r.source_id:=src; r.job_id:=job; r.attempts:=0; r.created_at:=now_time;
 END IF;
 r.source_fingerprint:=fp; r.file_kind:=fk; r.sha256:=sha; r.page_count:=pages; r.image_count:=images; r.images_cut:=cut;
 r.updated_at:=now_time; r.lease_until:=NULL; r.next_at:=NULL;

 -- The same bytes already carry their words on this job (or on no job): point at that row.
 SELECT e.id INTO ev FROM public.business_events e
 WHERE e.provider_message_id=(policy->>'key_prefix')||job_key||':'||sha AND e.job_id IS NOT DISTINCT FROM job LIMIT 1;
 IF ev IS NOT NULL THEN
  r.outcome:='saved'; r.event_id:=ev; r.last_code:='same_bytes_saved'; r.finished_at:=now_time; r.failure_code:=NULL; r.reservation_id:=NULL;
 ELSIF r.attempts>=max_attempts THEN
  -- The last lease lapsed with no answer.
  r.outcome:='failed'; r.failure_code:='lease_expired'; r.last_code:='lease_expired'; r.finished_at:=now_time; r.reservation_id:=NULL;
 ELSE
  res:=public.reserve_context_model_call('vision',NULL,NULL);
  IF res->>'outcome' IS DISTINCT FROM 'reserved' THEN
   RETURN jsonb_build_object('outcome',coalesce(res->>'outcome','error'));
  END IF;
  r.outcome:='leased'; r.attempts:=r.attempts+1; r.reservation_id:=(res->>'reservation_id')::uuid; r.last_code:='leased';
  r.lease_until:=now_time+make_interval(mins=>(policy->>'lease_minutes')::integer); r.finished_at:=NULL; r.failure_code:=NULL;
 END IF;

 IF existed THEN
  UPDATE public.context_document_vision_reads v SET source_fingerprint=r.source_fingerprint,file_kind=r.file_kind,outcome=r.outcome,
   attempts=r.attempts,next_at=r.next_at,lease_until=r.lease_until,reservation_id=r.reservation_id,last_code=r.last_code,
   failure_code=r.failure_code,sha256=r.sha256,page_count=r.page_count,image_count=r.image_count,images_cut=r.images_cut,
   char_count=r.char_count,truncated=r.truncated,model=r.model,confidence=r.confidence,people_visible=r.people_visible,
   event_id=r.event_id,updated_at=r.updated_at,finished_at=r.finished_at
  WHERE v.id=r.id;
 ELSE
  INSERT INTO public.context_document_vision_reads (id,source_kind,source_id,job_id,source_fingerprint,file_kind,outcome,attempts,next_at,
   lease_until,reservation_id,last_code,failure_code,sha256,page_count,image_count,images_cut,char_count,truncated,model,confidence,
   people_visible,event_id,created_at,updated_at,finished_at)
  VALUES (r.id,r.source_kind,r.source_id,r.job_id,r.source_fingerprint,r.file_kind,r.outcome,r.attempts,r.next_at,
   r.lease_until,r.reservation_id,r.last_code,r.failure_code,r.sha256,r.page_count,r.image_count,r.images_cut,r.char_count,r.truncated,
   r.model,r.confidence,r.people_visible,r.event_id,r.created_at,r.updated_at,r.finished_at);
 END IF;

 RETURN CASE r.outcome
  WHEN 'leased' THEN jsonb_build_object('outcome','claimed','reservation_id',r.reservation_id,'lease_until',r.lease_until,'attempts',r.attempts)
  WHEN 'saved' THEN jsonb_build_object('outcome','same_bytes_saved','event_id',r.event_id)
  ELSE jsonb_build_object('outcome','not_due','code',r.failure_code) END;
END $$;
COMMENT ON FUNCTION public.claim_context_document_vision(jsonb) IS
 'Gap plan B-5b: takes one due document for one vision call. Reserves the call through reserve_context_model_call(''vision'') and leases the document (lease_minutes). Outcomes: claimed (reservation_id, lease_until), same_bytes_saved (the bytes already carry words on this job, or on no job; no call), not_due (taken, waiting, changed, finished, or out of attempts), flag_off, and the reservation''s own refusals (paused, cap, vision_reserve, vision_budget). Requests (20261104130000): job_id NULL claims a requested attachment whose email is on no job. Refusal codes: document_vision_invalid, _source_invalid, _fingerprint_invalid, _file_kind_invalid, _sha256_invalid, _image_count_invalid.';

-- 12. Vision writer: the 20261006001000 body, a read on no job.
CREATE OR REPLACE FUNCTION public.record_context_document_vision(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_document_vision_policy();
 now_time timestamptz:=clock_timestamp();
 kind text; src uuid; job uuid; fp text; fk text; res text; code text; sha text; ev uuid; resv uuid; mdl text; conf numeric;
 r public.context_document_vision_reads; existed boolean; reopened boolean:=false;
 max_attempts integer:=jsonb_array_length(policy->'backoff_minutes')+1;
 job_key text;
BEGIN
 IF p IS NULL OR jsonb_typeof(p)<>'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('source_kind','source_id','job_id','fingerprint','file_kind',
   'result','code','reservation_id','sha256','event_id','model','confidence','char_count','page_count','image_count','truncated','people_visible'))
 THEN RAISE EXCEPTION 'document_vision_invalid'; END IF;
 kind:=p->>'source_kind'; fp:=p->>'fingerprint'; fk:=p->>'file_kind'; res:=p->>'result'; code:=nullif(p->>'code',''); sha:=nullif(p->>'sha256','');
 mdl:=nullif(p->>'model','');
 IF kind IS NULL OR kind NOT IN ('job_document','email_attachment') THEN RAISE EXCEPTION 'document_vision_source_invalid'; END IF;
 IF fp IS NULL OR fp !~ '^[0-9a-f]{32}$' THEN RAISE EXCEPTION 'document_vision_fingerprint_invalid'; END IF;
 IF fk IS NULL OR fk NOT IN ('pdf','image') THEN RAISE EXCEPTION 'document_vision_file_kind_invalid'; END IF;
 IF res IS NULL OR res NOT IN ('saved','no_text','low_confidence','too_large','not_supported','no_file','error')
 THEN RAISE EXCEPTION 'document_vision_result_invalid'; END IF;
 IF code IS NOT NULL AND code !~ '^[a-z0-9][a-z0-9_.:-]{0,79}$' THEN RAISE EXCEPTION 'document_vision_code_invalid'; END IF;
 IF res='error' AND code IS NULL THEN RAISE EXCEPTION 'document_vision_code_required'; END IF;
 IF sha IS NOT NULL AND sha !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'document_vision_sha256_invalid'; END IF;
 IF mdl IS NOT NULL AND mdl !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' THEN RAISE EXCEPTION 'document_vision_model_invalid'; END IF;
 IF p ? 'confidence' AND jsonb_typeof(p->'confidence')<>'null' THEN
  IF jsonb_typeof(p->'confidence')<>'number' OR (p->>'confidence')::numeric NOT BETWEEN 0 AND 1 THEN RAISE EXCEPTION 'document_vision_confidence_invalid'; END IF;
  conf:=round((p->>'confidence')::numeric,3);
 END IF;
 BEGIN
  src:=(p->>'source_id')::uuid; job:=(p->>'job_id')::uuid; ev:=(p->>'event_id')::uuid; resv:=(p->>'reservation_id')::uuid;
 EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'document_vision_invalid';
 END;
 IF src IS NULL THEN RAISE EXCEPTION 'document_vision_invalid'; END IF;
 job_key:=coalesce(job::text,public.context_document_text_policy()->>'no_job_key');
 -- Only documents the text reader handed over (a scan or a photo of this job, or one on no job).
 IF NOT EXISTS(SELECT 1 FROM public.context_document_texts t WHERE t.source_kind=kind AND t.source_id=src AND t.job_id IS NOT DISTINCT FROM job) THEN
  RAISE EXCEPTION 'document_vision_source_not_found';
 END IF;
 IF res='saved' THEN
  IF sha IS NULL OR ev IS NULL THEN RAISE EXCEPTION 'document_vision_invalid'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.business_events e WHERE e.id=ev AND e.job_id IS NOT DISTINCT FROM job
    AND e.provider_message_id=(policy->>'key_prefix')||job_key||':'||sha) THEN
   RAISE EXCEPTION 'document_vision_event_not_found';
  END IF;
 END IF;

 PERFORM pg_advisory_xact_lock(20261006,hashtext(kind||':'||src::text||':'||job_key));
 SELECT * INTO r FROM public.context_document_vision_reads v WHERE v.source_kind=kind AND v.source_id=src AND v.job_id IS NOT DISTINCT FROM job FOR UPDATE;
 existed:=FOUND;
 IF resv IS NOT NULL THEN
  -- An answer: the reservation must still hold the lease.
  IF NOT existed OR r.outcome<>'leased' OR r.reservation_id IS DISTINCT FROM resv THEN
   RAISE EXCEPTION 'document_vision_lease_lost';
  END IF;
  IF sha IS DISTINCT FROM r.sha256 THEN RAISE EXCEPTION 'document_vision_sha256_mismatch'; END IF;
 ELSE
  IF existed AND r.outcome='leased' AND r.lease_until>now_time THEN RAISE EXCEPTION 'document_vision_leased'; END IF;
  IF existed AND r.outcome NOT IN ('pending','leased') THEN
   IF r.source_fingerprint=fp THEN
    RETURN jsonb_build_object('outcome','unchanged','state',r.outcome,'attempts',r.attempts);
   END IF;
   reopened:=true;
   r.attempts:=0; r.failure_code:=NULL; r.event_id:=NULL; r.char_count:=NULL; r.truncated:=NULL; r.model:=NULL;
   r.confidence:=NULL; r.people_visible:=NULL; r.reservation_id:=NULL; r.image_count:=NULL; r.images_cut:=NULL;
  END IF;
 END IF;
 IF NOT existed THEN
  r.id:=gen_random_uuid(); r.source_kind:=kind; r.source_id:=src; r.job_id:=job; r.attempts:=0; r.created_at:=now_time;
 END IF;
 r.source_fingerprint:=fp; r.file_kind:=fk; r.updated_at:=now_time; r.last_code:=coalesce(code,res); r.lease_until:=NULL;
 IF sha IS NOT NULL THEN r.sha256:=sha; END IF;
 IF mdl IS NOT NULL THEN r.model:=mdl; END IF;
 IF conf IS NOT NULL THEN r.confidence:=conf; END IF;
 IF jsonb_typeof(p->'people_visible')='boolean' THEN r.people_visible:=(p->>'people_visible')::boolean; END IF;
 IF jsonb_typeof(p->'page_count')='number' AND (p->>'page_count')::numeric>=0 THEN r.page_count:=(p->>'page_count')::integer; END IF;
 IF jsonb_typeof(p->'char_count')='number' AND (p->>'char_count')::numeric>=0 THEN r.char_count:=(p->>'char_count')::integer; END IF;
 IF jsonb_typeof(p->'truncated')='boolean' THEN r.truncated:=(p->>'truncated')::boolean; END IF;

 IF res='error' THEN
  -- The claim already counted an answered attempt; a failure before any claim counts here.
  IF resv IS NULL THEN r.attempts:=r.attempts+1; END IF;
  -- The model route's own trouble (login, rate limit) is not the document's.
  IF resv IS NOT NULL AND code LIKE 'model_route_%' THEN r.attempts:=greatest(r.attempts-1,0); END IF;
  r.reservation_id:=NULL;
  IF r.attempts>=max_attempts THEN
   r.outcome:='failed'; r.failure_code:=code; r.next_at:=NULL; r.finished_at:=now_time;
  ELSE
   r.outcome:='pending'; r.finished_at:=NULL; r.failure_code:=NULL;
   r.next_at:=now_time+public.context_document_vision_backoff(greatest(r.attempts,1));
  END IF;
 ELSE
  IF resv IS NULL THEN r.attempts:=r.attempts+1; END IF;
  r.outcome:=res; r.next_at:=NULL; r.finished_at:=now_time; r.failure_code:=NULL; r.reservation_id:=CASE WHEN resv IS NOT NULL THEN resv END;
  r.event_id:=CASE WHEN res='saved' THEN ev END;
 END IF;

 IF existed THEN
  UPDATE public.context_document_vision_reads v SET source_fingerprint=r.source_fingerprint,file_kind=r.file_kind,outcome=r.outcome,
   attempts=r.attempts,next_at=r.next_at,lease_until=r.lease_until,reservation_id=r.reservation_id,last_code=r.last_code,
   failure_code=r.failure_code,sha256=r.sha256,page_count=r.page_count,image_count=r.image_count,images_cut=r.images_cut,
   char_count=r.char_count,truncated=r.truncated,model=r.model,confidence=r.confidence,people_visible=r.people_visible,
   event_id=r.event_id,updated_at=r.updated_at,finished_at=r.finished_at
  WHERE v.id=r.id;
 ELSE
  INSERT INTO public.context_document_vision_reads (id,source_kind,source_id,job_id,source_fingerprint,file_kind,outcome,attempts,next_at,
   lease_until,reservation_id,last_code,failure_code,sha256,page_count,image_count,images_cut,char_count,truncated,model,confidence,
   people_visible,event_id,created_at,updated_at,finished_at)
  VALUES (r.id,r.source_kind,r.source_id,r.job_id,r.source_fingerprint,r.file_kind,r.outcome,r.attempts,r.next_at,
   r.lease_until,r.reservation_id,r.last_code,r.failure_code,r.sha256,r.page_count,r.image_count,r.images_cut,r.char_count,r.truncated,
   r.model,r.confidence,r.people_visible,r.event_id,r.created_at,r.updated_at,r.finished_at);
 END IF;

 RETURN jsonb_build_object('outcome',CASE WHEN r.outcome='failed' THEN 'failed:'||r.failure_code ELSE r.outcome END,
  'state',r.outcome,'attempts',r.attempts,'next_at',r.next_at,'reopened',reopened);
END $$;
COMMENT ON FUNCTION public.record_context_document_vision(jsonb) IS
 'The writer of context_document_vision_reads for every outcome but the claim (gap plan B-5b). result: saved | no_text | low_confidence | too_large | not_supported | no_file | error. An answer names the reservation that holds the lease (else document_vision_lease_lost). Errors wait 1 h, 6 h, 24 h; the attempt after the last wait that fails again is terminal failed:<code>; a model_route_* error does not count against the document. A terminal record reopens only when the document''s fingerprint changed. Requests (20261104130000): job_id NULL writes the record of a requested attachment read on no job; its saved evidence row is doctext:no_job:<sha256> on no job. Refusal codes: document_vision_invalid, _source_invalid, _fingerprint_invalid, _file_kind_invalid, _result_invalid, _code_invalid, _code_required, _sha256_invalid, _sha256_mismatch, _model_invalid, _confidence_invalid, _source_not_found, _event_not_found, _lease_lost, _leased.';

-- 13. The leased document, for the answer: the 20261006001000 body, a read on no job.
CREATE OR REPLACE FUNCTION public.context_document_vision_leased(p_reservation_id uuid)
RETURNS TABLE (source_kind text, source_id uuid, job_id uuid, fingerprint text, file_kind text, sha256 text, page_count integer,
 image_count integer, images_cut boolean, doc_type text, file_name text, content_type text, doc_at timestamptz,
 capture_mode text, lease_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT v.source_kind, v.source_id, v.job_id, v.source_fingerprint, v.file_kind, v.sha256, v.page_count,
  coalesce(v.image_count,0), coalesce(v.images_cut,false), s.doc_type, s.file_name, s.content_type, s.doc_at,
  CASE WHEN v.job_id IS NOT NULL
    AND s.doc_at>=now()-make_interval(hours=>(public.context_document_vision_policy()->>'live_window_hours')::integer)
   THEN 'live' ELSE 'backfill' END,
  v.lease_until
 FROM public.context_document_vision_reads v
 LEFT JOIN LATERAL (SELECT x.doc_type, x.file_name, x.content_type, x.doc_at FROM public.context_document_text_sources() x
  WHERE x.source_kind=v.source_kind AND x.source_id=v.source_id AND x.job_id IS NOT DISTINCT FROM v.job_id LIMIT 1) s ON true
 WHERE p_reservation_id IS NOT NULL AND v.reservation_id=p_reservation_id AND v.outcome='leased'
$$;

-- 14. Vision status: the 20261006001000 body, a read on no job matched to its source.
CREATE OR REPLACE FUNCTION public.context_document_vision_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_document_vision_policy();
 now_time timestamptz:=now();
 flag jsonb:=public.context_document_vision_flag();
 lanes_on boolean:=public.automation_lane_enabled('capture') AND public.automation_lane_enabled('extraction');
 gate jsonb:=public.context_document_vision_admission();
 docs jsonb; due integer; last_claim timestamptz; touched_24h bigint; errors_24h bigint; alarms jsonb:='[]'::jsonb; since timestamptz;
BEGIN
 WITH c AS (
  SELECT s.source_kind, s.source_id, s.job_id, s.fingerprint, t.file_kind,
   v.outcome, v.next_at, v.lease_until, v.source_fingerprint AS v_fp
  FROM public.context_document_text_sources() s
  JOIN public.context_document_texts t ON t.source_kind=s.source_kind AND t.source_id=s.source_id AND t.job_id IS NOT DISTINCT FROM s.job_id
   AND t.outcome='no_text_layer' AND t.file_kind IN ('pdf','image') AND t.source_fingerprint=s.fingerprint
  LEFT JOIN public.context_document_vision_reads v ON v.source_kind=s.source_kind AND v.source_id=s.source_id AND v.job_id IS NOT DISTINCT FROM s.job_id
 )
 SELECT jsonb_build_object(
  'waiting_for_vision',count(*),
  'jobs',count(DISTINCT c.job_id),
  'pdf',count(*) FILTER (WHERE c.file_kind='pdf'),
  'image',count(*) FILTER (WHERE c.file_kind='image'),
  'with_text',count(*) FILTER (WHERE c.outcome='saved' AND c.v_fp=c.fingerprint),
  'no_text',count(*) FILTER (WHERE c.outcome='no_text' AND c.v_fp=c.fingerprint),
  'low_confidence',count(*) FILTER (WHERE c.outcome='low_confidence' AND c.v_fp=c.fingerprint),
  'too_large',count(*) FILTER (WHERE c.outcome='too_large' AND c.v_fp=c.fingerprint),
  'not_supported',count(*) FILTER (WHERE c.outcome='not_supported' AND c.v_fp=c.fingerprint),
  'no_file',count(*) FILTER (WHERE c.outcome='no_file' AND c.v_fp=c.fingerprint),
  'failed',count(*) FILTER (WHERE c.outcome='failed' AND c.v_fp=c.fingerprint),
  'pending',count(*) FILTER (WHERE c.outcome='pending'),
  'leased',count(*) FILTER (WHERE c.outcome='leased'),
  'never_tried',count(*) FILTER (WHERE c.outcome IS NULL),
  'changed_since_read',count(*) FILTER (WHERE c.outcome IS NOT NULL AND c.outcome NOT IN ('pending','leased') AND c.v_fp<>c.fingerprint)),
  count(*) FILTER (WHERE c.outcome IS NULL OR (c.outcome='pending' AND c.next_at<=now_time) OR (c.outcome='leased' AND c.lease_until<=now_time)
   OR (c.outcome NOT IN ('pending','leased') AND c.v_fp<>c.fingerprint))::integer
 INTO docs,due FROM c;

 SELECT max(r.reserved_at) INTO last_claim FROM public.context_model_call_reservations r WHERE r.phase='vision';
 SELECT count(*), count(*) FILTER (WHERE v.outcome='failed' OR (v.outcome='pending' AND v.attempts>0))
 INTO touched_24h, errors_24h FROM public.context_document_vision_reads v WHERE v.updated_at>now_time-interval '24 hours';

 IF lanes_on AND (flag->>'enabled')::boolean THEN
  since:=coalesce(last_claim,(flag->>'updated_at')::timestamptz);
  IF due>0 AND (gate->>'open')::boolean AND since IS NOT NULL AND now_time-since>make_interval(hours=>(policy->>'stale_hours')::integer) THEN
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','document_vision_stale','severity','warning','since',since,'due',due,
    'what_to_do','Scanned documents and photos are waiting for a vision read and the budget is open, but no vision call was taken for 6 hours. Check the Luna context worker''s vision loop and the context-document-vision edge function logs.'));
  END IF;
  IF touched_24h>=(policy->>'failing_min_attempts')::integer AND errors_24h>(policy->>'failing_error_ratio')::numeric*touched_24h THEN
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','document_vision_failing','severity','warning','since',now_time-interval '24 hours',
    'touched_24h',touched_24h,'errors_24h',errors_24h,
    'what_to_do','More than 3 in 10 vision reads in 24 hours ended in an error. Check last_code in context_document_vision_reads and the worker''s model login.'));
  END IF;
 END IF;

 RETURN jsonb_build_object('as_of',now_time,'policy',policy,'flag',flag,'lanes_on',lanes_on,'admission',gate,
  'documents',docs,'due_now',coalesce(due,0),'last_vision_call_at',last_claim,'alarms',alarms);
END $$;

-- 15. Grants. Service-side only.
REVOKE ALL ON FUNCTION public.context_document_text_policy(),public.context_document_text_sources(),
 public.context_document_text_due(integer),public.context_document_text_requested_due(integer),
 public.record_context_document_text(jsonb),public.context_document_text_status(),
 public.context_document_vision_due(integer),public.context_document_vision_requested_due(integer),
 public.claim_context_document_vision(jsonb),public.record_context_document_vision(jsonb),
 public.context_document_vision_leased(uuid),public.context_document_vision_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_document_text_policy(),public.context_document_text_sources(),
 public.context_document_text_due(integer),public.context_document_text_requested_due(integer),
 public.record_context_document_text(jsonb),public.context_document_text_status(),
 public.context_document_vision_due(integer),public.context_document_vision_requested_due(integer),
 public.claim_context_document_vision(jsonb),public.record_context_document_vision(jsonb),
 public.context_document_vision_leased(uuid),public.context_document_vision_status() TO service_role;
