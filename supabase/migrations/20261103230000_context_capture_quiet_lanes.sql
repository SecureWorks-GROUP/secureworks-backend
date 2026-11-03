-- C1 (finish line row C1, 3 Nov 2026): every capture lane live, with an alarm if it goes quiet.
-- capture_sources (context_source_freshness, in context_pipeline_status) judged only business_events
-- writers, by rate: a source is quiet after 120 business minutes only while it writes 2.5 rows or more
-- per business hour. Texts (ghl-message-reconcile) and emails (outlook-mail-capture) pass that rate;
-- calls (ghl-call-transcript, 2.38 an hour on 3 Nov) did not, and Xero, quotes, bookings and documents
-- were not listed at all. Their records land in their own tables.
-- This adds:
--   * seven record sources, read from their own tables: xero/bills and xero/invoices (xero_invoices
--     ACCPAY / ACCREC created_at), xero/payments (xero_settlement_evidence captured_at), quotes/sent
--     (job_documents quote sent_at), bookings/crew (job_assignments created_at, not ghost),
--     documents/files (job_documents created_at) and documents/photos (job_media created_at);
--   * policy quiet_limits: each of those, and calls, is quiet after a fixed number of business minutes
--     (Mon-Sat 07:00-18:00 Perth). Limits measured on production over the 28 days to 3 Nov 06:30Z:
--     1.25 times the longest gap between arrivals, rounded up to half a business day (330 minutes).
--     Calls keep the rate rule too; the record sources are judged by their limit alone;
--   * alarm_armed on every source row, and lanes: one line per owner lane (texts, calls, emails, xero,
--     quotes, bookings, documents) with live, alarm_armed, last arrival and the quiet, unarmed or missing
--     sources.
-- A quiet source raises the existing capture_quiet alarm, the same way texts and emails do, with its own
-- what_to_do, lane and quiet_after_business_minutes; the composer carries it to context_pipeline_status
-- alarms. Nothing else changes: the rate rule, its thresholds, exemptions, flags, handovers and the other
-- rows keep their values (each row gains alarm_armed; lane members gain lane). No data, schedule, flag or
-- grant is written. Owner, privileges, SECURITY DEFINER and search_path are kept (CREATE OR REPLACE).
-- Guard: both functions must be the live definitions read 3 Nov 2026 (md5 of pg_get_functiondef,
-- policy 99b406e2, freshness 94ed3bbd) or already this file's result; re-apply changes nothing.
-- Rollback: supabase/rollbacks/20261103230000_context_capture_quiet_lanes_down.sql.

