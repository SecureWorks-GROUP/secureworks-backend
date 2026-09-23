-- Roll back F1b (20260924152100_context_status_f1b).
--
-- Refuses rather than discarding data or a later slice's work: it stops if a
-- later slice has replaced one of the four F1b stubs (email EM1, transcripts
-- T2, money MN1, bucket B2 roll back first), if any capture run carries a
-- window_end_id (the email poller's cursor; roll that back first), or if one of
-- the four replaced functions is no longer the F1b body.
--
-- It restores F1's definitions byte for byte (the production pre-image F1b's
-- guard pinned) and checks them afterwards:
--   context_pipeline_status()          md5(prosrc) 6f78816a6f676cd9a28f6271d2c6c8e0
--   context_source_freshness()         md5(prosrc) ce094feb8df8b7dd596e639ac47a7825
--   context_source_freshness_policy()  md5(prosrc) 230c0b1965208474fc6ea076e5dd3f6f
--   record_capture_run(jsonb)          md5(prosrc) a85b48f9422fff111ee96093bad55c40
-- then drops window_end_id (with its check) and the four stubs. No flag,
-- switch or row is touched. After it, F1's own rollback can run again.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE f text; x record; has_ids boolean:=false;
BEGIN
 FOREACH f IN ARRAY ARRAY['context_email_capture_status','context_transcript_capture_status','context_money_status','context_bucket_status'] LOOP
  IF to_regprocedure('public.'||f||'()') IS NOT NULL AND coalesce(obj_description(to_regprocedure('public.'||f||'()'),'pg_proc'),'') NOT LIKE 'F1b stub.%'
  THEN RAISE EXCEPTION 'f1b_rollback_refused: % is no longer the F1b stub; roll back its owning slice first',f; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.context_capture_runs'::regclass AND attname='window_end_id' AND NOT attisdropped) THEN
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.context_capture_runs WHERE window_end_id IS NOT NULL)' INTO has_ids;
 END IF;
 IF has_ids
 THEN RAISE EXCEPTION 'f1b_rollback_refused: context_capture_runs rows carry window_end_id; roll back the email poller first'; END IF;
 FOR x IN SELECT * FROM (VALUES
  ('public.context_pipeline_status()','9183a756c0d4b3881507656751c0d422'),
  ('public.context_source_freshness()','b12cdb949edd17fbf636990c45c6345d'),
  ('public.context_source_freshness_policy()','455f0ec0a3f6c60477a68044db10a448'),
  ('public.record_capture_run(jsonb)','db03c98a6da49f128595342f5a93f84c')) AS t(sig,md5) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(x.sig)) IS DISTINCT FROM x.md5
  THEN RAISE EXCEPTION 'f1b_rollback_refused: % is not the F1b body',x.sig; END IF;
 END LOOP;
END $$;

-- F1's bodies, copied from 20260924020000_context_status_foundation.sql.
CREATE OR REPLACE FUNCTION public.context_pipeline_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE core jsonb; blocks jsonb:='{}'::jsonb; alarms jsonb:='[]'::jsonb; b record; v jsonb; a jsonb;
BEGIN
 core:=public.context_core_status();
 FOR b IN SELECT t.block,t.fn FROM (VALUES
   (1,'cadence','context_cadence_status'),
   (2,'capture_sources','context_source_freshness'),
   (3,'ghl_capture','context_ghl_capture_status'),
   (4,'booking_capture','context_booking_capture_status'),
   (5,'parties','context_parties_status')) AS t(ord,block,fn) ORDER BY t.ord LOOP
  BEGIN
   EXECUTE format('SELECT public.%I()',b.fn) INTO v;
  EXCEPTION WHEN OTHERS THEN
   v:=jsonb_build_object('error',SQLSTATE);
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','status_block_failed','severity','warning','since',now(),
    'block',b.block,'code',SQLSTATE,'what_to_do','This part of the context status could not be read. Check the named status function; the rest of the status is unaffected.'));
  END;
  blocks:=blocks||jsonb_build_object(b.block,v);
  IF jsonb_typeof(v->'alarms')='array' THEN
   FOR a IN SELECT value FROM jsonb_array_elements(v->'alarms') LOOP
    alarms:=alarms||jsonb_build_array(CASE WHEN jsonb_typeof(a)='object' THEN jsonb_build_object('block',b.block)||a
     ELSE jsonb_build_object('block',b.block,'value',a) END);
   END LOOP;
  END IF;
 END LOOP;
 RETURN blocks||jsonb_build_object('alarms',alarms)||core;
