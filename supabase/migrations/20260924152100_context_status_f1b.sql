-- F1b: context foundation, revise2 additions (INTEGRATION.md X22, Wave 2).
--
-- The foundation owner's second slice. Same owner as F1, so it is the only
-- other slice allowed to change the status composer. Three changes:
--
--   1. Four new status blocks, as stubs that return null until their owning
--      slice replaces them:
--        email_capture       context_email_capture_status()       email EM1
--        transcript_capture  context_transcript_capture_status()  transcripts T2
--        money               context_money_status()               money MN1
--        bucket              context_bucket_status()              bucket B2
--      context_pipeline_status() calls them after the five F1 blocks. Every
--      existing key keeps its value; the composer rules are unchanged.
--
--   2. context_capture_runs.window_end_id: the provider id of the last item a
--      run fully processed at window_to. (window_to, window_end_id) is the pair
--      cursor the email poller needs (email.md "Cursor"): many messages can
--      share one receivedDateTime, so the time alone either re-reads or skips
--      them. The column is byte-ordered (COLLATE "C") so a SQL comparison of
--      the pair is the same on every database. It is written only through
--      record_capture_run() (new key window_end_id). It belongs to window_to:
--      an id needs a window_to, and a call that moves window_to without naming
--      window_end_id clears the stored id, so a stale id is never paired with
--      a new time. Callers that never send it (the GHL reconciler) see no
--      change.
--
--   3. context_source_freshness(): the transcript source swap (transcripts.md
--      §8 "Freshness", review M6). Two named sources in the policy:
--        transcribe-call      retired (the Whisper path; T0 stops it). Still
--                             listed while it has rows in the lookback, never
--                             raises capture_quiet, so its silence after T0 is
--                             not an alarm the desk learns to ignore.
--        ghl-call-transcript  its successor (T2's fetcher). Always listed, even
--                             before its first row. Raises capture_quiet only
--                             while feature flag ghl_call_transcript_fetch_v1
--                             is on; a missing or unreadable flag reads as off.
--      Each source row keeps its measured quiet value and gains alarm_exempt
--      (null, retired or flag_off) and, for the successor, its flag state.
--      Every other source is judged exactly as before.
--
-- No flag or switch changes. No row is written or rewritten. No grant, policy
-- or view is added for anon or authenticated.
--
-- Built on the LIVE production definitions, read from production 24 Sep 2026
-- (read-only transaction, rolled back). Each object this migration replaces
-- matched the repository body it starts from:
--   context_pipeline_status()          md5(prosrc) 6f78816a6f676cd9a28f6271d2c6c8e0 (F1)
--   context_source_freshness()         md5(prosrc) ce094feb8df8b7dd596e639ac47a7825 (F1)
--   context_source_freshness_policy()  md5(prosrc) 230c0b1965208474fc6ea076e5dd3f6f (F1)
--   record_capture_run(jsonb)          md5(prosrc) a85b48f9422fff111ee96093bad55c40 (F1)
--   context_capture_runs: F1's twelve columns, no window_end_id
--   the four new stub functions: absent
--   feature flag ghl_call_transcript_fetch_v1: no row (reads as off)
--   ledger: no row at 20260924152100
-- Effect on today's alarms: none. transcribe-call wrote 85 rows in the last
-- 14 days, below the normally-active rate, so F1 was not alarming on it yet;
-- F1b stops it alarming once T0 retires the Whisper path.
-- The guard refuses unless each is still that pre-image or already this
-- migration's result (a re-apply). Anything else is a live change nobody read,
-- and replacing it would silently revert it.
--
-- Rollback: supabase/rollbacks/20260924152100_context_status_f1b_down.sql
-- restores the four F1 bodies byte for byte (md5 checked), drops the four
-- stubs and the column. It refuses while a later slice owns one of the new
-- blocks or a run row carries a window_end_id.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; cols text; id_def text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- Replaced objects: live pre-image, or this migration's body.
  ('public.context_pipeline_status()',ARRAY['6f78816a6f676cd9a28f6271d2c6c8e0','9183a756c0d4b3881507656751c0d422'],false),
  ('public.context_source_freshness()',ARRAY['ce094feb8df8b7dd596e639ac47a7825','b12cdb949edd17fbf636990c45c6345d'],false),
  ('public.context_source_freshness_policy()',ARRAY['230c0b1965208474fc6ea076e5dd3f6f','455f0ec0a3f6c60477a68044db10a448'],false),
  ('public.record_capture_run(jsonb)',ARRAY['a85b48f9422fff111ee96093bad55c40','db03c98a6da49f128595342f5a93f84c'],false),
  -- New stubs: absent, or already this migration's stub body.
  ('public.context_email_capture_status()',ARRAY['155104bfb08b8b3c2f98bdec089d4ee4'],true),
  ('public.context_transcript_capture_status()',ARRAY['155104bfb08b8b3c2f98bdec089d4ee4'],true),
  ('public.context_money_status()',ARRAY['155104bfb08b8b3c2f98bdec089d4ee4'],true),
  ('public.context_bucket_status()',ARRAY['155104bfb08b8b3c2f98bdec089d4ee4'],true)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum) INTO cols
 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.context_capture_runs') AND a.attnum>0 AND NOT a.attisdropped AND a.attname<>'window_end_id';
 IF cols IS DISTINCT FROM 'id:uuid,source:text,status:text,started_at:timestamp with time zone,updated_at:timestamp with time zone,finished_at:timestamp with time zone,window_from:timestamp with time zone,window_to:timestamp with time zone,watermark:timestamp with time zone,cursor:jsonb,counts:jsonb,error_code:text'
 THEN problems:=problems||format('context_capture_runs columns are %s',coalesce(cols,'<missing table>')); END IF;
 SELECT format_type(a.atttypid,a.atttypmod)||' collate '||coalesce((SELECT c.collname FROM pg_collation c WHERE c.oid=a.attcollation),'?') INTO id_def
 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.context_capture_runs') AND a.attname='window_end_id' AND NOT a.attisdropped;
 IF id_def IS NOT NULL AND id_def<>'text collate C' THEN problems:=problems||format('context_capture_runs.window_end_id exists as %s',id_def); END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_status_f1b_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. Stubs for the revise2 blocks. Each owning slice replaces its own.
