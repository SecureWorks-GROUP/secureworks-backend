-- B-5b (context gap plan, done-definition row 5 "Documents"): the database half
-- of the vision reader. The edge function context-document-vision is the door;
-- the model call happens in the Luna context worker (secureworks-jarvis), on
-- the model route and login the job context reader already uses. No key, no
-- provider account and no model call is added here.
--
-- The document text reader (B-5, 20261005210000) records a scan or a photo as
-- no_text_layer. This reader gets the words out of those, through a vision
-- model, as the same kind of evidence row B-5 writes: one
-- document.text_extracted row per document per job, keyed
-- doctext:<job>:<sha-256 of the bytes>, on the document's own job, marked
-- vision-extracted with the model and its confidence.
--
-- What it does:
--  1. context_document_vision_policy(): every threshold, in one place.
--  2. context_document_vision_flag(): feature_flags.context_document_vision_v1.
--     Missing or unreadable reads as off (fail closed). No flag row is created.
--  3. context_document_vision_settings: one optional row holding the desk's
--     daily cap. No row means the policy default (100 documents a day); the
--     cap can never exceed the policy maximum (300).
--  4. The model call budget: context_model_call_reservations admits the new
--     phase 'vision', and reserve_context_model_call (the one admission every
--     model call goes through) admits a vision call only while
--       * the capture AND extraction lanes are on,
--       * the day's shared 400-call cap is not reached,
--       * fewer than 200 of the day's calls are used (the other 200 stay for
--         the job reads, so vision can never starve them), and
--       * today's vision calls are under the daily cap.
--     Every other phase behaves exactly as before.
--  5. context_document_vision_reads: one record per document per job the
--     vision reader has handled (outcome, attempts, lease, the reservation,
--     content hash, pages and pictures sent, model, confidence, whether people
--     were visible, the evidence row). Never words, never pictures. RLS on with
--     no policy; service_role may only read it.
--  6. context_document_vision_due(limit): documents B-5 recorded no_text_layer
--     (pdf or image, current bytes) on live jobs that are due a vision read:
--     never tried, pending and due, a lapsed lease, or changed since a
--     terminal outcome. Newest first.
--  7. claim_context_document_vision(jsonb): takes one due document for one
--     model call: reserves the call through reserve_context_model_call and
--     leases the document (30 minutes). Bytes already saved as words on this
--     job are pointed at instead, with no call. A document out of attempts is
--     closed failed.
--  8. record_context_document_vision(jsonb): the table's one writer for every
--     other outcome. An answer must carry the reservation that holds the
--     lease. Errors wait 1 h, 6 h, 24 h; the attempt after the last wait that
--     fails again is terminal failed:<code>. An error that belongs to the
--     model route (code model_route_*) does not count against the document.
--  9. context_document_vision_leased(reservation): the leased document, for
--     the answer.
-- 10. context_document_vision_admission(): read only, whether a vision call
--     would be admitted now, and why not.
-- 11. context_document_vision_status(): the scorecard: documents waiting for
--     vision and each outcome, calls today against the cap, and the alarms
--     document_vision_stale and document_vision_failing (raised only while the
--     flag and both lanes are on). Counts and codes only.
--
-- No flag or switch is turned on, no business_events row is written, no cron
-- job is scheduled (the worker asks), and no grant, policy or view is added
-- for anon or authenticated. Every new or re-created function: fixed
-- search_path, EXECUTE revoked from PUBLIC, anon, authenticated.
--
-- Replaces one function: reserve_context_model_call(text,uuid,uuid) (the A1
-- body of 20260924060000, md5 86bfd48365b6aa26c4400ec2b5d476c3, plus the
-- vision phase), and one constraint: the phase CHECK of
-- context_model_call_reservations (plus 'vision').
-- Reads, never replaces: context_document_text_sources() and the table
-- context_document_texts (B-5), automation_lane_enabled(text),
-- capture_business_event(jsonb) and context_catchup_list_backfill (called by
-- the edge function). The guard refuses unless each is still that pre-image
-- or already this migration's result (a re-apply).
--
-- Rollback: supabase/rollbacks/20261006001000_context_document_vision_down.sql
-- (restores the A1 reservation body and the three-phase CHECK after deleting
-- any vision reservation rows, drops the new functions and tables). Evidence
-- rows already saved stay in business_events.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; cols text; chk text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.reserve_context_model_call(text,uuid,uuid)',ARRAY['86bfd48365b6aa26c4400ec2b5d476c3','f50de57b906f28fc9b5b286821d64cb1']),
  ('public.context_document_text_sources()',ARRAY['3a8554d41d1b10718599c55d65e56110']),
  ('public.capture_business_event(jsonb)',ARRAY['4819869e6dcc40d5cd19a7eba295392c']),
  ('public.automation_lane_enabled(text)',ARRAY['818a13be854748e2d272bdd648c88b59'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF to_regprocedure('public.context_catchup_list_backfill(text,timestamptz,boolean,integer,integer)') IS NULL
 THEN problems:=problems||'public.context_catchup_list_backfill missing (apply 20261005180000 first)'::text; END IF;
 -- The B-5 read records, exactly as 20261005210000 made them.
 IF to_regclass('public.context_document_texts') IS NULL THEN
  problems:=problems||'context_document_texts missing (apply 20261005210000 first)'::text;
 ELSE
  SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid='public.context_document_texts'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM 'id:uuid,source_kind:text,source_id:uuid,job_id:uuid,source_fingerprint:text,file_kind:text,outcome:text,attempts:integer,next_at:timestamp with time zone,last_code:text,failure_code:text,sha256:text,page_count:integer,char_count:integer,truncated:boolean,event_id:uuid,created_at:timestamp with time zone,updated_at:timestamp with time zone,finished_at:timestamp with time zone'
  THEN problems:=problems||format('context_document_texts has columns %s',cols); END IF;
 END IF;
 -- The reservation ledger and its phase check: three phases, or already four.
 IF to_regclass('public.context_model_call_reservations') IS NULL THEN
  problems:=problems||'context_model_call_reservations missing'::text;
 ELSE
  SELECT string_agg(pg_get_constraintdef(c.oid),' | ') INTO chk FROM pg_constraint c
  WHERE c.conrelid='public.context_model_call_reservations'::regclass AND c.contype='c' AND pg_get_constraintdef(c.oid) LIKE '%phase%'
   AND pg_get_constraintdef(c.oid) NOT LIKE '%extraction%run_id%' AND pg_get_constraintdef(c.oid) NOT LIKE '%run_id%extraction%';
  IF chk IS DISTINCT FROM $c$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text])))$c$
   AND chk IS DISTINCT FROM $c$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text])))$c$
  THEN problems:=problems||format('context_model_call_reservations phase check is %s',coalesce(chk,'<missing>')); END IF;
 END IF;
 IF to_regclass('public.context_document_vision_reads') IS NOT NULL THEN
  SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid='public.context_document_vision_reads'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM 'id:uuid,source_kind:text,source_id:uuid,job_id:uuid,source_fingerprint:text,file_kind:text,outcome:text,attempts:integer,next_at:timestamp with time zone,lease_until:timestamp with time zone,reservation_id:uuid,last_code:text,failure_code:text,sha256:text,page_count:integer,image_count:integer,images_cut:boolean,char_count:integer,truncated:boolean,model:text,confidence:numeric(4,3),people_visible:boolean,event_id:uuid,created_at:timestamp with time zone,updated_at:timestamp with time zone,finished_at:timestamp with time zone'
  THEN problems:=problems||format('context_document_vision_reads exists with columns %s',cols); END IF;
 END IF;
 IF to_regclass('public.feature_flags') IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='context_document_vision_v1')
  AND to_regclass('public.context_document_vision_reads') IS NULL
 THEN problems:=problems||'feature flag context_document_vision_v1 already exists before the first apply'::text; END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_document_vision_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. Thresholds.
