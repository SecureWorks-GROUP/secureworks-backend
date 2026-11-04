-- Undo 20261103230000_context_capture_quiet_lanes: put back the capture_sources policy and block exactly as read live on 3 Nov 2026
-- (md5 of pg_get_functiondef: policy 99b406e26bec8e15a9b7bf5006ec0bfd, freshness 94ed3bbdf9b58eb990166e8a768cf573) and the old comment.
-- After this, Xero, quotes, bookings and documents are no longer listed or alarmed, and calls alarm
-- only while their rate is 2.5 rows per business hour or more.
DO $guard$
DECLARE d text;
BEGIN
 PERFORM set_config('lock_timeout','5s',true);
 PERFORM set_config('statement_timeout','60s',true);
 SELECT md5(pg_get_functiondef('public.context_source_freshness_policy()'::regprocedure)) INTO d;
 IF d IS NULL OR d NOT IN ('1edadacbac4d135f143551a739ca4939', '99b406e26bec8e15a9b7bf5006ec0bfd') THEN
  RAISE EXCEPTION 'capture_quiet_lanes_rollback_preimage_mismatch: public.context_source_freshness_policy() is not a definition this file was written against (md5 %)', d;
 END IF;
 SELECT md5(pg_get_functiondef('public.context_source_freshness()'::regprocedure)) INTO d;
 IF d IS NULL OR d NOT IN ('6e7d1ca399b4d56c1bd0868b9ebf9f09', '94ed3bbdf9b58eb990166e8a768cf573') THEN
  RAISE EXCEPTION 'capture_quiet_lanes_rollback_preimage_mismatch: public.context_source_freshness() is not a definition this file was written against (md5 %)', d;
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.context_source_freshness_policy()
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
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
  -- AI evaluation records are not captured business messages. Exclude by row
  -- type, not source, so mixed writers still reveal stopped business capture.
  'ignored_capture_event_types',jsonb_build_array('ai.canary_result'),
  -- Writers that have stopped for good: listed while they have rows in the
  -- lookback, never alarmed. transcribe-call is the Whisper path (transcripts
  -- slice T0 stops it; T5 deletes it). ghl_sms_cache_backfill (a Jarvis
  -- cache copier) was replaced by the 15-minute GHL reconciler (lanes
  -- health, 20261006050000).
  'retired_sources',jsonb_build_array(
   jsonb_build_object('source','transcribe-call','replaced_by','ghl-call-transcript'),
   jsonb_build_object('source','ghl_sms_cache_backfill','replaced_by','ghl-message-reconcile')),
  -- Writers handed over to another, reversibly: listed, and not alarmed only
  -- while the handover holds. The old monitor-inbox path (its three writer
  -- names) writes no email evidence row while the email reader's flags
  -- reader, schedule and program are all on (context_email_reader_flags(),
  -- read exactly as monitor-inbox/reader_handover.ts readerOwnsEvidence
  -- reads it; on since 5 Oct 2026). With any of them off, missing or
  -- unreadable the old path writes again, and its names alarm as any
  -- capture source does (20261006050000).
  'handover_sources',jsonb_build_array(
   jsonb_build_object('source','monitor-inbox','replaced_by','outlook-mail-capture'),
   jsonb_build_object('source','monitor-inbox-group','replaced_by','outlook-mail-capture'),
   jsonb_build_object('source','monitor_inbox','replaced_by','outlook-mail-capture')),
  'handover_flags','context_email_reader_flags(): reader, schedule and program all on',
  -- Writers that log actions people or agents took, not a capture lane:
  -- always judged and listed, never alarmed (20261006050000).
  'action_log_sources',jsonb_build_array(
   jsonb_build_object('source','mcp_agent','logs','actions agents take through ops-api')),
  -- Writers that only run while a feature flag is on: always listed, alarmed
  -- only while the flag is on. A missing or unreadable flag reads as off.
  'flag_gated_sources',jsonb_build_array(jsonb_build_object('source','ghl-call-transcript','flag','ghl_call_transcript_fetch_v1')))
$function$
;

CREATE OR REPLACE FUNCTION public.context_source_freshness()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 policy jsonb:=public.context_source_freshness_policy();
 quiet_minutes integer:=(policy->>'quiet_business_minutes')::integer;
 min_rate numeric:=(policy->>'normally_active_min_rows_per_business_hour')::numeric;
 rate_window interval:=make_interval(days=>(policy->>'rate_window_days')::integer);
 lookback interval:=make_interval(days=>(policy->>'lookback_days')::integer);
 now_time timestamptz:=now(); sources jsonb; alarms jsonb;
 retired text[]:=ARRAY(SELECT x->>'source' FROM jsonb_array_elements(policy->'retired_sources') x);
 logs text[]:=ARRAY(SELECT x->>'source' FROM jsonb_array_elements(coalesce(policy->'action_log_sources','[]'::jsonb)) x);
 handover jsonb:=coalesce(policy->'handover_sources','[]'::jsonb); reader_flags jsonb; handed_over boolean:=false;
 gated jsonb:='[]'::jsonb; g jsonb; on_flag boolean; changed timestamptz; flag_state text;