END $$;
COMMENT ON FUNCTION public.context_pipeline_status() IS
 'Context pipeline heartbeat composer: context_core_status() keys at top level, plus cadence, capture_sources, ghl_capture, booking_capture, parties blocks (null until built) and alarms[], the concatenation of every block''s alarms. Only F1 changes this function.';

CREATE OR REPLACE FUNCTION public.context_source_freshness_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'timezone','Australia/Perth','business_days','Mon-Sat','business_hours','07:00-18:00',
  -- capture_quiet fires after this many business minutes without a row.
  'quiet_business_minutes',120,
  -- A source is normally active when, over the rate window ending at its last
  -- row, it wrote at least this many rows per business hour. At 2.5 an honest
  -- source goes 2 business hours without a row about 0.7% of the time.
  'normally_active_min_rows_per_business_hour',2.5,
  'rate_window_days',14,
  -- Sources whose last row is older than this are not listed.
  'lookback_days',60,
  -- business_events.metadata.capture_mode values that are not new capture.
  'ignored_capture_modes',jsonb_build_array('backfill','relink'))
$$;

CREATE OR REPLACE FUNCTION public.context_source_freshness() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_source_freshness_policy();
 quiet_minutes integer:=(policy->>'quiet_business_minutes')::integer;
 min_rate numeric:=(policy->>'normally_active_min_rows_per_business_hour')::numeric;
 rate_window interval:=make_interval(days=>(policy->>'rate_window_days')::integer);
 lookback interval:=make_interval(days=>(policy->>'lookback_days')::integer);
 now_time timestamptz:=now(); sources jsonb; alarms jsonb;