CREATE OR REPLACE FUNCTION public.context_email_capture_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT NULL::jsonb $$;
COMMENT ON FUNCTION public.context_email_capture_status() IS
 'F1b stub. Status block email_capture, owned by email slice EM1, which replaces this body. Null means not built yet.';
CREATE OR REPLACE FUNCTION public.context_transcript_capture_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT NULL::jsonb $$;
COMMENT ON FUNCTION public.context_transcript_capture_status() IS
 'F1b stub. Status block transcript_capture, owned by transcripts slice T2, which replaces this body. Null means not built yet.';
CREATE OR REPLACE FUNCTION public.context_money_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT NULL::jsonb $$;
COMMENT ON FUNCTION public.context_money_status() IS
 'F1b stub. Status block money, owned by money slice MN1, which replaces this body. Null means not built yet.';
CREATE OR REPLACE FUNCTION public.context_bucket_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT NULL::jsonb $$;
COMMENT ON FUNCTION public.context_bucket_status() IS
 'F1b stub. Status block bucket, owned by bucket slice B2, which replaces this body. Null means not built yet.';

-- 2. The composer: F1's body with four more blocks after parties. Core keys
-- stay top-level and win over any block key; a block that raises is isolated
-- as {"error": SQLSTATE} plus a status_block_failed alarm; a core failure still
-- fails the read.
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
   (5,'parties','context_parties_status'),
   (6,'email_capture','context_email_capture_status'),
   (7,'transcript_capture','context_transcript_capture_status'),
   (8,'money','context_money_status'),
   (9,'bucket','context_bucket_status')) AS t(ord,block,fn) ORDER BY t.ord LOOP
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
 'Context pipeline heartbeat composer: context_core_status() keys at top level, plus cadence, capture_sources, ghl_capture, booking_capture, parties (F1) and email_capture, transcript_capture, money, bucket (F1b) blocks (null until built) and alarms[], the concatenation of every block''s alarms. Only F1 and F1b change this function.';