DO $guard$
DECLARE d text;
BEGIN
 PERFORM set_config('lock_timeout','5s',true);
 PERFORM set_config('statement_timeout','60s',true);
 SELECT md5(pg_get_functiondef('public.context_source_freshness_policy()'::regprocedure)) INTO d;
 IF d IS NULL OR d NOT IN ('99b406e26bec8e15a9b7bf5006ec0bfd', '1edadacbac4d135f143551a739ca4939') THEN
  RAISE EXCEPTION 'capture_quiet_lanes_preimage_mismatch: public.context_source_freshness_policy() is not a definition this file was written against (md5 %)', d;
 END IF;
 SELECT md5(pg_get_functiondef('public.context_source_freshness()'::regprocedure)) INTO d;
 IF d IS NULL OR d NOT IN ('94ed3bbdf9b58eb990166e8a768cf573', '6e7d1ca399b4d56c1bd0868b9ebf9f09') THEN
  RAISE EXCEPTION 'capture_quiet_lanes_preimage_mismatch: public.context_source_freshness() is not a definition this file was written against (md5 %)', d;
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
  'flag_gated_sources',jsonb_build_array(jsonb_build_object('source','ghl-call-transcript','flag','ghl_call_transcript_fetch_v1')),
  -- C1 (finish line, 3 Nov 2026): the seven capture lanes the owner named and
  -- the sources that make each one up. A lane is live when every one of its
  -- sources is listed and not quiet; its alarm is armed when every one of its
  -- sources can raise capture_quiet (by rate or by a quiet limit, not exempt).
  'lanes',jsonb_build_array(
   jsonb_build_object('lane','texts','sources',jsonb_build_array('ghl-message-reconcile')),
   jsonb_build_object('lane','calls','sources',jsonb_build_array('ghl-call-transcript')),
   jsonb_build_object('lane','emails','sources',jsonb_build_array('outlook-mail-capture')),
   jsonb_build_object('lane','xero','sources',jsonb_build_array('xero/bills','xero/invoices','xero/payments')),
   jsonb_build_object('lane','quotes','sources',jsonb_build_array('quotes/sent')),
   jsonb_build_object('lane','bookings','sources',jsonb_build_array('bookings/crew')),
   jsonb_build_object('lane','documents','sources',jsonb_build_array('documents/files','documents/photos'))),
  -- Quiet limits in business minutes (Mon-Sat 07:00-18:00 Perth), measured on
  -- production over the 28 days to 3 Nov 2026 06:30Z: the limit is 1.25 times
  -- the longest gap between arrivals, rounded up to half a business day (330);
  -- expected_gap is the 95th percentile gap. A source whose reads is not
  -- business_events is read from that table by context_source_freshness() and
  -- judged by its limit alone. It is listed even with no row in the lookback;
  -- like every source it is then not quiet (no last row to be quiet since),
  -- and its lane reads not live with it under missing_sources. A
  -- business_events source with a limit (calls) is quiet by the rate rule or
  -- by its limit, whichever comes first.
  -- xero/payments: gaps are those between Xero payment changes
  -- (provider_updated_at); the copy also rewrites every row at its daily full
  -- re-read, so a working copy is never a day without a row.
  'quiet_limits',jsonb_build_array(
   jsonb_build_object('source','ghl-call-transcript','reads','business_events',
    'expected_gap_business_minutes',99,'longest_gap_business_minutes',688,'quiet_after_business_minutes',990,
    'what_to_do','No call transcript has arrived for longer than usual. Check the transcript fetcher (transcript_capture block) and that GoHighLevel is still logging calls.'),
   jsonb_build_object('source','xero/bills','reads','xero_invoices ACCPAY created_at',
    'expected_gap_business_minutes',274,'longest_gap_business_minutes',910,'quiet_after_business_minutes',1320,
    'what_to_do','No new supplier bill has been copied from Xero for longer than usual. Check that the 15-minute xero-invoice-sync run reaches its end (a sync_invoices row in webhook_log every run) and that the Xero connection is valid.'),
   jsonb_build_object('source','xero/invoices','reads','xero_invoices ACCREC created_at',
    'expected_gap_business_minutes',509,'longest_gap_business_minutes',1412,'quiet_after_business_minutes',1980,
    'what_to_do','No new customer invoice has been copied from Xero for longer than usual. Check that the 15-minute xero-invoice-sync run reaches its end (a sync_invoices row in webhook_log every run) and that the Xero connection is valid.'),
   jsonb_build_object('source','xero/payments','reads','xero_settlement_evidence captured_at',
    'expected_gap_business_minutes',653,'longest_gap_business_minutes',1032,'quiet_after_business_minutes',1320,
    'what_to_do','Xero payments have not been copied for longer than usual. The copy runs at the end of the 15-minute xero-invoice-sync run, with a full re-read every day: check that the run reaches its end (a sync_invoices row in webhook_log) and that the settlement_evidence cursor in xero_sync_state moves.'),
   jsonb_build_object('source','quotes/sent','reads','job_documents quote sent_at',
    'expected_gap_business_minutes',775,'longest_gap_business_minutes',1555,'quiet_after_business_minutes',1980,
    'what_to_do','No quote has been sent to a customer for longer than usual. Check that the quote tools can send (send-quote) and that quotes are not stuck waiting.'),
   jsonb_build_object('source','bookings/crew','reads','job_assignments created_at, not ghost',
    'expected_gap_business_minutes',365,'longest_gap_business_minutes',1157,'quiet_after_business_minutes',1650,
    'what_to_do','No crew booking has been made for longer than usual. Check that the schedule screen can save a booking.'),
   jsonb_build_object('source','documents/files','reads','job_documents created_at',
    'expected_gap_business_minutes',246,'longest_gap_business_minutes',959,'quiet_after_business_minutes',1320,
    'what_to_do','No document has been filed on a job for longer than usual. Check uploads from the staff app and the tools that file quotes, invoices and reports.'),
   jsonb_build_object('source','documents/photos','reads','job_media created_at',
    'expected_gap_business_minutes',149,'longest_gap_business_minutes',1089,'quiet_after_business_minutes',1650,
    'what_to_do','No photo has been filed on a job for longer than usual. Check photo uploads from the crew and staff apps.')))
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
 limits jsonb:=coalesce(policy->'quiet_limits','[]'::jsonb); lanes jsonb;
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
 ), records AS (
  -- C1: lanes whose evidence lands in its own table, not business_events. The
  -- reads are fixed here; the names, limits and wording are in the policy.
  SELECT 'xero/bills'::text AS source, x.created_at AS at FROM public.xero_invoices x
   WHERE x.invoice_type='ACCPAY' AND x.created_at>now_time-lookback AND x.created_at<=now_time
  UNION ALL
  SELECT 'xero/invoices', x.created_at FROM public.xero_invoices x
   WHERE x.invoice_type='ACCREC' AND x.created_at>now_time-lookback AND x.created_at<=now_time
  UNION ALL
  SELECT 'xero/payments', s.captured_at FROM public.xero_settlement_evidence s
   WHERE s.captured_at>now_time-lookback AND s.captured_at<=now_time
  UNION ALL
  SELECT 'quotes/sent', d.sent_at FROM public.job_documents d
   WHERE d.type='quote' AND d.sent_at>now_time-lookback AND d.sent_at<=now_time
  UNION ALL
  -- Ghost rows are the observer seats made with a real booking, not bookings.
  SELECT 'bookings/crew', a.created_at FROM public.job_assignments a
   WHERE coalesce(a.is_ghost,false)=false AND a.created_at>now_time-lookback AND a.created_at<=now_time
  UNION ALL
  SELECT 'documents/files', d.created_at FROM public.job_documents d
   WHERE d.created_at>now_time-lookback AND d.created_at<=now_time
  UNION ALL
  SELECT 'documents/photos', m.created_at FROM public.job_media m
   WHERE m.created_at>now_time-lookback AND m.created_at<=now_time
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
  -- A record source (C1) is always listed, before its first row too; no rate.
  UNION ALL
  SELECT x->>'source',r.last_at,NULL::bigint,NULL::integer,
   CASE WHEN r.last_at IS NOT NULL THEN public.context_business_minutes(r.last_at,now_time) END
  FROM jsonb_array_elements(limits) x
  LEFT JOIN LATERAL (SELECT max(rc.at) AS last_at FROM records rc WHERE rc.source=x->>'source') r ON true
  WHERE x->>'reads' IS DISTINCT FROM 'business_events'
 ), judged AS (
  SELECT m.*,
   CASE WHEN m.window_business_minutes>0 THEN round(m.rows_in_business_hours/(m.window_business_minutes/60.0),2) END AS rows_per_business_hour,
   (SELECT x->'flag' FROM jsonb_array_elements(gated) x WHERE x->>'source'=m.source) AS flag,
   (SELECT x FROM jsonb_array_elements(limits) x WHERE x->>'source'=m.source LIMIT 1) AS lim,
   (SELECT l->>'lane' FROM jsonb_array_elements(coalesce(policy->'lanes','[]'::jsonb)) l WHERE l->'sources' ? m.source LIMIT 1) AS lane
  FROM measured m
 ), flagged AS (
  SELECT j.*, coalesce(j.rows_per_business_hour>=min_rate,false) AS normally_active,
   (coalesce(j.rows_per_business_hour>=min_rate,false) AND coalesce(j.quiet_business_minutes>=quiet_minutes,false))
   -- C1: a source with a quiet limit is also quiet once silent that long.
   OR (j.lim IS NOT NULL AND coalesce(j.quiet_business_minutes>=(j.lim->>'quiet_after_business_minutes')::integer,false)) AS quiet,
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
   'normally_active',f.normally_active,'quiet',f.quiet,'alarm_exempt',f.alarm_exempt,
   'alarm_armed',(f.normally_active OR f.lim IS NOT NULL) AND f.alarm_exempt IS NULL)
   ||CASE WHEN f.flag IS NOT NULL THEN jsonb_build_object('flag',f.flag) ELSE '{}'::jsonb END
   ||CASE WHEN f.handover_to IS NOT NULL THEN jsonb_build_object('handover',jsonb_build_object('replaced_by',f.handover_to,'handed_over',handed_over))
     ELSE '{}'::jsonb END
   ||CASE WHEN f.lane IS NOT NULL THEN jsonb_build_object('lane',f.lane) ELSE '{}'::jsonb END
   ||CASE WHEN f.lim IS NOT NULL THEN jsonb_build_object('reads',f.lim->>'reads',
     'expected_gap_business_minutes',(f.lim->>'expected_gap_business_minutes')::integer,
     'quiet_after_business_minutes',(f.lim->>'quiet_after_business_minutes')::integer) ELSE '{}'::jsonb END
   ORDER BY f.source COLLATE "C"),'[]'::jsonb),
  coalesce(jsonb_agg(jsonb_build_object('key','capture_quiet','severity','warning','since',f.last_at,'source',f.source,
   'quiet_business_minutes',f.quiet_business_minutes,'rows_per_business_hour',f.rows_per_business_hour,
   'what_to_do',coalesce(f.lim->>'what_to_do','Evidence from this source has stopped arriving. Check that its writer (function, cron job or webhook) is running, that its provider credentials are valid, and that the capture lane is on.'))
   ||CASE WHEN f.lane IS NOT NULL THEN jsonb_build_object('lane',f.lane) ELSE '{}'::jsonb END
   ||CASE WHEN f.lim IS NOT NULL THEN jsonb_build_object('quiet_after_business_minutes',(f.lim->>'quiet_after_business_minutes')::integer)
     ELSE '{}'::jsonb END
   ORDER BY f.source COLLATE "C") FILTER (WHERE f.quiet AND f.alarm_exempt IS NULL),'[]'::jsonb)
 INTO sources, alarms FROM flagged f;
 -- C1: one line per owner lane. Live: every source listed, with a row in the
 -- lookback, and not quiet. Alarm armed: every source listed and able to raise
 -- capture_quiet. Missing: not listed, or no row in the lookback.
 SELECT coalesce(jsonb_agg(jsonb_build_object('lane',z.lane,'sources',z.members,'live',z.live,'alarm_armed',z.armed,
   'last_captured_at',z.newest,'quiet_sources',z.quiet_sources,'unarmed_sources',z.unarmed_sources,
   'missing_sources',z.missing_sources) ORDER BY z.ord),'[]'::jsonb)
 INTO lanes
 FROM (
  SELECT l.ord, l.v->>'lane' AS lane, l.v->'sources' AS members,
   bool_and(s.v IS NOT NULL AND s.v->>'last_captured_at' IS NOT NULL AND s.v->'quiet'='false'::jsonb) AS live,
   bool_and(s.v IS NOT NULL AND s.v->'alarm_armed'='true'::jsonb) AS armed,
   max((s.v->>'last_captured_at')::timestamptz) AS newest,
   coalesce(jsonb_agg(m.name ORDER BY m.ord) FILTER (WHERE s.v->'quiet'='true'::jsonb),'[]'::jsonb) AS quiet_sources,
   coalesce(jsonb_agg(m.name ORDER BY m.ord) FILTER (WHERE s.v IS NOT NULL AND s.v->'alarm_armed' IS DISTINCT FROM 'true'::jsonb),'[]'::jsonb) AS unarmed_sources,
   coalesce(jsonb_agg(m.name ORDER BY m.ord) FILTER (WHERE s.v IS NULL OR s.v->>'last_captured_at' IS NULL),'[]'::jsonb) AS missing_sources
  FROM jsonb_array_elements(coalesce(policy->'lanes','[]'::jsonb)) WITH ORDINALITY l(v,ord)
  CROSS JOIN LATERAL jsonb_array_elements_text(l.v->'sources') WITH ORDINALITY m(name,ord)
  LEFT JOIN LATERAL (SELECT x AS v FROM jsonb_array_elements(sources) x WHERE x->>'source'=m.name LIMIT 1) s ON true
  GROUP BY l.ord, l.v
 ) z;
 RETURN jsonb_build_object('as_of',now_time,'policy',policy,'in_business_hours',public.context_in_business_hours(now_time),
  'capture_lane',public.automation_lane_enabled('capture'),'sources',sources,'lanes',lanes,'alarms',alarms);