BEGIN
 WITH captured AS (
  SELECT coalesce(nullif(btrim(e.source),''),'(none)') AS source, e.context_captured_at AS at
  FROM public.business_events e
  WHERE e.context_captured_at > now_time-lookback-rate_window AND e.context_captured_at<=now_time
   AND coalesce(e.metadata->>'capture_mode','live') NOT IN (SELECT jsonb_array_elements_text(policy->'ignored_capture_modes'))
 ), latest AS (
  SELECT c.source, max(c.at) AS last_at FROM captured c GROUP BY c.source HAVING max(c.at)>now_time-lookback
 ), measured AS (
  SELECT l.source, l.last_at,
   count(*) FILTER (WHERE c.at>l.last_at-rate_window AND public.context_in_business_hours(c.at)) AS rows_in_business_hours,
   public.context_business_minutes(l.last_at-rate_window,l.last_at) AS window_business_minutes,
   public.context_business_minutes(l.last_at,now_time) AS quiet_business_minutes
  FROM latest l JOIN captured c ON c.source=l.source GROUP BY l.source,l.last_at
 ), judged AS (
  SELECT m.*,
   CASE WHEN m.window_business_minutes>0 THEN round(m.rows_in_business_hours/(m.window_business_minutes/60.0),2) END AS rows_per_business_hour
  FROM measured m
 ), flagged AS (
  SELECT j.*, coalesce(j.rows_per_business_hour>=min_rate,false) AS normally_active,
   coalesce(j.rows_per_business_hour>=min_rate,false) AND j.quiet_business_minutes>=quiet_minutes AS quiet
  FROM judged j
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('source',f.source,'last_captured_at',f.last_at,
   'quiet_business_minutes',f.quiet_business_minutes,'rows_in_business_hours',f.rows_in_business_hours,
   'rate_window_business_minutes',f.window_business_minutes,'rows_per_business_hour',f.rows_per_business_hour,
   'normally_active',f.normally_active,'quiet',f.quiet) ORDER BY f.source),'[]'::jsonb),
  coalesce(jsonb_agg(jsonb_build_object('key','capture_quiet','severity','warning','since',f.last_at,'source',f.source,
   'quiet_business_minutes',f.quiet_business_minutes,'rows_per_business_hour',f.rows_per_business_hour,
   'what_to_do','Evidence from this source has stopped arriving. Check that its writer (function, cron job or webhook) is running, that its provider credentials are valid, and that the capture lane is on.')
   ORDER BY f.source) FILTER (WHERE f.quiet),'[]'::jsonb)
 INTO sources, alarms FROM flagged f;
 RETURN jsonb_build_object('as_of',now_time,'policy',policy,'in_business_hours',public.context_in_business_hours(now_time),
  'capture_lane',public.automation_lane_enabled('capture'),'sources',sources,'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_source_freshness() IS
 'Status block capture_sources: last context_captured_at per business_events.source, business minutes since, and the capture_quiet alarm for a normally active source that wrote nothing for 2 business hours. Owned by F1.';

-- The F1 writer never names window_end_id, so the column can go after it.
CREATE OR REPLACE FUNCTION public.record_capture_run(p_run jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 r public.context_capture_runs; n public.context_capture_runs; run_id uuid; src text; k text; val jsonb; existed boolean;
 now_time timestamptz:=clock_timestamp();
BEGIN
 IF p_run IS NULL OR jsonb_typeof(p_run)<>'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_run) x WHERE x NOT IN ('run_id','source','status','window_from','window_to','watermark','cursor','counts','error_code'))
 THEN RAISE EXCEPTION 'capture_run_invalid'; END IF;
 src:=nullif(btrim(p_run->>'source'),'');
 IF src IS NULL OR src !~ '^[a-z][a-z0-9_]{2,62}$' THEN RAISE EXCEPTION 'capture_run_source_invalid'; END IF;
 IF p_run ? 'status' AND (p_run->>'status') NOT IN ('running','succeeded','partial','failed') THEN RAISE EXCEPTION 'capture_run_status_invalid'; END IF;
 IF p_run ? 'counts' THEN
  val:=p_run->'counts';
  IF jsonb_typeof(val)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(val))>40 THEN RAISE EXCEPTION 'capture_run_counts_invalid'; END IF;
  FOR k IN SELECT jsonb_object_keys(val) LOOP
   IF k !~ '^[a-z][a-z0-9_]{0,62}$' OR jsonb_typeof(val->k)<>'number' OR (val->>k)::numeric<0 OR (val->>k)::numeric<>trunc((val->>k)::numeric)
    OR (val->>k)::numeric>2147483647
   THEN RAISE EXCEPTION 'capture_run_counts_invalid'; END IF;
  END LOOP;
 END IF;
 BEGIN
  run_id:=coalesce((p_run->>'run_id')::uuid,gen_random_uuid());
  n.window_from:=(p_run->>'window_from')::timestamptz; n.window_to:=(p_run->>'window_to')::timestamptz; n.watermark:=(p_run->>'watermark')::timestamptz;
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'capture_run_invalid';
 END;
 SELECT * INTO r FROM public.context_capture_runs c WHERE c.id=run_id FOR UPDATE;
 existed:=FOUND;
 IF existed THEN
  IF r.source<>src THEN RAISE EXCEPTION 'capture_run_source_mismatch'; END IF;
  n:=r;
 ELSE
  n.id:=run_id; n.source:=src; n.status:='running'; n.started_at:=now_time; n.counts:='{}'::jsonb;
  n.window_from:=NULL; n.window_to:=NULL; n.watermark:=NULL; n.cursor:=NULL; n.error_code:=NULL; n.finished_at:=NULL;
 END IF;
 IF p_run ? 'status' THEN n.status:=p_run->>'status'; END IF;
 IF p_run ? 'window_from' THEN n.window_from:=(p_run->>'window_from')::timestamptz; END IF;
 IF p_run ? 'window_to' THEN n.window_to:=(p_run->>'window_to')::timestamptz; END IF;
 IF p_run ? 'watermark' THEN n.watermark:=(p_run->>'watermark')::timestamptz; END IF;
 IF p_run ? 'cursor' THEN n.cursor:=CASE WHEN jsonb_typeof(p_run->'cursor')='null' THEN NULL ELSE p_run->'cursor' END; END IF;
 IF p_run ? 'counts' THEN n.counts:=p_run->'counts'; END IF;
 IF p_run ? 'error_code' THEN n.error_code:=nullif(p_run->>'error_code',''); END IF;
 IF n.error_code IS NOT NULL AND n.error_code !~ '^[a-z0-9][a-z0-9_.:-]{0,119}$' THEN RAISE EXCEPTION 'capture_run_error_code_invalid'; END IF;
 IF n.status='failed' AND n.error_code IS NULL THEN RAISE EXCEPTION 'capture_run_error_code_required'; END IF;
 IF existed AND r.status<>'running' THEN
  IF (n.status,n.window_from,n.window_to,n.watermark,n.cursor,n.counts,n.error_code)
     IS NOT DISTINCT FROM (r.status,r.window_from,r.window_to,r.watermark,r.cursor,r.counts,r.error_code)
  THEN RETURN jsonb_build_object('outcome','unchanged','run_id',r.id,'source',r.source,'status',r.status); END IF;
  RAISE EXCEPTION 'capture_run_finished';
 END IF;
 n.updated_at:=now_time;
 n.finished_at:=CASE WHEN n.status='running' THEN NULL ELSE now_time END;
 BEGIN
  IF existed THEN
   UPDATE public.context_capture_runs c SET status=n.status,updated_at=n.updated_at,finished_at=n.finished_at,window_from=n.window_from,
    window_to=n.window_to,watermark=n.watermark,cursor=n.cursor,counts=n.counts,error_code=n.error_code WHERE c.id=n.id;
  ELSE
   INSERT INTO public.context_capture_runs(id,source,status,started_at,updated_at,finished_at,window_from,window_to,watermark,cursor,counts,error_code)
   VALUES(n.id,n.source,n.status,n.started_at,n.updated_at,n.finished_at,n.window_from,n.window_to,n.watermark,n.cursor,n.counts,n.error_code);
  END IF;
 EXCEPTION WHEN check_violation THEN RAISE EXCEPTION 'capture_run_invalid';
  WHEN unique_violation THEN RAISE EXCEPTION 'capture_run_conflict';
 END;
 RETURN jsonb_build_object('outcome',CASE WHEN existed THEN 'updated' ELSE 'created' END,'run_id',n.id,'source',n.source,'status',n.status);
END $$;
COMMENT ON FUNCTION public.record_capture_run(jsonb) IS
 'The one writer of context_capture_runs. Creates or updates one run row; a finished run is immutable. Refusal codes: capture_run_invalid, capture_run_source_invalid, capture_run_status_invalid, capture_run_counts_invalid, capture_run_error_code_invalid, capture_run_error_code_required, capture_run_source_mismatch, capture_run_finished, capture_run_conflict.';

ALTER TABLE public.context_capture_runs DROP CONSTRAINT IF EXISTS context_capture_runs_window_end_id;
ALTER TABLE public.context_capture_runs DROP COLUMN IF EXISTS window_end_id;

DROP FUNCTION IF EXISTS public.context_email_capture_status();
DROP FUNCTION IF EXISTS public.context_transcript_capture_status();
DROP FUNCTION IF EXISTS public.context_money_status();
DROP FUNCTION IF EXISTS public.context_bucket_status();

REVOKE ALL ON FUNCTION public.context_pipeline_status(),public.context_source_freshness_policy(),public.context_source_freshness(),public.record_capture_run(jsonb)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_pipeline_status(),public.context_source_freshness_policy(),public.context_source_freshness(),public.record_capture_run(jsonb)
TO service_role;

DO $$
DECLARE x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_pipeline_status()','6f78816a6f676cd9a28f6271d2c6c8e0'),
  ('public.context_source_freshness()','ce094feb8df8b7dd596e639ac47a7825'),
  ('public.context_source_freshness_policy()','230c0b1965208474fc6ea076e5dd3f6f'),
  ('public.record_capture_run(jsonb)','a85b48f9422fff111ee96093bad55c40')) AS t(sig,md5) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(x.sig)) IS DISTINCT FROM x.md5
  THEN RAISE EXCEPTION 'f1b_rollback_check_failed: % differs from the F1 pre-image',x.sig; END IF;
 END LOOP;
END $$;