-- 3. The pair cursor for capture runs.
ALTER TABLE public.context_capture_runs ADD COLUMN IF NOT EXISTS window_end_id text COLLATE "C";
ALTER TABLE public.context_capture_runs DROP CONSTRAINT IF EXISTS context_capture_runs_window_end_id;
ALTER TABLE public.context_capture_runs ADD CONSTRAINT context_capture_runs_window_end_id
 CHECK (window_end_id IS NULL OR (window_to IS NOT NULL AND length(window_end_id) BETWEEN 1 AND 512 AND window_end_id ~ '^[A-Za-z0-9._:=+/@<>-]+$'));
COMMENT ON COLUMN public.context_capture_runs.window_end_id IS
 'Provider id of the last item fully processed at window_to; (window_to, window_end_id) is the pair cursor for sources whose items can share a timestamp (email). Byte-ordered (COLLATE "C"). Needs window_to; cleared when window_to moves without it. Ids only, never message text. Written only through record_capture_run(). Added by F1b.';

-- p_run keys: run_id (optional uuid; a new id creates the run, an existing id
-- updates it), source (required), status (default running), window_from,
-- window_to, window_end_id, watermark, cursor, counts (object of non-negative
-- integers, replaced whole), error_code. A key that is absent keeps the stored
-- value, except that moving window_to without window_end_id clears the stored
-- window_end_id. A finished run is immutable: an identical repeat returns
-- unchanged, any other change refuses capture_run_finished.
CREATE OR REPLACE FUNCTION public.record_capture_run(p_run jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 r public.context_capture_runs; n public.context_capture_runs; run_id uuid; src text; k text; val jsonb; existed boolean;
 now_time timestamptz:=clock_timestamp();
BEGIN
 IF p_run IS NULL OR jsonb_typeof(p_run)<>'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_run) x WHERE x NOT IN ('run_id','source','status','window_from','window_to','window_end_id','watermark','cursor','counts','error_code'))
 THEN RAISE EXCEPTION 'capture_run_invalid'; END IF;
 src:=nullif(btrim(p_run->>'source'),'');
 IF src IS NULL OR src !~ '^[a-z][a-z0-9_]{2,62}$' THEN RAISE EXCEPTION 'capture_run_source_invalid'; END IF;
 IF p_run ? 'status' AND (p_run->>'status') NOT IN ('running','succeeded','partial','failed') THEN RAISE EXCEPTION 'capture_run_status_invalid'; END IF;
 IF p_run ? 'window_end_id' AND jsonb_typeof(p_run->'window_end_id') NOT IN ('string','null') THEN RAISE EXCEPTION 'capture_run_invalid'; END IF;
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
  n.window_from:=NULL; n.window_to:=NULL; n.window_end_id:=NULL; n.watermark:=NULL; n.cursor:=NULL; n.error_code:=NULL; n.finished_at:=NULL;
 END IF;
 IF p_run ? 'status' THEN n.status:=p_run->>'status'; END IF;
 IF p_run ? 'window_from' THEN n.window_from:=(p_run->>'window_from')::timestamptz; END IF;
 IF p_run ? 'window_to' THEN
  -- The id belongs to its time: a moved window_to without an id drops the old id.
  IF NOT p_run ? 'window_end_id' AND n.window_to IS DISTINCT FROM (p_run->>'window_to')::timestamptz THEN n.window_end_id:=NULL; END IF;
  n.window_to:=(p_run->>'window_to')::timestamptz;
 END IF;
 IF p_run ? 'window_end_id' THEN n.window_end_id:=nullif(p_run->>'window_end_id',''); END IF;
 IF p_run ? 'watermark' THEN n.watermark:=(p_run->>'watermark')::timestamptz; END IF;
 IF p_run ? 'cursor' THEN n.cursor:=CASE WHEN jsonb_typeof(p_run->'cursor')='null' THEN NULL ELSE p_run->'cursor' END; END IF;
 IF p_run ? 'counts' THEN n.counts:=p_run->'counts'; END IF;
 IF p_run ? 'error_code' THEN n.error_code:=nullif(p_run->>'error_code',''); END IF;
 IF n.error_code IS NOT NULL AND n.error_code !~ '^[a-z0-9][a-z0-9_.:-]{0,119}$' THEN RAISE EXCEPTION 'capture_run_error_code_invalid'; END IF;
 IF n.status='failed' AND n.error_code IS NULL THEN RAISE EXCEPTION 'capture_run_error_code_required'; END IF;
 IF existed AND r.status<>'running' THEN
  IF (n.status,n.window_from,n.window_to,n.window_end_id,n.watermark,n.cursor,n.counts,n.error_code)
     IS NOT DISTINCT FROM (r.status,r.window_from,r.window_to,r.window_end_id,r.watermark,r.cursor,r.counts,r.error_code)
  THEN RETURN jsonb_build_object('outcome','unchanged','run_id',r.id,'source',r.source,'status',r.status); END IF;
  RAISE EXCEPTION 'capture_run_finished';
 END IF;
 n.updated_at:=now_time;
 n.finished_at:=CASE WHEN n.status='running' THEN NULL ELSE now_time END;
 BEGIN
  IF existed THEN
   UPDATE public.context_capture_runs c SET status=n.status,updated_at=n.updated_at,finished_at=n.finished_at,window_from=n.window_from,
    window_to=n.window_to,window_end_id=n.window_end_id,watermark=n.watermark,cursor=n.cursor,counts=n.counts,error_code=n.error_code WHERE c.id=n.id;
  ELSE
   INSERT INTO public.context_capture_runs(id,source,status,started_at,updated_at,finished_at,window_from,window_to,window_end_id,watermark,cursor,counts,error_code)
   VALUES(n.id,n.source,n.status,n.started_at,n.updated_at,n.finished_at,n.window_from,n.window_to,n.window_end_id,n.watermark,n.cursor,n.counts,n.error_code);
  END IF;
 EXCEPTION WHEN check_violation THEN RAISE EXCEPTION 'capture_run_invalid';
  WHEN unique_violation THEN RAISE EXCEPTION 'capture_run_conflict';
 END;
 RETURN jsonb_build_object('outcome',CASE WHEN existed THEN 'updated' ELSE 'created' END,'run_id',n.id,'source',n.source,'status',n.status);
END $$;
COMMENT ON FUNCTION public.record_capture_run(jsonb) IS
 'The one writer of context_capture_runs. Creates or updates one run row; a finished run is immutable. window_end_id pairs with window_to (F1b). Refusal codes: capture_run_invalid, capture_run_source_invalid, capture_run_status_invalid, capture_run_counts_invalid, capture_run_error_code_invalid, capture_run_error_code_required, capture_run_source_mismatch, capture_run_finished, capture_run_conflict.';

-- 4. Freshness: the transcript source swap.
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
  'ignored_capture_modes',jsonb_build_array('backfill','relink'),
  -- Writers that have stopped for good: listed while they have rows in the
  -- lookback, never alarmed. transcribe-call is the Whisper path (transcripts
  -- slice T0 stops it; T5 deletes it).
  'retired_sources',jsonb_build_array(jsonb_build_object('source','transcribe-call','replaced_by','ghl-call-transcript')),
  -- Writers that only run while a feature flag is on: always listed, alarmed
  -- only while the flag is on. A missing or unreadable flag reads as off.
  'flag_gated_sources',jsonb_build_array(jsonb_build_object('source','ghl-call-transcript','flag','ghl_call_transcript_fetch_v1')))
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
 retired text[]:=ARRAY(SELECT x->>'source' FROM jsonb_array_elements(policy->'retired_sources') x);
 gated jsonb:='[]'::jsonb; g jsonb; on_flag boolean; changed timestamptz; flag_state text;