BEGIN
 -- The old email path stands down only while the reader's three flags are
 -- all on, exactly as monitor-inbox reads them (readerOwnsEvidence: each
 -- strictly true). Fails closed: an error reads as not handed over, so the
 -- old path's names are judged like any capture source.
 BEGIN
  reader_flags:=public.context_email_reader_flags();
  handed_over:=coalesce(reader_flags->'reader'='true'::jsonb AND reader_flags->'schedule'='true'::jsonb
   AND reader_flags->'program'='true'::jsonb,false);
 EXCEPTION WHEN OTHERS THEN handed_over:=false;
 END;
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
   AND coalesce(e.event_type,'') NOT IN (SELECT jsonb_array_elements_text(policy->'ignored_capture_event_types'))
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
        WHEN j.handover_to IS NOT NULL AND handed_over THEN 'handed_over'
        WHEN j.source=ANY(logs) THEN 'action_log'
        WHEN j.flag IS NOT NULL AND (j.flag->>'enabled')::boolean IS NOT TRUE THEN 'flag_off' END AS alarm_exempt
  FROM (SELECT j0.*, (SELECT x->>'replaced_by' FROM jsonb_array_elements(handover) x WHERE x->>'source'=j0.source LIMIT 1) AS handover_to
   FROM judged j0) j
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('source',f.source,'last_captured_at',f.last_at,
   'quiet_business_minutes',f.quiet_business_minutes,'rows_in_business_hours',f.rows_in_business_hours,
   'rate_window_business_minutes',f.window_business_minutes,'rows_per_business_hour',f.rows_per_business_hour,
   'normally_active',f.normally_active,'quiet',f.quiet,'alarm_exempt',f.alarm_exempt)
   ||CASE WHEN f.flag IS NOT NULL THEN jsonb_build_object('flag',f.flag) ELSE '{}'::jsonb END
   ||CASE WHEN f.handover_to IS NOT NULL THEN jsonb_build_object('handover',jsonb_build_object('replaced_by',f.handover_to,'handed_over',handed_over))
     ELSE '{}'::jsonb END ORDER BY f.source COLLATE "C"),'[]'::jsonb),
  coalesce(jsonb_agg(jsonb_build_object('key','capture_quiet','severity','warning','since',f.last_at,'source',f.source,
   'quiet_business_minutes',f.quiet_business_minutes,'rows_per_business_hour',f.rows_per_business_hour,
   'what_to_do','Evidence from this source has stopped arriving. Check that its writer (function, cron job or webhook) is running, that its provider credentials are valid, and that the capture lane is on.')
   ORDER BY f.source COLLATE "C") FILTER (WHERE f.quiet AND f.alarm_exempt IS NULL),'[]'::jsonb)
 INTO sources, alarms FROM flagged f;
 RETURN jsonb_build_object('as_of',now_time,'policy',policy,'in_business_hours',public.context_in_business_hours(now_time),
  'capture_lane',public.automation_lane_enabled('capture'),'sources',sources,'alarms',alarms);
END $function$
;

COMMENT ON FUNCTION public.context_source_freshness() IS 'Status block capture_sources: last context_captured_at per business_events.source, business minutes since, and the capture_quiet alarm for a normally active source that wrote nothing for 2 business hours. Retired sources (transcribe-call, ghl_sms_cache_backfill) and action logs (mcp_agent) never alarm; the old monitor-inbox path''s three writer names do not alarm while the email reader''s flags reader, schedule and program are all on (handover_sources; with any off the old path writes again and they alarm); flag-gated sources (ghl-call-transcript) are always listed and alarm only while their flag is on (F1b; lanes health 20261006050000). Owned by F1.';

DO $check$
DECLARE d text;
BEGIN
 PERFORM set_config('lock_timeout','5s',true);
 PERFORM set_config('statement_timeout','60s',true);
 SELECT md5(pg_get_functiondef('public.context_source_freshness_policy()'::regprocedure)) INTO d;
 IF d IS NULL OR d NOT IN ('99b406e26bec8e15a9b7bf5006ec0bfd') THEN
  RAISE EXCEPTION 'capture_quiet_lanes_rollback_postimage_mismatch: public.context_source_freshness_policy() is not a definition this file was written against (md5 %)', d;
 END IF;
 SELECT md5(pg_get_functiondef('public.context_source_freshness()'::regprocedure)) INTO d;
 IF d IS NULL OR d NOT IN ('94ed3bbdf9b58eb990166e8a768cf573') THEN
  RAISE EXCEPTION 'capture_quiet_lanes_rollback_postimage_mismatch: public.context_source_freshness() is not a definition this file was written against (md5 %)', d;
 END IF;
END $check$;