CREATE OR REPLACE FUNCTION public.context_document_vision_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'flag','context_document_vision_v1',
  'phase','vision',
  'event_source','context-document-vision',
  -- The same kind of evidence row, in the same dedupe space, as B-5.
  'event_type','document.text_extracted',
  'key_prefix','doctext:',
  -- Documents looked at per "next" call before one is handed out.
  'batch_limit',5,
  -- Documents read per Perth day: the default, and the most the desk may set.
  'daily_cap_default',100,
  'daily_cap_max',300,
  -- A vision call is admitted only while fewer than this many of the day's
  -- 400 shared model calls are used; the rest stay for the job reads.
  'shared_calls_ceiling',200,
  -- What one call may carry: a photo up to 5 MB; a scanned PDF up to 5 MB,
  -- of which at most 5 page images (each at least 300 px on its short side).
  'max_image_bytes',5000000,
  'max_pdf_bytes',5000000,
  'max_images',5,
  'min_image_side',300,
  -- The words kept: at most 40,000 characters, at least 3, and only when the
  -- model is at least 0.5 confident.
  'max_chars',40000,
  'min_chars',3,
  'min_confidence',0.5,
  -- A claimed document is the worker's for 30 minutes.
  'lease_minutes',30,
  -- Waits after an error; the attempt after the last wait that fails again is terminal.
  'backoff_minutes',jsonb_build_array(60,360,1440),
  -- A document from the last 48 hours wakes a read; an older one is history.
  'live_window_hours',48,
  'catchup_priority',2,
  -- Alarms.
  'stale_hours',6,
  'failing_min_attempts',5,
  'failing_error_ratio',0.3)