BEGIN
 -- Flag state per gated source. Fails closed: no table, no row, or an error is off.
 FOR g IN SELECT value FROM jsonb_array_elements(policy->'flag_gated_sources') LOOP
  on_flag:=NULL; changed:=NULL; flag_state:='present';
  BEGIN
   IF to_regclass('public.feature_flags') IS NULL THEN flag_state:='missing';
   ELSE
    EXECUTE 'SELECT f.enabled,f.updated_at FROM public.feature_flags f WHERE f.flag_name=$1 ORDER BY f.updated_at DESC NULLS LAST LIMIT 1'
     INTO on_flag,changed USING g->>'flag';
    IF on_flag IS NULL THEN flag_state:='missing'; END IF;
   END IF;
  EXCEPTION WHEN OTHERS THEN on_flag:=NULL; changed:=NULL; flag_state:='unreadable';
  END;
  gated:=gated||jsonb_build_array(jsonb_build_object('source',g->>'source','flag',jsonb_build_object('name',g->>'flag',
   'enabled',coalesce(on_flag,false),'updated_at',changed,'state',flag_state)));
 END LOOP;
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
  -- A gated source is listed before its first row, with nothing measured.
  UNION ALL
  SELECT x->>'source',NULL::timestamptz,0::bigint,NULL::integer,NULL::integer FROM jsonb_array_elements(gated) x
  WHERE NOT EXISTS(SELECT 1 FROM latest l WHERE l.source=x->>'source')
 ), judged AS (
  SELECT m.*,
   CASE WHEN m.window_business_minutes>0 THEN round(m.rows_in_business_hours/(m.window_business_minutes/60.0),2) END AS rows_per_business_hour,
   (SELECT x->'flag' FROM jsonb_array_elements(gated) x WHERE x->>'source'=m.source) AS flag
  FROM measured m
 ), flagged AS (
  SELECT j.*, coalesce(j.rows_per_business_hour>=min_rate,false) AS normally_active,
   coalesce(j.rows_per_business_hour>=min_rate,false) AND coalesce(j.quiet_business_minutes>=quiet_minutes,false) AS quiet,
   CASE WHEN j.source=ANY(retired) THEN 'retired'
        WHEN j.flag IS NOT NULL AND (j.flag->>'enabled')::boolean IS NOT TRUE THEN 'flag_off' END AS alarm_exempt
  FROM judged j
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('source',f.source,'last_captured_at',f.last_at,
   'quiet_business_minutes',f.quiet_business_minutes,'rows_in_business_hours',f.rows_in_business_hours,
   'rate_window_business_minutes',f.window_business_minutes,'rows_per_business_hour',f.rows_per_business_hour,
   'normally_active',f.normally_active,'quiet',f.quiet,'alarm_exempt',f.alarm_exempt)
   ||CASE WHEN f.flag IS NOT NULL THEN jsonb_build_object('flag',f.flag) ELSE '{}'::jsonb END ORDER BY f.source),'[]'::jsonb),
  coalesce(jsonb_agg(jsonb_build_object('key','capture_quiet','severity','warning','since',f.last_at,'source',f.source,
   'quiet_business_minutes',f.quiet_business_minutes,'rows_per_business_hour',f.rows_per_business_hour,
   'what_to_do','Evidence from this source has stopped arriving. Check that its writer (function, cron job or webhook) is running, that its provider credentials are valid, and that the capture lane is on.')
   ORDER BY f.source) FILTER (WHERE f.quiet AND f.alarm_exempt IS NULL),'[]'::jsonb)
 INTO sources, alarms FROM flagged f;
 RETURN jsonb_build_object('as_of',now_time,'policy',policy,'in_business_hours',public.context_in_business_hours(now_time),
  'capture_lane',public.automation_lane_enabled('capture'),'sources',sources,'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_source_freshness() IS
 'Status block capture_sources: last context_captured_at per business_events.source, business minutes since, and the capture_quiet alarm for a normally active source that wrote nothing for 2 business hours. Retired sources (transcribe-call) never alarm; flag-gated sources (ghl-call-transcript) are always listed and alarm only while their flag is on (F1b). Owned by F1.';

-- 5. Grants. Every new or re-created function: no PUBLIC, anon or
-- authenticated execute; service_role only.
REVOKE ALL ON FUNCTION
 public.context_email_capture_status(),public.context_transcript_capture_status(),public.context_money_status(),public.context_bucket_status(),
 public.context_pipeline_status(),public.record_capture_run(jsonb),public.context_source_freshness_policy(),public.context_source_freshness()
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION
 public.context_email_capture_status(),public.context_transcript_capture_status(),public.context_money_status(),public.context_bucket_status(),
 public.context_pipeline_status(),public.record_capture_run(jsonb),public.context_source_freshness_policy(),public.context_source_freshness()
TO service_role;
