-- F1b contract (INTEGRATION.md X22). Every fixture write is rolled back.
-- Row labels follow the design notes: transcripts.md N1, N4, N7, N7b (the
-- Whisper rows and the first GHL transcript) and the email.md cursor test
-- (130 messages inside one minute). Ids, times and text are synthetic.

-- F1's freshness body, byte for byte (20260924020000). The contract compares
-- F1b's output with it on the same fixtures, in the same transaction, so the
-- only differences are the ones F1b promises.
CREATE FUNCTION pg_temp.f1_context_source_freshness() RETURNS jsonb
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

-- F1's composer body, byte for byte: the five F1 blocks only.
CREATE FUNCTION pg_temp.f1_context_pipeline_status() RETURNS jsonb
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

-- A captured row from one writer source, stamped the way capture stamps it.
CREATE FUNCTION pg_temp.f1b_rows(p_source text,p_from timestamptz,p_to timestamptz,p_step interval,p_mode text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
 INSERT INTO public.business_events(match_method,payload,occurred_at,source,event_type,channel,metadata)
  SELECT 'none',jsonb_build_object('body','f1b fixture'),g,p_source,'call.transcript_completed','call',
   CASE WHEN p_mode IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('capture_mode',p_mode) END
  FROM generate_series(p_from,p_to,p_step) g WHERE public.context_in_business_hours(g);
 GET DIAGNOSTICS n=ROW_COUNT;
 UPDATE public.business_events SET context_captured_at=occurred_at WHERE source=p_source AND context_captured_at IS DISTINCT FROM occurred_at;
 RETURN n;
END $$;

CREATE FUNCTION pg_temp.f1b_source(p_snap jsonb,p_source text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT value FROM jsonb_array_elements(p_snap->'sources') WHERE value->>'source'=p_source
$$;

BEGIN;

-- 1. Grants: the four stubs and every re-created function are service_role
-- only; the stubs are SECURITY DEFINER with a fixed search_path.
DO $$
DECLARE f regprocedure;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_email_capture_status()','public.context_transcript_capture_status()','public.context_money_status()',
  'public.context_bucket_status()','public.context_pipeline_status()','public.record_capture_run(jsonb)',
  'public.context_source_freshness_policy()','public.context_source_freshness()']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE')
  THEN RAISE EXCEPTION 'f1b public execute on %',f; END IF;
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'f1b service_role missing execute on %',f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_email_capture_status()','public.context_transcript_capture_status()','public.context_money_status()',
  'public.context_bucket_status()']::regprocedure[] LOOP
  IF (SELECT NOT prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] FROM pg_proc WHERE oid=f)
  THEN RAISE EXCEPTION 'f1b stub % must be SECURITY DEFINER with search_path=pg_catalog',f; END IF;
  IF obj_description(f,'pg_proc') NOT LIKE 'F1b stub.%' THEN RAISE EXCEPTION 'f1b stub comment on %',f; END IF;
 END LOOP;
 -- The table grants are F1's: RLS on, service_role reads, nobody writes directly.
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.context_capture_runs'::regclass)
  OR has_column_privilege('anon','public.context_capture_runs','window_end_id','SELECT')
  OR has_column_privilege('authenticated','public.context_capture_runs','window_end_id','SELECT')
  OR has_column_privilege('service_role','public.context_capture_runs','window_end_id','UPDATE')
  OR NOT has_column_privilege('service_role','public.context_capture_runs','window_end_id','SELECT')
 THEN RAISE EXCEPTION 'f1b window_end_id grants'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 2. Freshness, transcripts.md review M6. transcribe-call is the Whisper path:
-- rows as on N4, N7 and N7b (the Whisper copies of those calls), at F1's
-- normally-active rate over two weeks, then nothing for three days, which is
-- what the source looks like once T0 stops it. F1 alarmed on that silence
-- every business day; F1b lists it as retired and never alarms.
DO $$
DECLARE snap jsonb; old jsonb; src jsonb; quiet_at timestamptz:=now()-interval '3 days';
BEGIN
 IF pg_temp.f1b_rows('transcribe-call',quiet_at-interval '14 days',quiet_at,interval '10 minutes')<300 THEN RAISE EXCEPTION 'f1b fixture too small'; END IF;
 old:=pg_temp.f1_context_source_freshness();
 IF NOT old->'alarms' @> '[{"key":"capture_quiet","source":"transcribe-call"}]'::jsonb
 THEN RAISE EXCEPTION 'f1b fixture does not reproduce the F1 false alarm %',old->'alarms'; END IF;
 snap:=public.context_source_freshness();
 src:=pg_temp.f1b_source(snap,'transcribe-call');
 IF src IS NULL OR (src->>'normally_active')::boolean IS NOT TRUE OR (src->>'quiet')::boolean IS NOT TRUE OR src->>'alarm_exempt' IS DISTINCT FROM 'retired'
 THEN RAISE EXCEPTION 'f1b transcribe-call must be listed, measured quiet and exempt as retired: %',src; END IF;
 IF snap->'alarms' @> '[{"source":"transcribe-call"}]'::jsonb OR public.context_pipeline_status()->'alarms' @> '[{"source":"transcribe-call"}]'::jsonb
 THEN RAISE EXCEPTION 'f1b transcribe-call alarmed after retirement %',snap->'alarms'; END IF;
 IF snap#>'{policy,retired_sources}'<>'[{"source":"transcribe-call","replaced_by":"ghl-call-transcript"}]'::jsonb
 THEN RAISE EXCEPTION 'f1b retired sources not published %',snap->'policy'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 3. The successor, ghl-call-transcript (T2's fetcher). Before its first row it
-- is still listed, with its flag, so the desk sees it is expected and off.
DO $$
DECLARE snap jsonb; src jsonb;
BEGIN
 DELETE FROM public.business_events WHERE source='ghl-call-transcript';
 snap:=public.context_source_freshness();
 src:=pg_temp.f1b_source(snap,'ghl-call-transcript');
 IF src IS NULL OR src->'last_captured_at'<>'null'::jsonb OR (src->>'rows_in_business_hours')::int<>0 OR (src->>'quiet')::boolean IS NOT FALSE
  OR (src->>'normally_active')::boolean IS NOT FALSE OR src->>'alarm_exempt'<>'flag_off'
  OR src->'flag'<>'{"name":"ghl_call_transcript_fetch_v1","enabled":false,"updated_at":null,"state":"missing"}'::jsonb
 THEN RAISE EXCEPTION 'f1b successor before its first row %',src; END IF;
 IF snap#>'{policy,flag_gated_sources}'<>'[{"source":"ghl-call-transcript","flag":"ghl_call_transcript_fetch_v1"}]'::jsonb
 THEN RAISE EXCEPTION 'f1b gated sources not published %',snap->'policy'; END IF;
 -- The fetch flag turned on with no transcript saved yet: nothing to be quiet
 -- about in freshness (T2's own block owns "the fetcher is not running").
 INSERT INTO public.feature_flags(flag_name,enabled,updated_at) VALUES('ghl_call_transcript_fetch_v1',true,now()-interval '5 days');
 snap:=public.context_source_freshness();
 src:=pg_temp.f1b_source(snap,'ghl-call-transcript');
 IF src->>'alarm_exempt' IS NOT NULL OR (src->>'quiet')::boolean IS NOT FALSE OR snap->'alarms' @> '[{"source":"ghl-call-transcript"}]'::jsonb
 THEN RAISE EXCEPTION 'f1b successor with flag on and no rows %',src; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 4. The successor after it has run: transcripts at F1's normally-active rate,
-- the last one the N1 transcript (ghltx:6kn6WmrtfTMvhEJtmfeJ), then silence.
-- It alarms exactly while its flag is on; missing, off and unreadable flags
-- all read as off.
DO $$
DECLARE snap jsonb; src jsonb; last_at timestamptz:=now()-interval '3 days';
BEGIN
 PERFORM pg_temp.f1b_rows('ghl-call-transcript',last_at-interval '14 days',last_at-interval '1 minute',interval '10 minutes');
 INSERT INTO public.business_events(match_method,payload,occurred_at,source,event_type,channel,provider_message_id)
  VALUES('none','{"body":"N1 transcript"}',last_at,'ghl-call-transcript','call.transcript_completed','call','ghltx:6kn6WmrtfTMvhEJtmfeJ');
 UPDATE public.business_events SET context_captured_at=occurred_at WHERE source='ghl-call-transcript';
 -- Backfill transcripts (T4) are not capture, as for every source.
 PERFORM pg_temp.f1b_rows('ghl-call-transcript',now()-interval '2 days',now(),interval '10 minutes','backfill');

 -- Flag missing (production today).
 snap:=public.context_source_freshness();
 src:=pg_temp.f1b_source(snap,'ghl-call-transcript');
 IF (src->>'last_captured_at')::timestamptz IS DISTINCT FROM last_at OR (src->>'quiet')::boolean IS NOT TRUE
  OR src->>'alarm_exempt'<>'flag_off' OR src#>>'{flag,state}'<>'missing' OR snap->'alarms' @> '[{"source":"ghl-call-transcript"}]'::jsonb
 THEN RAISE EXCEPTION 'f1b successor with flag missing %',src; END IF;

 -- Flag row present and off.
 INSERT INTO public.feature_flags(flag_name,enabled,updated_at) VALUES('ghl_call_transcript_fetch_v1',false,now()-interval '20 days');
 snap:=public.context_source_freshness();
 src:=pg_temp.f1b_source(snap,'ghl-call-transcript');
 IF src->>'alarm_exempt'<>'flag_off' OR src#>>'{flag,state}'<>'present' OR (src#>>'{flag,enabled}')::boolean IS NOT FALSE
  OR snap->'alarms' @> '[{"source":"ghl-call-transcript"}]'::jsonb
 THEN RAISE EXCEPTION 'f1b successor with flag off %',src; END IF;

 -- Flag on: the silence is a real outage and alarms, through the composer too.
 UPDATE public.feature_flags SET enabled=true WHERE flag_name='ghl_call_transcript_fetch_v1';
 snap:=public.context_source_freshness();
 src:=pg_temp.f1b_source(snap,'ghl-call-transcript');
 IF src->>'alarm_exempt' IS NOT NULL OR (src#>>'{flag,enabled}')::boolean IS NOT TRUE
  OR NOT snap->'alarms' @> jsonb_build_array(jsonb_build_object('key','capture_quiet','source','ghl-call-transcript','since',last_at))
 THEN RAISE EXCEPTION 'f1b successor with flag on must alarm % %',src,snap->'alarms'; END IF;
 IF NOT public.context_pipeline_status()->'alarms' @> '[{"block":"capture_sources","key":"capture_quiet","source":"ghl-call-transcript"}]'::jsonb
 THEN RAISE EXCEPTION 'f1b successor alarm missing from the composer'; END IF;

 -- Flag unreadable (the table no longer has the column): off, and says so.
 ALTER TABLE public.feature_flags RENAME COLUMN enabled TO enabled_moved;
 snap:=public.context_source_freshness();
 src:=pg_temp.f1b_source(snap,'ghl-call-transcript');
 IF src->>'alarm_exempt'<>'flag_off' OR src#>>'{flag,state}'<>'unreadable' OR snap->'alarms' @> '[{"source":"ghl-call-transcript"}]'::jsonb
 THEN RAISE EXCEPTION 'f1b successor with flag unreadable %',src; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 5. Every other source is judged exactly as F1 judged it: same sources, same
-- measures, same alarms, plus alarm_exempt null; the policy gains only the two
-- named lists.
DO $$
DECLARE snap jsonb; old jsonb; quiet_at timestamptz:=now()-interval '10 days'; s jsonb; o jsonb;
BEGIN
 PERFORM pg_temp.f1b_rows('f1b_busy_quiet',quiet_at-interval '14 days',quiet_at,interval '10 minutes');
 PERFORM pg_temp.f1b_rows('f1b_busy_live',now()-interval '14 days',now(),interval '10 minutes');
 INSERT INTO public.business_events(match_method,payload,occurred_at,source) VALUES('none','{"body":"latest"}',now(),'f1b_busy_live');
 UPDATE public.business_events SET context_captured_at=occurred_at WHERE source='f1b_busy_live';
 PERFORM pg_temp.f1b_rows('f1b_sparse',quiet_at-interval '14 days',quiet_at,interval '1 day');
 PERFORM pg_temp.f1b_rows('f1b_backfill_only',quiet_at-interval '14 days',quiet_at,interval '10 minutes','backfill');
 old:=pg_temp.f1_context_source_freshness();
 snap:=public.context_source_freshness();
 IF snap->'policy'<>(old->'policy') OR (snap->'policy')-'retired_sources'-'flag_gated_sources'
    <>'{"timezone":"Australia/Perth","business_days":"Mon-Sat","business_hours":"07:00-18:00","quiet_business_minutes":120,"normally_active_min_rows_per_business_hour":2.5,"rate_window_days":14,"lookback_days":60,"ignored_capture_modes":["backfill","relink"]}'::jsonb
 THEN RAISE EXCEPTION 'f1b policy changed beyond the two lists %',snap->'policy'; END IF;
 FOR o IN SELECT value FROM jsonb_array_elements(old->'sources') LOOP
  s:=pg_temp.f1b_source(snap,o->>'source');
  IF s IS DISTINCT FROM o||'{"alarm_exempt":null}'::jsonb THEN RAISE EXCEPTION 'f1b source % changed: % vs %',o->>'source',s,o; END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(snap->'sources'))<>(SELECT count(*) FROM jsonb_array_elements(old->'sources'))+1
  OR pg_temp.f1b_source(snap,'ghl-call-transcript') IS NULL
 THEN RAISE EXCEPTION 'f1b listed sources beyond the successor %',snap->'sources'; END IF;
 IF snap->'alarms' IS DISTINCT FROM old->'alarms' OR NOT snap->'alarms' @> '[{"key":"capture_quiet","source":"f1b_busy_quiet"}]'::jsonb
 THEN RAISE EXCEPTION 'f1b alarms for other sources changed % vs %',snap->'alarms',old->'alarms'; END IF;
 IF (snap-'sources'-'policy') IS DISTINCT FROM (old-'sources'-'policy') THEN RAISE EXCEPTION 'f1b freshness envelope changed'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 6. The composer: four more blocks, null while their stubs stand; every other
-- key identical to F1's composer on the same fixtures; a new block's alarms
-- are concatenated with its name; a failing new block is isolated.
DO $$
DECLARE composed jsonb; old jsonb; key text; added text[]:=ARRAY['email_capture','transcript_capture','money','bucket'];
BEGIN
 PERFORM pg_temp.f1b_rows('f1b_busy_quiet',now()-interval '24 days',now()-interval '10 days',interval '10 minutes');
 composed:=public.context_pipeline_status();
 old:=pg_temp.f1_context_pipeline_status();
 IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(composed) x) IS DISTINCT FROM
    (SELECT array_agg(x ORDER BY x) FROM (SELECT jsonb_object_keys(old) x UNION SELECT unnest(added)) u)
 THEN RAISE EXCEPTION 'f1b composer keys %',(SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(composed) x); END IF;
 FOR key IN SELECT jsonb_object_keys(old) LOOP
  IF composed->key IS DISTINCT FROM old->key THEN RAISE EXCEPTION 'f1b existing key % changed: % vs %',key,composed->key,old->key; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM (VALUES ('email_capture','context_email_capture_status'),('transcript_capture','context_transcript_capture_status'),
   ('money','context_money_status'),('bucket','context_bucket_status')) b(block,fn)
  WHERE CASE WHEN (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.'||b.fn||'()'))='155104bfb08b8b3c2f98bdec089d4ee4'
   THEN composed->b.block<>'null'::jsonb ELSE jsonb_typeof(composed->b.block)<>'object' END)
 THEN RAISE EXCEPTION 'f1b unbuilt blocks must be null %',composed; END IF;

 CREATE OR REPLACE FUNCTION public.context_money_status() RETURNS jsonb LANGUAGE sql STABLE AS
  $f$ SELECT '{"last_sweep_at":null,"alarms":[{"key":"money_sweep_stale","severity":"warning","since":"2026-09-23T00:00:00Z","what_to_do":"x"}]}'::jsonb $f$;
 CREATE OR REPLACE FUNCTION public.context_bucket_status() RETURNS jsonb LANGUAGE plpgsql STABLE AS
  $f$ BEGIN RAISE EXCEPTION 'broken bucket block'; END $f$;
 composed:=public.context_pipeline_status();
 FOR key IN SELECT jsonb_object_keys(old) LOOP
  IF key<>'alarms' AND composed->key IS DISTINCT FROM old->key THEN RAISE EXCEPTION 'f1b a new block changed key %',key; END IF;
 END LOOP;
 IF composed->'money'->'last_sweep_at'<>'null'::jsonb OR composed->'bucket'<>'{"error":"P0001"}'::jsonb
 THEN RAISE EXCEPTION 'f1b new blocks not composed or isolated % %',composed->'money',composed->'bucket'; END IF;
 IF NOT composed->'alarms' @> '[{"block":"money","key":"money_sweep_stale"}]'::jsonb
  OR NOT composed->'alarms' @> '[{"block":"bucket","key":"status_block_failed","code":"P0001"}]'::jsonb
  OR NOT composed->'alarms' @> '[{"block":"capture_sources","key":"capture_quiet","source":"f1b_busy_quiet"}]'::jsonb
 THEN RAISE EXCEPTION 'f1b alarms not concatenated %',composed->'alarms'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 7. The pair cursor, email.md "Cursor" named test: 130 messages inside one
-- minute. The poller reads 4 pages of 25 per run, so run 1 processes 100 and
-- stops with a backlog; run 2 must insert exactly the last 30. The time alone
-- cannot say where run 1 stopped: strictly after it skips all 30, with the
-- 10-minute overlap it re-reads all 130. The pair (window_to, window_end_id)
-- can. Ids are Graph-style immutable ids whose byte order differs from a
-- linguistic order (mixed case), which is why the column is COLLATE "C".
DO $$
DECLARE r jsonb; run1 uuid; rec public.context_capture_runs; t timestamptz:='2026-09-23 02:14:00+00';
 ids text[]; remaining text[]; bad jsonb; expected text; before_runs bigint:=(SELECT count(*) FROM public.context_capture_runs);
BEGIN
 IF (SELECT c.collname FROM pg_attribute a JOIN pg_collation c ON c.oid=a.attcollation
     WHERE a.attrelid='public.context_capture_runs'::regclass AND a.attname='window_end_id')<>'C'
 THEN RAISE EXCEPTION 'f1b window_end_id must be byte-ordered'; END IF;
 CREATE TEMP TABLE f1b_mail(received_at timestamptz, id text COLLATE "C") ON COMMIT DROP;
 INSERT INTO f1b_mail SELECT t+make_interval(secs=>(g%60)), 'AAMkAG'||CASE WHEN g%2=0 THEN 'a' ELSE 'B' END||lpad(g::text,4,'0')||'-_=+/'
  FROM generate_series(1,130) g;
 UPDATE f1b_mail SET received_at=t;  -- all inside one minute, one receivedDateTime
 ids:=ARRAY(SELECT id FROM f1b_mail ORDER BY received_at,id);
 -- Byte order puts every upper-case 'B' id before every lower-case 'a' id,
 -- where a linguistic order would interleave them.
 IF NOT (ids[1] LIKE 'AAMkAGB%' AND ids[65] LIKE 'AAMkAGB%' AND ids[66] LIKE 'AAMkAGa%') THEN
  RAISE EXCEPTION 'f1b fixture ids do not exercise byte order %',ids[1:3]; END IF;

 -- Run 1: four pages, each recorded as the poller will record it.
 r:=public.record_capture_run(jsonb_build_object('source','outlook_cursor_test','window_from',t-interval '10 minutes'));
 run1:=(r->>'run_id')::uuid;
 FOR p IN 1..4 LOOP
  r:=public.record_capture_run(jsonb_build_object('run_id',run1,'source','outlook_cursor_test','window_to',t,'window_end_id',ids[p*25],
   'counts',jsonb_build_object('seen',p*25,'inserted',p*25)));
 END LOOP;
 r:=public.record_capture_run(jsonb_build_object('run_id',run1,'source','outlook_cursor_test','status','succeeded','counts',jsonb_build_object('seen',100,'inserted',100,'backlog',1)));
 SELECT * INTO rec FROM public.context_capture_runs WHERE id=run1;
 IF rec.status<>'succeeded' OR rec.window_to<>t OR rec.window_end_id IS DISTINCT FROM ids[100] THEN RAISE EXCEPTION 'f1b run 1 pair cursor %',to_jsonb(rec); END IF;

 -- Run 2 starts exactly at the stored pair: exactly the last 30, in order.
 remaining:=ARRAY(SELECT m.id FROM f1b_mail m, public.context_capture_runs c WHERE c.id=run1
  AND (m.received_at,m.id)>(c.window_to,c.window_end_id) ORDER BY m.received_at,m.id);
 IF remaining IS DISTINCT FROM ids[101:130] THEN RAISE EXCEPTION 'f1b run 2 would insert % messages, not the last 30',cardinality(remaining); END IF;
 IF (SELECT count(*) FROM f1b_mail m WHERE m.received_at>rec.window_to)<>0
  OR (SELECT count(*) FROM f1b_mail m WHERE m.received_at>=rec.window_to-interval '10 minutes')<>130
 THEN RAISE EXCEPTION 'f1b fixture: the time alone must skip or re-read'; END IF;

 -- A finished run is immutable, window_end_id included; an identical repeat is harmless.
 r:=public.record_capture_run(jsonb_build_object('run_id',run1,'source','outlook_cursor_test','status','succeeded','window_end_id',ids[100]));
 IF r->>'outcome'<>'unchanged' THEN RAISE EXCEPTION 'f1b identical finished repeat %',r; END IF;
 BEGIN
  PERFORM public.record_capture_run(jsonb_build_object('run_id',run1,'source','outlook_cursor_test','window_end_id',ids[130]));
  RAISE EXCEPTION 'f1b finished run accepted a new id' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'capture_run_finished' THEN RAISE; END IF; END;

 -- The id belongs to its time: moving window_to without an id clears it,
 -- restating the same window_to keeps it, an explicit null clears it.
 r:=public.record_capture_run(jsonb_build_object('source','outlook_cursor_test','window_to',t,'window_end_id',ids[5]));
 PERFORM public.record_capture_run(jsonb_build_object('run_id',(r->>'run_id')::uuid,'source','outlook_cursor_test','window_to',t,'counts','{"seen":5}'::jsonb));
 SELECT * INTO rec FROM public.context_capture_runs WHERE id=(r->>'run_id')::uuid;
 IF rec.window_end_id IS DISTINCT FROM ids[5] THEN RAISE EXCEPTION 'f1b same window_to dropped the id'; END IF;
 PERFORM public.record_capture_run(jsonb_build_object('run_id',(r->>'run_id')::uuid,'source','outlook_cursor_test','window_to',t+interval '1 minute'));
 SELECT * INTO rec FROM public.context_capture_runs WHERE id=(r->>'run_id')::uuid;
 IF rec.window_end_id IS NOT NULL OR rec.window_to<>t+interval '1 minute' THEN RAISE EXCEPTION 'f1b a moved window_to kept a stale id %',to_jsonb(rec); END IF;
 PERFORM public.record_capture_run(jsonb_build_object('run_id',(r->>'run_id')::uuid,'source','outlook_cursor_test','window_end_id',ids[9]));
 PERFORM public.record_capture_run(jsonb_build_object('run_id',(r->>'run_id')::uuid,'source','outlook_cursor_test','window_end_id',NULL));
 SELECT * INTO rec FROM public.context_capture_runs WHERE id=(r->>'run_id')::uuid;
 IF rec.window_end_id IS NOT NULL THEN RAISE EXCEPTION 'f1b explicit null did not clear the id'; END IF;

 -- Refusals: an id with no window_to, message text, an overlong id, a number.
 FOR bad, expected IN SELECT payload, code FROM (VALUES
   ('{"source":"outlook_cursor_test","window_end_id":"AAMkAGa0001"}'::jsonb,'capture_run_invalid'),
   ('{"source":"outlook_cursor_test","window_to":"2026-09-23T02:14:00Z","window_end_id":"Hi, can you come Friday?"}'::jsonb,'capture_run_invalid'),
   (jsonb_build_object('source','outlook_cursor_test','window_to','2026-09-23T02:14:00Z','window_end_id',repeat('A',513)),'capture_run_invalid'),
   ('{"source":"outlook_cursor_test","window_to":"2026-09-23T02:14:00Z","window_end_id":12345}'::jsonb,'capture_run_invalid')) AS x(payload,code) LOOP
  BEGIN
   PERFORM public.record_capture_run(bad);
   RAISE EXCEPTION 'f1b run accepted %',bad USING ERRCODE='ZX001';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>expected THEN RAISE; END IF; END;
 END LOOP;
 IF (SELECT count(*) FROM public.context_capture_runs)-before_runs<>2 THEN RAISE EXCEPTION 'f1b refused calls wrote rows'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 8. Callers that never send window_end_id see F1's behaviour: the GHL
-- reconciler's page and finish sequence stores exactly what it did before.
DO $$
DECLARE r jsonb; run uuid; rec public.context_capture_runs;
BEGIN
 r:=public.record_capture_run('{"source":"ghl_message_reconcile","window_from":"2026-09-23T01:00:00Z","window_to":"2026-09-23T01:15:00Z"}');
 run:=(r->>'run_id')::uuid;
 PERFORM public.record_capture_run(jsonb_build_object('run_id',run,'source','ghl_message_reconcile','window_to','2026-09-23T01:20:00Z',
  'cursor',jsonb_build_object('last_message_date','2026-09-23T01:10:00Z','conversation_id','c-1'),'watermark','2026-09-23T00:45:00Z',
  'counts',jsonb_build_object('conversations_read',20,'inserted',3,'webhook_misses',3)));
 r:=public.record_capture_run(jsonb_build_object('run_id',run,'source','ghl_message_reconcile','status','succeeded'));
 SELECT * INTO rec FROM public.context_capture_runs WHERE id=run;
 IF r->>'outcome'<>'updated' OR rec.status<>'succeeded' OR rec.window_end_id IS NOT NULL OR rec.window_to<>'2026-09-23T01:20:00Z'
  OR rec.counts->>'webhook_misses'<>'3' OR rec.cursor->>'conversation_id'<>'c-1' OR rec.finished_at IS NULL
 THEN RAISE EXCEPTION 'f1b reconciler sequence changed %',to_jsonb(rec); END IF;
 IF public.record_capture_run(jsonb_build_object('run_id',run,'source','ghl_message_reconcile','status','succeeded'))->>'outcome'<>'unchanged'
 THEN RAISE EXCEPTION 'f1b reconciler repeat'; END IF;
END $$;
ROLLBACK;

-- 9. Only the intended objects moved: the core heartbeat, the business-hours
-- helpers and every F1 or later owner's block are untouched.
DO $$
DECLARE x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_core_status()','3df30c5ccf6db32c4782ba7859591b86'),
  ('public.context_business_minutes(timestamptz,timestamptz)','510dbec36291c25aa1887ade89e2ca4e'),
  ('public.context_in_business_hours(timestamptz)','70164e9d1d6aa636c4e9d54357396f16'),
  ('public.context_booking_capture_status()','155104bfb08b8b3c2f98bdec089d4ee4'),
  ('public.context_parties_status()','155104bfb08b8b3c2f98bdec089d4ee4')) AS t(sig,md5) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(x.sig)) IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'f1b moved %',x.sig; END IF;
 END LOOP;
 IF obj_description('public.context_parties_status()'::regprocedure,'pg_proc') NOT LIKE 'F1 stub.%' THEN RAISE EXCEPTION 'f1b touched an F1 stub'; END IF;
END $$;

-- 10. The F1 writer copy that C1d's contract loads to re-apply C1d is F1's
-- body byte for byte.
BEGIN;
\ir f1_record_capture_run.sql
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.record_capture_run(jsonb)'::regprocedure)<>'a85b48f9422fff111ee96093bad55c40'
 THEN RAISE EXCEPTION 'f1b f1_record_capture_run.sql is not F1''s writer'; END IF;
END $$;
ROLLBACK;