$$;

-- 2. The flag. Fails closed: no table, no row, or an error is off.
CREATE OR REPLACE FUNCTION public.context_document_vision_flag() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE on_flag boolean; changed timestamptz;
BEGIN
 IF to_regclass('public.feature_flags') IS NULL THEN RETURN jsonb_build_object('enabled',false,'updated_at',NULL,'state','missing'); END IF;
 EXECUTE 'SELECT f.enabled,f.updated_at FROM public.feature_flags f WHERE f.flag_name=$1 ORDER BY f.updated_at DESC NULLS LAST LIMIT 1'
  INTO on_flag,changed USING 'context_document_vision_v1';
 RETURN jsonb_build_object('enabled',coalesce(on_flag,false),'updated_at',changed,'state',CASE WHEN on_flag IS NULL THEN 'missing' ELSE 'present' END);
EXCEPTION WHEN OTHERS THEN
 RETURN jsonb_build_object('enabled',false,'updated_at',NULL,'state','unreadable');
END $$;
COMMENT ON FUNCTION public.context_document_vision_flag() IS
 'feature_flags.context_document_vision_v1 as {enabled, updated_at, state}. Missing or unreadable reads as off. Owned by gap plan B-5b (document vision).';

-- 3. The desk's daily cap.
CREATE TABLE IF NOT EXISTS public.context_document_vision_settings (
 id integer PRIMARY KEY CHECK (id=1),
 daily_cap integer NOT NULL CHECK (daily_cap BETWEEN 0 AND 300),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by text NOT NULL CHECK (btrim(updated_by)<>''),
 note text
);
ALTER TABLE public.context_document_vision_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_document_vision_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.context_document_vision_settings TO service_role;
COMMENT ON TABLE public.context_document_vision_settings IS
 'At most one row (id 1): the vision reader''s documents per Perth day, 0 to 300. No row means the policy default (100). Set by the desk: INSERT ... ON CONFLICT (id) DO UPDATE with updated_by and a note; 0 stops vision calls without touching the flag.';

CREATE OR REPLACE FUNCTION public.context_document_vision_daily_cap() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT least((public.context_document_vision_policy()->>'daily_cap_max')::integer,
  coalesce((SELECT s.daily_cap FROM public.context_document_vision_settings s WHERE s.id=1),
   (public.context_document_vision_policy()->>'daily_cap_default')::integer))
$$;

-- 4. The shared model call budget admits the vision phase.
DO $chk$
DECLARE c record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint
  WHERE conrelid='public.context_model_call_reservations'::regclass AND contype='c'
   AND pg_get_constraintdef(oid)=$d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text])))$d$ LOOP
  EXECUTE format('ALTER TABLE public.context_model_call_reservations DROP CONSTRAINT %I',c.conname);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.context_model_call_reservations'::regclass AND contype='c'
   AND pg_get_constraintdef(oid)=$d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text])))$d$) THEN
  ALTER TABLE public.context_model_call_reservations ADD CONSTRAINT context_model_call_reservations_phase_check
   CHECK (phase IN ('attribution','extraction','bucket','vision'));
 END IF;
END $chk$;