END $function$
;

COMMENT ON FUNCTION public.context_source_freshness() IS 'Status block capture_sources: last context_captured_at per business_events.source, business minutes since, and the capture_quiet alarm for a normally active source that wrote nothing for 2 business hours. Retired sources (transcribe-call, ghl_sms_cache_backfill) and action logs (mcp_agent) never alarm; the old monitor-inbox path''s three writer names do not alarm while the email reader''s flags reader, schedule and program are all on (handover_sources; with any off the old path writes again and they alarm); flag-gated sources (ghl-call-transcript) are always listed and alarm only while their flag is on (F1b; lanes health 20261006050000). C1 (20261103230000): also xero/bills, xero/invoices, xero/payments, quotes/sent, bookings/crew, documents/files and documents/photos, read from their own tables, and calls (ghl-call-transcript), each quiet after a fixed limit in business minutes (policy quiet_limits); every row says alarm_armed; lanes gives one line per owner lane (texts, calls, emails, xero, quotes, bookings, documents) with live and alarm_armed. Owned by F1.';

DO $check$
DECLARE d text;
BEGIN
 PERFORM set_config('lock_timeout','5s',true);
 PERFORM set_config('statement_timeout','60s',true);
 SELECT md5(pg_get_functiondef('public.context_source_freshness_policy()'::regprocedure)) INTO d;
 IF d IS NULL OR d NOT IN ('1edadacbac4d135f143551a739ca4939') THEN
  RAISE EXCEPTION 'capture_quiet_lanes_postimage_mismatch: public.context_source_freshness_policy() is not a definition this file was written against (md5 %)', d;
 END IF;
 SELECT md5(pg_get_functiondef('public.context_source_freshness()'::regprocedure)) INTO d;
 IF d IS NULL OR d NOT IN ('6e7d1ca399b4d56c1bd0868b9ebf9f09') THEN
  RAISE EXCEPTION 'capture_quiet_lanes_postimage_mismatch: public.context_source_freshness() is not a definition this file was written against (md5 %)', d;
 END IF;
END $check$;