-- The A1 body with the vision phase: its lanes, its ceiling and its daily cap.
-- Every other phase takes exactly the A1 path.
CREATE OR REPLACE FUNCTION public.reserve_context_model_call(p_phase text,p_run_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_now timestamptz; v_date date; v_ordinal integer; v_id uuid; r public.context_extraction_runs;
BEGIN
 IF p_phase IS NULL OR p_phase NOT IN ('attribution','extraction','bucket','vision')
 OR (p_run_id IS NULL) <> (p_lease_token IS NULL)
 OR (p_phase='extraction' AND p_run_id IS NULL)
 OR (p_phase='vision' AND p_run_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Invalid model call identity';
 END IF;
 PERFORM pg_advisory_xact_lock(20260911,1);
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase IN ('extraction','vision') THEN 'extraction' ELSE 'attribution' END)
 OR (p_phase='vision' AND NOT public.automation_lane_enabled('capture'))
 THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 PERFORM 1 FROM public.automation_switches WHERE id=1 FOR SHARE;
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase IN ('extraction','vision') THEN 'extraction' ELSE 'attribution' END)
 OR (p_phase='vision' AND NOT public.automation_lane_enabled('capture'))
 THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 IF p_run_id IS NOT NULL THEN
  SELECT * INTO r FROM public.context_extraction_runs WHERE id=p_run_id FOR UPDATE;
 END IF;
 v_now := clock_timestamp();
 v_date := (v_now AT TIME ZONE 'Australia/Perth')::date;
 IF p_run_id IS NOT NULL AND (r.id IS NULL OR r.lease_token IS DISTINCT FROM p_lease_token
 OR r.phase IS DISTINCT FROM p_phase OR r.status <> 'running'
 OR r.lease_expires_at IS NULL OR r.lease_expires_at <= v_now OR r.run_date <> v_date)
 THEN RETURN jsonb_build_object('outcome','stale'); END IF;
 SELECT coalesce(max(ordinal),0)+1 INTO v_ordinal FROM public.context_model_call_reservations WHERE run_date=v_date;
 IF v_ordinal>400 THEN RETURN jsonb_build_object('outcome','cap'); END IF;
 -- A1: attribution may use at most 60 of the day's 400 calls.
 IF p_phase='attribution' AND (SELECT count(*) FROM public.context_model_call_reservations
   WHERE run_date=v_date AND phase='attribution')>=60
 THEN RETURN jsonb_build_object('outcome','attribution_budget','run_date',v_date,'limit',60); END IF;
 -- B-5b: vision only while the job reads keep their share, and within its own daily cap.
 IF p_phase='vision' THEN
  IF v_ordinal>(public.context_document_vision_policy()->>'shared_calls_ceiling')::integer
  THEN RETURN jsonb_build_object('outcome','vision_reserve','run_date',v_date,
   'ceiling',(public.context_document_vision_policy()->>'shared_calls_ceiling')::integer); END IF;
  IF (SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=v_date AND phase='vision')
   >=public.context_document_vision_daily_cap()
  THEN RETURN jsonb_build_object('outcome','vision_budget','run_date',v_date,'limit',public.context_document_vision_daily_cap()); END IF;
 END IF;
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,run_id,lease_token,reserved_at)
 VALUES(v_date,v_ordinal,p_phase,p_run_id,p_lease_token,v_now) RETURNING id INTO v_id;
 RETURN jsonb_build_object('outcome','reserved','reservation_id',v_id,'run_date',v_date,'ordinal',v_ordinal);
END $$;

-- 5. The read records.
CREATE TABLE IF NOT EXISTS public.context_document_vision_reads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_kind text NOT NULL CHECK (source_kind IN ('job_document','email_attachment')),
 source_id uuid NOT NULL,
 job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
 source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{32}$'),
 file_kind text NOT NULL CHECK (file_kind IN ('pdf','image')),
 outcome text NOT NULL CHECK (outcome IN ('pending','leased','saved','no_text','low_confidence','too_large','not_supported','no_file','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
 next_at timestamptz,
 lease_until timestamptz,
 reservation_id uuid,
 last_code text CHECK (last_code IS NULL OR last_code ~ '^[a-z0-9][a-z0-9_.:-]{0,79}$'),
 failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9][a-z0-9_.:-]{0,79}$'),
 sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
 page_count integer CHECK (page_count IS NULL OR page_count>=0),
 image_count integer CHECK (image_count IS NULL OR image_count BETWEEN 0 AND 50),
 images_cut boolean,
 char_count integer CHECK (char_count IS NULL OR char_count>=0),
 truncated boolean,
 model text CHECK (model IS NULL OR model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
 confidence numeric(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
 people_visible boolean,
 event_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 CONSTRAINT context_document_vision_reads_one UNIQUE (source_kind,source_id,job_id),
 CONSTRAINT context_document_vision_reads_terminal CHECK ((outcome IN ('pending','leased'))=(finished_at IS NULL)),
 CONSTRAINT context_document_vision_reads_pending_next CHECK (outcome<>'pending' OR next_at IS NOT NULL),
 CONSTRAINT context_document_vision_reads_lease CHECK (outcome<>'leased' OR (lease_until IS NOT NULL AND reservation_id IS NOT NULL AND sha256 IS NOT NULL)),
 CONSTRAINT context_document_vision_reads_failed_code CHECK ((outcome='failed')=(failure_code IS NOT NULL)),
 CONSTRAINT context_document_vision_reads_saved_event CHECK (outcome<>'saved' OR (event_id IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS context_document_vision_reads_reservation ON public.context_document_vision_reads (reservation_id) WHERE reservation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS context_document_vision_reads_job ON public.context_document_vision_reads (job_id);
ALTER TABLE public.context_document_vision_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_document_vision_reads FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.context_document_vision_reads TO service_role;
COMMENT ON TABLE public.context_document_vision_reads IS
 'One record per document per job the vision reader has handled (gap plan B-5b): outcome, attempts, lease and model call reservation, content hash, pages and pictures sent, model, confidence, whether people were visible, the evidence row. Written only by claim_context_document_vision() and record_context_document_vision(). Never words, never pictures.';

-- 6. Documents due a vision read now.
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
 JOIN public.context_document_texts t ON t.source_kind=s.source_kind AND t.source_id=s.source_id AND t.job_id=s.job_id
  AND t.outcome='no_text_layer' AND t.file_kind IN ('pdf','image') AND t.source_fingerprint=s.fingerprint
 LEFT JOIN public.context_document_vision_reads v ON v.source_kind=s.source_kind AND v.source_id=s.source_id AND v.job_id=s.job_id
 WHERE v.id IS NULL
  OR (v.outcome='pending' AND v.next_at<=now())
  OR (v.outcome='leased' AND v.lease_until<=now())
  OR (v.outcome NOT IN ('pending','leased') AND v.source_fingerprint<>s.fingerprint)
 ORDER BY s.doc_at DESC NULLS LAST, s.source_id
 LIMIT greatest(1,least(coalesce(p_limit,5),50))
$$;
COMMENT ON FUNCTION public.context_document_vision_due(integer) IS
 'Documents on live jobs that the text reader (B-5) recorded no_text_layer for their current bytes, due a vision read now (gap plan B-5b): never tried, pending with the next try due, a lapsed lease, or changed since a terminal outcome. Newest first. capture_mode is live for a document from the last 48 hours, else backfill.';

-- The backoff, shared by the claim and the writer.
CREATE OR REPLACE FUNCTION public.context_document_vision_backoff(p_attempts integer) RETURNS interval
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT make_interval(mins=>(public.context_document_vision_policy()->'backoff_minutes'->>
  greatest(0,least(p_attempts-1,jsonb_array_length(public.context_document_vision_policy()->'backoff_minutes')-1)))::integer)
$$;

-- 7. Claim: one document, one model call.
CREATE OR REPLACE FUNCTION public.claim_context_document_vision(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_document_vision_policy();
 now_time timestamptz:=clock_timestamp();
 kind text; src uuid; job uuid; fp text; fk text; sha text; pages integer; images integer; cut boolean;
 r public.context_document_vision_reads; existed boolean; ev uuid; res jsonb;
 max_attempts integer:=jsonb_array_length(policy->'backoff_minutes')+1;
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
 IF src IS NULL OR job IS NULL THEN RAISE EXCEPTION 'document_vision_invalid'; END IF;

 IF NOT (public.context_document_vision_flag()->>'enabled')::boolean THEN
  RETURN jsonb_build_object('outcome','flag_off');
 END IF;
 -- One claimer per document at a time.
 PERFORM pg_advisory_xact_lock(20261006,hashtext(kind||':'||src::text||':'||job::text));
 -- Still a current no_text_layer document on a live job.
 IF NOT EXISTS(SELECT 1 FROM public.context_document_text_sources() s
   JOIN public.context_document_texts t ON t.source_kind=s.source_kind AND t.source_id=s.source_id AND t.job_id=s.job_id
   WHERE s.source_kind=kind AND s.source_id=src AND s.job_id=job AND s.fingerprint=fp
    AND t.outcome='no_text_layer' AND t.file_kind IN ('pdf','image') AND t.source_fingerprint=fp)
 THEN RETURN jsonb_build_object('outcome','not_due','code','not_a_current_scan'); END IF;

 SELECT * INTO r FROM public.context_document_vision_reads v WHERE v.source_kind=kind AND v.source_id=src AND v.job_id=job FOR UPDATE;
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

 -- The same bytes already carry their words on this job: point at that row.
 SELECT e.id INTO ev FROM public.business_events e
 WHERE e.provider_message_id=(policy->>'key_prefix')||job::text||':'||sha AND e.job_id=job LIMIT 1;
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
 'Gap plan B-5b: takes one due document for one vision call. Reserves the call through reserve_context_model_call(''vision'') and leases the document (lease_minutes). Outcomes: claimed (reservation_id, lease_until), same_bytes_saved (the bytes already carry words on this job; no call), not_due (taken, waiting, changed, finished, or out of attempts), flag_off, and the reservation''s own refusals (paused, cap, vision_reserve, vision_budget). Refusal codes: document_vision_invalid, _source_invalid, _fingerprint_invalid, _file_kind_invalid, _sha256_invalid, _image_count_invalid.';

-- 8. The writer for every other outcome.
CREATE OR REPLACE FUNCTION public.record_context_document_vision(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_document_vision_policy();
 now_time timestamptz:=clock_timestamp();
 kind text; src uuid; job uuid; fp text; fk text; res text; code text; sha text; ev uuid; resv uuid; mdl text; conf numeric;
 r public.context_document_vision_reads; existed boolean; reopened boolean:=false;
 max_attempts integer:=jsonb_array_length(policy->'backoff_minutes')+1;
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
 IF src IS NULL OR job IS NULL THEN RAISE EXCEPTION 'document_vision_invalid'; END IF;
 -- Only documents the text reader handed over (a scan or a photo of this job).
 IF NOT EXISTS(SELECT 1 FROM public.context_document_texts t WHERE t.source_kind=kind AND t.source_id=src AND t.job_id=job) THEN
  RAISE EXCEPTION 'document_vision_source_not_found';
 END IF;
 IF res='saved' THEN
  IF sha IS NULL OR ev IS NULL THEN RAISE EXCEPTION 'document_vision_invalid'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.business_events e WHERE e.id=ev AND e.job_id=job
    AND e.provider_message_id=(policy->>'key_prefix')||job::text||':'||sha) THEN
   RAISE EXCEPTION 'document_vision_event_not_found';
  END IF;
 END IF;

 PERFORM pg_advisory_xact_lock(20261006,hashtext(kind||':'||src::text||':'||job::text));
 SELECT * INTO r FROM public.context_document_vision_reads v WHERE v.source_kind=kind AND v.source_id=src AND v.job_id=job FOR UPDATE;
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
 'The writer of context_document_vision_reads for every outcome but the claim (gap plan B-5b). result: saved | no_text | low_confidence | too_large | not_supported | no_file | error. An answer names the reservation that holds the lease (else document_vision_lease_lost). Errors wait 1 h, 6 h, 24 h; the attempt after the last wait that fails again is terminal failed:<code>; a model_route_* error does not count against the document. A terminal record reopens only when the document''s fingerprint changed. Refusal codes: document_vision_invalid, _source_invalid, _fingerprint_invalid, _file_kind_invalid, _result_invalid, _code_invalid, _code_required, _sha256_invalid, _sha256_mismatch, _model_invalid, _confidence_invalid, _source_not_found, _event_not_found, _lease_lost, _leased.';

-- 9. The leased document, for the answer.
CREATE OR REPLACE FUNCTION public.context_document_vision_leased(p_reservation_id uuid)
RETURNS TABLE (source_kind text, source_id uuid, job_id uuid, fingerprint text, file_kind text, sha256 text, page_count integer,
 image_count integer, images_cut boolean, doc_type text, file_name text, content_type text, doc_at timestamptz,
 capture_mode text, lease_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT v.source_kind, v.source_id, v.job_id, v.source_fingerprint, v.file_kind, v.sha256, v.page_count,
  coalesce(v.image_count,0), coalesce(v.images_cut,false), s.doc_type, s.file_name, s.content_type, s.doc_at,
  CASE WHEN s.doc_at>=now()-make_interval(hours=>(public.context_document_vision_policy()->>'live_window_hours')::integer)
   THEN 'live' ELSE 'backfill' END,
  v.lease_until
 FROM public.context_document_vision_reads v
 LEFT JOIN LATERAL (SELECT x.doc_type, x.file_name, x.content_type, x.doc_at FROM public.context_document_text_sources() x
  WHERE x.source_kind=v.source_kind AND x.source_id=v.source_id AND x.job_id=v.job_id LIMIT 1) s ON true
 WHERE p_reservation_id IS NOT NULL AND v.reservation_id=p_reservation_id AND v.outcome='leased'
$$;
COMMENT ON FUNCTION public.context_document_vision_leased(uuid) IS
 'Gap plan B-5b: the document a vision call reservation holds (outcome leased), with what its evidence row needs. Empty when the reservation lost its lease.';

-- 10. Would a vision call be admitted now? Read only.
CREATE OR REPLACE FUNCTION public.context_document_vision_admission() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_document_vision_policy();
 today date:=(clock_timestamp() AT TIME ZONE 'Australia/Perth')::date;
 used integer; vision_used integer; cap integer:=public.context_document_vision_daily_cap();
 ceiling integer:=(policy->>'shared_calls_ceiling')::integer; why text;
BEGIN
 SELECT count(*), count(*) FILTER (WHERE r.phase='vision') INTO used, vision_used
 FROM public.context_model_call_reservations r WHERE r.run_date=today;
 why:=CASE
  WHEN NOT (public.context_document_vision_flag()->>'enabled')::boolean THEN 'flag_off'
  WHEN NOT public.automation_lane_enabled('capture') OR NOT public.automation_lane_enabled('extraction') THEN 'paused'
  WHEN used>=400 THEN 'cap'
  WHEN used>=ceiling THEN 'vision_reserve'
  WHEN vision_used>=cap THEN 'vision_budget'
 END;
 RETURN jsonb_build_object('open',why IS NULL,'code',why,'run_date',today,'calls_used_today',used,'vision_calls_today',vision_used,
  'vision_daily_cap',cap,'shared_calls_ceiling',ceiling);
END $$;

-- 11. The status block.
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
  JOIN public.context_document_texts t ON t.source_kind=s.source_kind AND t.source_id=s.source_id AND t.job_id=s.job_id
   AND t.outcome='no_text_layer' AND t.file_kind IN ('pdf','image') AND t.source_fingerprint=s.fingerprint
  LEFT JOIN public.context_document_vision_reads v ON v.source_kind=s.source_kind AND v.source_id=s.source_id AND v.job_id=s.job_id
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
COMMENT ON FUNCTION public.context_document_vision_status() IS
 'Document vision status (gap plan B-5b): of the documents on live jobs the text reader found no text layer in (scans and photos), how many now carry words as evidence and each other outcome; today''s vision calls against the daily cap; the alarms document_vision_stale and document_vision_failing. Counts and codes only, never words.';

-- 12. Grants. Service-side only.
REVOKE ALL ON FUNCTION public.context_document_vision_policy(),public.context_document_vision_flag(),
 public.context_document_vision_daily_cap(),public.context_document_vision_due(integer),public.context_document_vision_backoff(integer),
 public.claim_context_document_vision(jsonb),public.record_context_document_vision(jsonb),public.context_document_vision_leased(uuid),
 public.context_document_vision_admission(),public.context_document_vision_status(),
 public.reserve_context_model_call(text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_document_vision_policy(),public.context_document_vision_flag(),
 public.context_document_vision_daily_cap(),public.context_document_vision_due(integer),
 public.claim_context_document_vision(jsonb),public.record_context_document_vision(jsonb),public.context_document_vision_leased(uuid),
 public.context_document_vision_admission(),public.context_document_vision_status(),
 public.reserve_context_model_call(text,uuid,uuid) TO service_role;
