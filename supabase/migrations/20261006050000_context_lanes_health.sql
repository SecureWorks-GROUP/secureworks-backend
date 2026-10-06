-- Lanes health (6 Oct 2026, ops/lanes-diagnosis.md; review rounds 1 to 3):
-- the capture status checks stop raising four false alarms, and the email
-- reader's attachment ledger can record a failure, a group file Microsoft
-- sent without its bytes, and a file another copy of the email already
-- stored. No flag, switch, cron job or evidence row changes.
--
-- Why, from the read-only diagnosis of production on 6 Oct 2026:
--  * capture_quiet on monitor-inbox: the old email path handed over to the
--    email reader on purpose at 08:49 Perth on 5 Oct (flags email_reader_v1
--    and email_reader_schedule_v1); with them on it writes no email evidence
--    rows (monitor-inbox/reader_handover.ts). Same for its group reader and
--    the older monitor_inbox writer name.
--  * capture_quiet on ghl_sms_cache_backfill: a Jarvis helper copying texts
--    out of a cache filled when an agent synced a conversation; the 15-minute
--    GHL reconciler reads GHL itself and replaced it (last row 30 Sep).
--  * capture_quiet on mcp_agent: a log of actions agents take through ops-api
--    (status updates, invoices sent, stage moves), not a capture lane. A
--    one-off bulk of 301 stage moves made it look normally active.
--  * email_poll_missed on admin@ and finance@: the first nightly sweep re-read
--    48 hours that began before the reader's first poll and counted 5 older
--    emails as missed by the poll.
--  * ghl_webhooks_quiet counts only GHL app events, which have never arrived
--    (the app is not built yet), so it cannot say whether GHL talks to us at
--    all; the CallCompleted, CustomerReplied and UserReplied workflow posts
--    (doorbells) do arrive, about 8 a business day, with quiet spells of up
--    to 915 business minutes (a Saturday with no call) from 7 May to 6 Oct.
--    One 120-minute limit over both would ring for 39% of business time
--    while GHL is healthy (review round 3).
--  * Group mailbox attachments: 0 files saved from any group, and a failure
--    left no row, so every poll asked Microsoft again (finance@ 85, ses@ 89,
--    patios@ 67, fencing@ 7 failed attempts since 5 Oct). The reader fix is
--    in outlook-mail-capture (graph.ts, attachments.ts); the ledger needs two
--    statuses and a code column for it.
--
-- What it does:
--  1. context_email_attachments: status may also be skipped_no_content (a
--     group file Microsoft sent without its bytes; it cannot be fetched
--     another way with the reader's app login), skipped_duplicate (a file
--     whose bytes are already stored for the same email from another mailbox
--     copy, a group post and a member's own copy; the row carries that
--     sha256 and no file) and failed (a list, download or upload that
--     failed), with the new column error_code, set exactly on failed rows
--     (code shape as the run rows' error codes). A failed row is keyed
--     sha-256 of "failed:" plus the attachment's own key (or of
--     "failed:list"), written once; polls do not retry it, the nightly sweep
--     and history runs do. Stored and skipped rows are unchanged.
--  2. context_source_freshness_policy(): ghl_sms_cache_backfill retired
--     (replaced by ghl-message-reconcile); a new list handover_sources:
--     monitor-inbox, monitor-inbox-group and monitor_inbox (replaced by
--     outlook-mail-capture while the email reader's three flags are on); and
--     a new list action_log_sources: mcp_agent.
--  3. context_source_freshness(): F1b's body plus alarm_exempt 'action_log'
--     for the action-log list and 'handed_over' for a handover source while
--     context_email_reader_flags() reports reader, schedule and program all
--     on (exactly when monitor-inbox/reader_handover.ts stops the old path's
--     evidence rows; any off, missing or unreadable, and the old path writes
--     again and its names alarm), and the two text sorts byte-ordered
--     (COLLATE "C"; source is unique, so the order is total).
--  4. context_email_capture_status_at(p_now): EM1's body plus one rule for
--     email_poll_missed: mail received before the source's first successful
--     poll (that poll's window_from) is not a poll miss. The sweep now lists
--     when each email it saved was received (cursor.miss_received_at, the
--     newest 100, a null for a time it could not read;
--     outlook-mail-capture/capture.ts sweepMissList). Every miss past the
--     list is older than its oldest time: none counts when that time is
--     before the first poll, all do otherwise; a null counts; an unreadable
--     list leaves every miss counted. A sweep that kept no list (before this
--     change) and read back before the first poll is not counted; a source
--     with no successful poll yet has nothing to have missed. The three text
--     sorts are byte-ordered.
--  5. context_ghl_capture_policy(): a new list doorbell_event_types
--     (CallCompleted, CustomerReplied, UserReplied) and a new limit
--     doorbells_quiet_business_minutes, 1320 (two business days).
--     context_ghl_capture_status(): the retry-status body (20260924210000)
--     with ghl_webhooks_quiet in two parts, each on its own limit: the
--     doorbells, always judged, quiet past 1320 business minutes since the
--     newest (or since the flag came on); the app events, judged only once
--     the app has sent its first accepted event, quiet past 120. It rings
--     when an armed part is quiet past its limit, naming the parts
--     (quiet_parts). webhooks gains last_doorbell_at and app_armed;
--     last_webhook_at and last_app_webhook_at are unchanged.
--
-- Not here: bookings. No booking lane exists yet (no GHL appointment has
-- ever been captured; context_booking_capture_status() is F1's stub).
--
-- Built on the LIVE production definitions, read 6 Oct 2026 (read-only
-- transaction, rolled back); each matched the repository body it replaces:
--   context_source_freshness_policy()            md5(prosrc) 455f0ec0a3f6c60477a68044db10a448 (F1b, 20260924152100)
--   context_source_freshness()                   md5(prosrc) b12cdb949edd17fbf636990c45c6345d (F1b)
--   context_email_capture_status_at(timestamptz) md5(prosrc) 78aefd4a54766e3e4967373e46fb934a (EM1, 20260924213000)
--   context_ghl_capture_policy()                 md5(prosrc) 4deabf30725e64f01f5778d2e853c344 (C1d, 20260924133000)
--   context_ghl_capture_status()                 md5(prosrc) ecdec7c3bc7f09cb3ea23d35ac096cd2 (20260924210000)
--   context_email_attachments: EM2's twelve columns (no error_code) and its
--     six-status check context_email_attachments_status_check
-- No open PR replaces any of them (#977, #978, #979 checked). The guard
-- refuses unless each is still that pre-image or already this migration's
-- result (a re-apply). The freshness block also calls, and does not replace,
-- EM2's context_email_reader_flags() (20261002150000); the guard requires it.
--
-- Deploy order: this migration applies before the matching outlook-mail-capture
-- (scripts/edge-function-schema-requirements.txt names error_code, so the
-- function is not deployed without it). The reader sends error_code only on a
-- failed row, so stored rows and EM2's skip reasons still record if this is
-- rolled back; its newer statuses are then refused (counted as attachment
-- errors) until the reader is rolled back too.
--
-- Rollback: supabase/rollbacks/20261006050000_context_lanes_health_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; cols text; chk text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_source_freshness_policy()',ARRAY['455f0ec0a3f6c60477a68044db10a448','0b131a763a53c21811465e04a66be539']),
  ('public.context_source_freshness()',ARRAY['b12cdb949edd17fbf636990c45c6345d','474f94e13b3be83ffe7ce6c4f5b2d774']),
  ('public.context_email_capture_status_at(timestamptz)',ARRAY['78aefd4a54766e3e4967373e46fb934a','ee6f8e5d57e41fe8c2691b59d4b51856']),
  ('public.context_ghl_capture_policy()',ARRAY['4deabf30725e64f01f5778d2e853c344','d803ce75d024366040936b4002d19b30']),
  ('public.context_ghl_capture_status()',ARRAY['ecdec7c3bc7f09cb3ea23d35ac096cd2','6c2648a6307b6f6e5a08f52fb45690d2'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF to_regclass('public.context_email_attachments') IS NULL THEN
  problems:=problems||'context_email_attachments missing (apply 20261002150000 first)'::text;
 ELSE
  SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid='public.context_email_attachments'::regclass AND a.attnum>0 AND NOT a.attisdropped AND a.attname<>'error_code';
  IF cols IS DISTINCT FROM 'id:uuid,provider_message_id:text,attachment_key:text,business_event_id:uuid,file_name:text,content_type:text,size_bytes:bigint,sha256:text,storage_bucket:text,storage_path:text,status:text,created_at:timestamp with time zone'
  THEN problems:=problems||format('context_email_attachments columns are %s',cols); END IF;
  SELECT format_type(a.atttypid,a.atttypmod) INTO chk FROM pg_attribute a
  WHERE a.attrelid='public.context_email_attachments'::regclass AND a.attname='error_code' AND NOT a.attisdropped;
  IF chk IS NOT NULL AND chk<>'text' THEN problems:=problems||format('context_email_attachments.error_code exists as %s',chk); END IF;
  SELECT pg_get_constraintdef(c.oid) INTO chk FROM pg_constraint c
  WHERE c.conrelid='public.context_email_attachments'::regclass AND c.conname='context_email_attachments_status_check';
  IF chk IS DISTINCT FROM 'CHECK ((status = ANY (ARRAY[''stored''::text, ''skipped_inline''::text, ''skipped_kind''::text, ''skipped_too_large''::text, ''skipped_message_cap''::text, ''skipped_scope''::text])))'
   AND chk IS DISTINCT FROM 'CHECK ((status = ANY (ARRAY[''stored''::text, ''skipped_inline''::text, ''skipped_kind''::text, ''skipped_too_large''::text, ''skipped_message_cap''::text, ''skipped_scope''::text, ''skipped_no_content''::text, ''skipped_duplicate''::text, ''failed''::text])))'
  THEN problems:=problems||format('context_email_attachments status check is %s',coalesce(chk,'<missing>')); END IF;
 END IF;
 IF to_regclass('public.context_capture_runs') IS NULL OR to_regclass('public.webhook_log') IS NULL
  OR to_regclass('public.monitored_mailboxes') IS NULL OR to_regprocedure('public.context_business_minutes(timestamptz,timestamptz)') IS NULL
  OR to_regprocedure('public.context_email_reader_flags()') IS NULL
 THEN problems:=problems||'context_capture_runs, webhook_log, monitored_mailboxes, context_business_minutes or context_email_reader_flags missing'::text; END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_lanes_health_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The attachment ledger: a failure and a file sent without its bytes.
ALTER TABLE public.context_email_attachments ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE public.context_email_attachments DROP CONSTRAINT IF EXISTS context_email_attachments_status_check;
ALTER TABLE public.context_email_attachments ADD CONSTRAINT context_email_attachments_status_check
 CHECK (status IN ('stored','skipped_inline','skipped_kind','skipped_too_large','skipped_message_cap','skipped_scope','skipped_no_content','skipped_duplicate','failed'));
ALTER TABLE public.context_email_attachments DROP CONSTRAINT IF EXISTS context_email_attachments_failed_code;
ALTER TABLE public.context_email_attachments ADD CONSTRAINT context_email_attachments_failed_code
 CHECK (((status='failed') = (error_code IS NOT NULL)) AND (error_code IS NULL OR error_code ~ '^[a-z0-9][a-z0-9_.:-]{0,59}$'));
COMMENT ON COLUMN public.context_email_attachments.error_code IS
 'Lanes health (20261006050000): why a failed row failed (a Graph status code such as graph_403, attachment_post_too_large, attachment_upload_failed); set exactly on status failed. Codes only, never mail text.';
COMMENT ON TABLE public.context_email_attachments IS
 'EM2: one row per attachment of a captured email (keyed by the email''s provider_message_id and sha-256 of the Graph attachment id). stored rows point at the PRIVATE bucket context-email-attachments; skipped rows say why (inline, not a file, over 15 MB, over 10 files or 30 MB per email, ses@ scope, a group file Microsoft sent without its bytes: skipped_no_content, or a file whose bytes are already stored for the same email from another mailbox copy: skipped_duplicate, with that sha256 and no file). A failed row (status failed, error_code) records a list, download or upload that failed, keyed sha-256 of "failed:" plus the attachment''s own key (or "failed:list"), written once; the nightly sweep and history runs retry it (20261006050000). Written only by the outlook-mail-capture reader. No anon or authenticated access.';

-- 2. Freshness: the policy.
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
$$;

-- 3. Freshness: F1b's body plus the action-log exemption and the handover
-- exemption, byte-ordered.
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
END $$;
COMMENT ON FUNCTION public.context_source_freshness() IS
 'Status block capture_sources: last context_captured_at per business_events.source, business minutes since, and the capture_quiet alarm for a normally active source that wrote nothing for 2 business hours. Retired sources (transcribe-call, ghl_sms_cache_backfill) and action logs (mcp_agent) never alarm; the old monitor-inbox path''s three writer names do not alarm while the email reader''s flags reader, schedule and program are all on (handover_sources; with any off the old path writes again and they alarm); flag-gated sources (ghl-call-transcript) are always listed and alarm only while their flag is on (F1b; lanes health 20261006050000). Owned by F1.';

-- 4. Email health: mail older than the source's first successful poll is not
-- a poll miss.
CREATE OR REPLACE FUNCTION public.context_email_capture_status_at(p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_email_capture_policy();
 now_time timestamptz:=coalesce(p_now,now());
 tz text:=policy->>'timezone';
 failed_n integer:=(policy->>'failed_runs_alarm')::integer;
 backlog_n integer:=(policy->>'backlog_runs_alarm')::integer;
 sweep_grace interval:=make_interval(mins=>(policy->>'sweep_grace_minutes')::integer);
 miss_lookback interval:=make_interval(hours=>(policy->>'sweep_miss_lookback_hours')::integer);
 personal text[]:=ARRAY(SELECT jsonb_array_elements_text(policy->'personal_scope_labels'));
 flag_on boolean; flag_changed timestamptz; flag_state text:='present';
 lane_on boolean; alarms_active boolean;
 sweep_at timestamptz; sweep_due boolean;
 m record; line text; src_alarms jsonb;
 poll_src text; sweep_src text;
 last_runs public.context_capture_runs[]; last_sweep public.context_capture_runs; miss_run public.context_capture_runs;
 swept boolean; since timestamptz; selected boolean; last_seen timestamptz;
 n_failed integer; n_backlog integer; misses bigint;
 first_from timestamptz; kept bigint; listed bigint; oldest timestamptz;
 per_source jsonb:='[]'::jsonb; lines jsonb; alarms jsonb;
BEGIN
 -- Flag: fails closed (no table, no row or an error reads as off).
 BEGIN
  SELECT f.enabled,f.updated_at INTO flag_on,flag_changed FROM public.feature_flags f
  WHERE f.flag_name=policy->>'flag' ORDER BY f.updated_at DESC NULLS LAST LIMIT 1;
  IF flag_on IS NULL THEN flag_state:='missing'; END IF;
 EXCEPTION WHEN OTHERS THEN flag_on:=NULL; flag_changed:=NULL; flag_state:='unreadable';
 END;
 BEGIN lane_on:=public.automation_lane_enabled('capture');
 EXCEPTION WHEN OTHERS THEN lane_on:=NULL;
 END;
 alarms_active:=coalesce(flag_on,false) AND coalesce(lane_on,false);
 -- The most recent 02:00 Perth at or before now.
 sweep_at:=((date_trunc('day',now_time AT TIME ZONE tz)+(policy->>'sweep_local_time')::time) AT TIME ZONE tz);
 IF sweep_at>now_time THEN sweep_at:=((date_trunc('day',now_time AT TIME ZONE tz)-interval '1 day'+(policy->>'sweep_local_time')::time) AT TIME ZONE tz); END IF;
 sweep_due:=now_time>=sweep_at+sweep_grace;

 -- 1. Each source's health, kept inside this function: only the per-line
 -- aggregate below leaves it.
 FOR m IN SELECT * FROM public.monitored_mailboxes LOOP
  line:=CASE WHEN m.scope_label=ANY(personal) THEN 'personal' ELSE m.scope_label END;
  selected:=m.enabled AND m.status='active';
  poll_src:='outlook_'||m.source_key; sweep_src:='outlook_sweep_'||m.source_key;
  SELECT coalesce(array_agg(c ORDER BY c.started_at DESC),'{}') INTO last_runs FROM (
   SELECT * FROM public.context_capture_runs r WHERE r.source=poll_src AND r.status<>'running' ORDER BY r.started_at DESC LIMIT greatest(failed_n,backlog_n)) c;
  SELECT count(*) FILTER (WHERE u.status='failed') INTO n_failed FROM unnest(last_runs[1:failed_n]) u;
  SELECT count(*) FILTER (WHERE (u.cursor->>'backlog')='true') INTO n_backlog FROM unnest(last_runs[1:backlog_n]) u;
  SELECT max(r.finished_at) INTO last_seen FROM public.context_capture_runs r WHERE r.source=poll_src AND r.status='succeeded';
  SELECT * INTO last_sweep FROM public.context_capture_runs r WHERE r.source=sweep_src ORDER BY r.started_at DESC LIMIT 1;
  swept:=EXISTS(SELECT 1 FROM public.context_capture_runs r WHERE r.source=sweep_src AND r.started_at>=sweep_at AND r.status='succeeded');
  -- The latest finished sweep inside the lookback: did it find mail the poll missed?
  SELECT * INTO miss_run FROM public.context_capture_runs r WHERE r.source=sweep_src AND r.status<>'running' AND r.finished_at>=now_time-miss_lookback
  ORDER BY r.started_at DESC LIMIT 1;
  misses:=CASE WHEN jsonb_typeof(miss_run.counts->'sweep_misses')='number' THEN (miss_run.counts->>'sweep_misses')::bigint ELSE 0 END;
  -- Lanes health (20261006050000): mail received before the source's first
  -- successful poll (that poll's window_from) was never the poll's to read;
  -- the first nightly sweep re-reads 48 hours, which can begin before the
  -- reader existed. The sweep lists when each email it saved was received
  -- (cursor.miss_received_at: the newest 100, a null for a time it could not
  -- read). A listed time at or after the first poll, and a null, count. The
  -- misses past the list are older than its oldest time: none counts when
  -- that time is before the first poll, all do otherwise. An unreadable list
  -- leaves every miss counted.
  IF misses>0 THEN
   SELECT r.window_from INTO first_from FROM public.context_capture_runs r
   WHERE r.source=poll_src AND r.status='succeeded' ORDER BY r.finished_at, r.id LIMIT 1;
   IF NOT FOUND THEN
    -- No successful poll yet: nothing the poll could have missed.
    misses:=0;
   ELSIF first_from IS NULL THEN
    -- The first poll recorded no window: nothing to compare, every miss counts.
    NULL;
   ELSIF jsonb_typeof(miss_run.cursor->'miss_received_at')='array' THEN
    BEGIN
     SELECT count(*) FILTER (WHERE t.v IS NULL OR t.v::timestamptz>=first_from), count(*), min(t.v::timestamptz)
     INTO kept, listed, oldest
     FROM jsonb_array_elements_text(miss_run.cursor->'miss_received_at') AS t(v);
     misses:=kept+CASE WHEN oldest<first_from THEN 0 ELSE greatest(misses-listed,0) END;
    EXCEPTION WHEN OTHERS THEN
     NULL;
    END;
   ELSIF miss_run.window_from<first_from THEN
    -- A sweep that kept no list and read back before the first poll: its
    -- misses cannot be told apart from older mail.
    misses:=0;
   END IF;
  END IF;
  -- A sweep is not expected on the night the flag or the source was switched on.
  since:=greatest(flag_changed,m.updated_at);
  src_alarms:='[]'::jsonb;
  IF alarms_active AND selected THEN
   IF cardinality(last_runs)>=failed_n AND n_failed=failed_n THEN
    src_alarms:=src_alarms||jsonb_build_array(jsonb_build_object('key','email_source_error','since',(last_runs[failed_n]).started_at,'error_code',(last_runs[1]).error_code));
   END IF;
   IF cardinality(last_runs)>=backlog_n AND n_backlog=backlog_n THEN
    src_alarms:=src_alarms||jsonb_build_array(jsonb_build_object('key','email_backlog','since',(last_runs[backlog_n]).started_at));
   END IF;
   IF misses>0 THEN
    src_alarms:=src_alarms||jsonb_build_array(jsonb_build_object('key','email_poll_missed','since',miss_run.started_at,'sweep_misses',misses));
   END IF;
   IF sweep_due AND NOT swept AND (since IS NULL OR since<sweep_at) THEN
    src_alarms:=src_alarms||jsonb_build_array(jsonb_build_object('key','sweep_incomplete','since',sweep_at,'last_status',last_sweep.status));
   END IF;
  END IF;
  per_source:=per_source||jsonb_build_array(jsonb_build_object('line',line,'selected',selected,
   'pending_review',m.status='pending_review','last_seen',last_seen,'alarms',src_alarms));
 END LOOP;

 -- 2. One line per shared label, one combined 'personal' line: counts,
 -- health and the oldest last-seen only. Byte-ordered; a line is unique.
 SELECT coalesce(jsonb_agg(l ORDER BY (l->>'line')='personal',l->>'line' COLLATE "C"),'[]'::jsonb) INTO lines FROM (
  SELECT jsonb_build_object('line',s->>'line','personal',(s->>'line')='personal',
   'sources',count(*),
   'selected',count(*) FILTER (WHERE (s->>'selected')::boolean),
   'pending_review',count(*) FILTER (WHERE (s->>'pending_review')::boolean),
   'healthy',count(*) FILTER (WHERE (s->>'selected')::boolean AND jsonb_array_length(s->'alarms')=0),
   'erroring',count(*) FILTER (WHERE (s->>'selected')::boolean AND jsonb_array_length(s->'alarms')>0),
   'never_seen',count(*) FILTER (WHERE (s->>'selected')::boolean AND s->'last_seen'='null'::jsonb),
   'oldest_last_seen_at',min((s->>'last_seen')::timestamptz) FILTER (WHERE (s->>'selected')::boolean)) AS l
  FROM jsonb_array_elements(per_source) s GROUP BY s->>'line') x;

 -- 3. Alarms, one per line and key: how many of the line's sources raise it,
 -- never which one. Byte-ordered; a line and key pair is unique.
 SELECT coalesce(jsonb_agg(a ORDER BY a->>'line' COLLATE "C",a->>'key' COLLATE "C"),'[]'::jsonb) INTO alarms FROM (
  SELECT jsonb_build_object('key',al->>'key','severity','warning','line',s->>'line','sources',count(*),
   'since',min((al->>'since')::timestamptz))
   ||CASE al->>'key'
      WHEN 'email_source_error' THEN jsonb_build_object('error_codes',(SELECT jsonb_agg(DISTINCT c COLLATE "C" ORDER BY c COLLATE "C") FROM unnest(array_agg(al->>'error_code')) c WHERE c IS NOT NULL),
       'what_to_do','Mailboxes on this line failed their last two polls. Check the Microsoft Graph credentials and the app''s permission on them.')
      WHEN 'email_backlog' THEN jsonb_build_object('what_to_do','Mailboxes on this line have had more mail than one poll reads for three polls running. They will catch up; if not, raise the page bound.')
      WHEN 'email_poll_missed' THEN jsonb_build_object('sweep_misses',sum((al->>'sweep_misses')::bigint),
       'what_to_do','The nightly sweep found mail the 5-minute poll missed (now captured). Check the poll run rows for this line.')
      ELSE jsonb_build_object('what_to_do','Mailboxes on this line did not finish their 02:00 sweep. Check the monitor-inbox-sweep cron job and the sweep run rows.')
     END AS a
  FROM jsonb_array_elements(per_source) s, jsonb_array_elements(s->'alarms') al
  GROUP BY s->>'line',al->>'key') x;

 RETURN jsonb_build_object('as_of',now_time,
  'flag',jsonb_build_object('name',policy->>'flag','enabled',coalesce(flag_on,false),'updated_at',flag_changed,'state',flag_state),
  'capture_lane',lane_on,'alarms_active',alarms_active,'last_sweep_due_at',sweep_at,
  'counts',jsonb_build_object('sources',jsonb_array_length(per_source),
    'selected',(SELECT count(*) FROM jsonb_array_elements(per_source) s WHERE (s->>'selected')::boolean),
    'pending_review',(SELECT count(*) FROM jsonb_array_elements(per_source) s WHERE (s->>'pending_review')::boolean)),
  'policy',policy,'lines',lines,'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_email_capture_status_at(timestamptz) IS
 'context_email_capture_status() judged at p_now (null = now()). For tests and diagnosis; same output shape. email_poll_missed counts only mail received at or after the source''s first successful poll (20261006050000).';

-- 5. GHL: ghl_webhooks_quiet judges the doorbells and the app events each on
-- its own limit.
CREATE OR REPLACE FUNCTION public.context_ghl_capture_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'item_flag','ghl_message_capture_v2',
  'run_source','ghl_message_reconcile',
  'webhook_receipt','ids_only_v1',
  -- ghl_webhooks_quiet, app part: business minutes without an accepted app
  -- event. Judged only once the app has sent its first accepted event
  -- (20261006050000); the app is not built yet.
  'webhooks_quiet_business_minutes',120,
  -- ghl_webhooks_quiet, doorbell part: business minutes without an accepted
  -- doorbell, always judged. Two business days: the doorbells arrive about 8
  -- a business day, but a Saturday with no call is normal; production's
  -- longest healthy gap from 7 May to 6 Oct 2026 was 915 business minutes,
  -- and one business day (660) would have rung on 5 quiet weekends
  -- (20261006050000).
  'doorbells_quiet_business_minutes',1320,
  -- ghl_webhook_misses_high: messages only the reconciler found, over 24 h.
  'webhook_misses_high_24h',5,
  -- ghl_reconcile_stale: minutes since the last successful reconcile.
  'reconcile_stale_minutes',45,
  -- Receipts older than this are not searched for "last webhook at".
  'lookback_days',30,
  -- The GHL app webhook events (sms.md §13 P1). Workflow posts do not count
  -- towards "the app is still sending" (last_app_webhook_at).
  'app_event_types',jsonb_build_array('InboundMessage','OutboundMessage','NoteCreate','NoteUpdate','TaskCreate','TaskComplete',
   'TaskDelete','AppointmentCreate','AppointmentUpdate','AppointmentDelete'),
  -- The GHL workflow doorbells (a call ended, a customer replied, staff
  -- replied): the doorbell part of ghl_webhooks_quiet (20261006050000).
  'doorbell_event_types',jsonb_build_array('CallCompleted','CustomerReplied','UserReplied'),
  -- Receipt outcomes that are not an accepted delivery.
  'refused_outcomes',jsonb_build_array('unauthorized','invalid_json'))
$$;

CREATE OR REPLACE FUNCTION public.context_ghl_capture_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_ghl_capture_policy();
 now_time timestamptz:=now();
 flag jsonb:=public.context_ghl_item_flag();
 flag_on boolean:=(flag->>'enabled')::boolean;
 flag_since timestamptz:=(flag->>'updated_at')::timestamptz;
 lane_on boolean:=public.automation_lane_enabled('capture');
 app_types text[]:=ARRAY(SELECT jsonb_array_elements_text(policy->'app_event_types'));
 doorbells text[]:=ARRAY(SELECT jsonb_array_elements_text(coalesce(policy->'doorbell_event_types','[]'::jsonb)));
 refused text[]:=ARRAY(SELECT jsonb_array_elements_text(policy->'refused_outcomes'));
 by_outcome jsonb; by_auth jsonb; received integer; unresolved integer; auth_missing integer; auth_missing_enforced integer;
 first_enforced_missing timestamptz; last_webhook timestamptz; last_app_webhook timestamptz;
 app_last timestamptz; last_doorbell timestamptz; door_since timestamptz; door_minutes integer; app_minutes integer; quiet_parts jsonb:='[]'::jsonb;
 last_run jsonb; last_success timestamptz; retry_from text; runs_by_status jsonb; misses integer; write_errors integer; failed_runs integer;
 watermark timestamptz; backlog integer; alarms jsonb:='[]'::jsonb; stale_since timestamptz;
BEGIN
 -- Webhook receipts: one ids-only webhook_log row per delivery (C1b).
 WITH r AS (
  SELECT w.created_at, w.event_type, coalesce(w.payload->>'outcome','unknown') AS outcome,
   coalesce(w.payload->>'auth','unknown') AS auth, coalesce(w.payload->>'auth_mode','unknown') AS auth_mode
  FROM public.webhook_log w
  WHERE w.source='ghl_webhook' AND w.created_at>now_time-interval '24 hours' AND w.created_at<=now_time
   AND w.payload->>'receipt'=policy->>'webhook_receipt'
 )
 SELECT count(*),
  (SELECT coalesce(jsonb_object_agg(outcome,n),'{}'::jsonb) FROM (SELECT outcome,count(*) n FROM r GROUP BY outcome) o),
  (SELECT coalesce(jsonb_object_agg(auth||':'||auth_mode,n),'{}'::jsonb) FROM (SELECT auth,auth_mode,count(*) n FROM r GROUP BY auth,auth_mode) a),
  count(*) FILTER (WHERE outcome='unresolved_id'),
  count(*) FILTER (WHERE auth='missing'),
  count(*) FILTER (WHERE auth='missing' AND auth_mode='enforce'),
  min(created_at) FILTER (WHERE auth='missing' AND auth_mode='enforce')
 INTO received,by_outcome,by_auth,unresolved,auth_missing,auth_missing_enforced,first_enforced_missing FROM r;

 -- Accepted deliveries only. last_webhook_at and last_app_webhook_at look
 -- back lookback_days, as before; the two parts of ghl_webhooks_quiet read
 -- their newest event of any age: the app part is armed once the app has
 -- ever sent an accepted event, the doorbell part is always judged.
 SELECT max(w.created_at) FILTER (WHERE w.created_at>now_time-make_interval(days=>(policy->>'lookback_days')::integer)),
  max(w.created_at) FILTER (WHERE w.created_at>now_time-make_interval(days=>(policy->>'lookback_days')::integer) AND w.event_type=ANY(app_types)),
  max(w.created_at) FILTER (WHERE w.event_type=ANY(app_types)),
  max(w.created_at) FILTER (WHERE w.event_type=ANY(doorbells))
 INTO last_webhook,last_app_webhook,app_last,last_doorbell
 FROM public.webhook_log w
 WHERE w.source='ghl_webhook' AND w.created_at<=now_time
  AND w.payload->>'receipt'=policy->>'webhook_receipt' AND NOT (coalesce(w.payload->>'outcome','')=ANY(refused));

 -- Reconciler runs (context_capture_runs, written only through record_capture_run).
 SELECT jsonb_build_object('run_id',c.id,'status',c.status,'started_at',c.started_at,'finished_at',c.finished_at,
   'error_code',c.error_code,'window_from',c.window_from,'window_to',c.window_to,'counts',c.counts),
  c.watermark, CASE WHEN c.counts ? 'backlog_conversations' AND jsonb_typeof(c.counts->'backlog_conversations')='number'
   THEN (c.counts->>'backlog_conversations')::integer END, c.cursor->>'retry_from'
 INTO last_run,watermark,backlog,retry_from
 FROM public.context_capture_runs c WHERE c.source=policy->>'run_source' ORDER BY c.started_at DESC LIMIT 1;
 SELECT max(c.finished_at) INTO last_success FROM public.context_capture_runs c
 WHERE c.source=policy->>'run_source' AND c.status IN ('succeeded','partial');
 SELECT coalesce(jsonb_object_agg(s.status,s.n),'{}'::jsonb),
  coalesce(sum(s.misses),0)::integer, coalesce(sum(s.write_errors),0)::integer, coalesce(sum(s.n) FILTER (WHERE s.status='failed'),0)::integer
 INTO runs_by_status,misses,write_errors,failed_runs
 FROM (SELECT c.status,count(*) n,
   sum(CASE WHEN jsonb_typeof(c.counts->'webhook_misses')='number' THEN (c.counts->>'webhook_misses')::bigint ELSE 0 END) misses,
   sum(CASE WHEN jsonb_typeof(c.counts->'write_errors')='number' THEN (c.counts->>'write_errors')::bigint ELSE 0 END) write_errors
  FROM public.context_capture_runs c
  WHERE c.source=policy->>'run_source' AND c.started_at>now_time-interval '24 hours' GROUP BY c.status) s;

 -- Alarms. Both "is it running" alarms are only meaningful while texts are
 -- being captured: the capture lane and the item flag on.
 IF lane_on AND flag_on THEN
  -- ghl_webhooks_quiet, two parts, each on its own limit (20261006050000).
  -- The app part only once the app has sent: quiet since its newest event.
  IF app_last IS NOT NULL THEN
   app_minutes:=public.context_business_minutes(app_last,now_time);
   IF app_minutes>=(policy->>'webhooks_quiet_business_minutes')::integer THEN
    quiet_parts:=quiet_parts||jsonb_build_array(jsonb_build_object('part','app','since',app_last,'quiet_business_minutes',app_minutes,
     'limit_business_minutes',(policy->>'webhooks_quiet_business_minutes')::integer));
   END IF;
  END IF;
  -- The doorbell part always: quiet since the newest doorbell, or since the
  -- flag came on when none has arrived.
  door_since:=coalesce(last_doorbell,flag_since);
  IF door_since IS NOT NULL THEN
   door_minutes:=public.context_business_minutes(door_since,now_time);
   IF door_minutes>=(policy->>'doorbells_quiet_business_minutes')::integer THEN
    quiet_parts:=quiet_parts||jsonb_build_array(jsonb_build_object('part','doorbells','since',door_since,'quiet_business_minutes',door_minutes,
     'limit_business_minutes',(policy->>'doorbells_quiet_business_minutes')::integer));
   END IF;
  END IF;
  IF jsonb_array_length(quiet_parts)>0 THEN
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','ghl_webhooks_quiet','severity','warning',
    'since',(SELECT min((p->>'since')::timestamptz) FROM jsonb_array_elements(quiet_parts) p),
    'quiet_business_minutes',(SELECT max((p->>'quiet_business_minutes')::integer) FROM jsonb_array_elements(quiet_parts) p),
    'quiet_parts',(SELECT jsonb_agg(p->>'part' ORDER BY p->>'part' COLLATE "C") FROM jsonb_array_elements(quiet_parts) p),
    'parts',quiet_parts,
    'what_to_do','GHL has gone quiet on the webhook: no reply or call workflow post for two business days (doorbells), or no event from the GHL app for 2 business hours once it is installed (app); quiet_parts says which. Check the reply and call workflows and their webhook steps, the GHL app install, the webhook secret, and the capture lane; the reconciler keeps catching texts meanwhile.'));
  END IF;
  stale_since:=coalesce(last_success,flag_since);
  IF stale_since IS NOT NULL AND now_time-stale_since>make_interval(mins=>(policy->>'reconcile_stale_minutes')::integer) THEN
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','ghl_reconcile_stale','severity','warning','since',stale_since,
    'last_run_status',last_run->>'status','last_run_error',last_run->>'error_code',
    'what_to_do','The 15-minute GHL text reconciler has not finished a run for 45 minutes. Check the ghl-message-reconcile cron job and edge function logs, the GHL token, and the capture lane.'));
  END IF;
 END IF;
 IF misses>(policy->>'webhook_misses_high_24h')::integer THEN
  alarms:=alarms||jsonb_build_array(jsonb_build_object('key','ghl_webhook_misses_high','severity','warning','since',now_time-interval '24 hours',
   'webhook_misses_24h',misses,
   'what_to_do','The reconciler found texts the GHL webhook never delivered. Compare the webhook receipts with GHL''s webhook log for the app.'));
 END IF;
 IF auth_missing_enforced>0 THEN
  alarms:=alarms||jsonb_build_array(jsonb_build_object('key','ghl_auth_missing','severity','critical','since',first_enforced_missing,
   'refused_24h',auth_missing_enforced,
   'what_to_do','Unsigned posts reached the GHL webhook receiver after it was set to enforce. Treat as a possible forged post: check the source and escalate as a security event.'));
 END IF;

 RETURN jsonb_build_object(
  'as_of',now_time,'policy',policy,
  'item_flag',flag,'capture_lane',lane_on,
  'webhooks',jsonb_build_object('source','webhook_log ids_only_v1 receipts','received_24h',coalesce(received,0),
   'by_outcome_24h',coalesce(by_outcome,'{}'::jsonb),'by_auth_24h',coalesce(by_auth,'{}'::jsonb),
   'last_webhook_at',last_webhook,'last_app_webhook_at',last_app_webhook,'last_doorbell_at',last_doorbell,'app_armed',app_last IS NOT NULL,
   'unresolved_ids_24h',coalesce(unresolved,0),'auth_missing_24h',coalesce(auth_missing,0),'auth_missing_enforced_24h',coalesce(auth_missing_enforced,0)),
  'reconciler',jsonb_build_object('last_run',last_run,'last_success_at',last_success,'watermark',watermark,
   'backlog_conversations',backlog,'retry_from',retry_from,'runs_24h',runs_by_status,'webhook_misses_24h',misses,'write_errors_24h',write_errors,'failed_runs_24h',failed_runs),
  -- The contactless-sibling data-quality count needs the placement slice's
  -- candidate function (P1a); it is not measured here.
  'not_measured',jsonb_build_array('contactless_sibling_matches'),
  'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_ghl_capture_status() IS
 'Status block ghl_capture (sms slice C1d): item flag, capture lane, GHL webhook receipts in 24 h, the 15-minute reconciler''s runs, latest retry_from, and the alarms ghl_webhooks_quiet (two parts, 20261006050000: no CallCompleted, CustomerReplied or UserReplied doorbell for two business days; no GHL app event for 2 business hours, judged only once the app has sent one), ghl_webhook_misses_high, ghl_reconcile_stale, ghl_auth_missing. Counts and codes only, never message text.';

-- 6. Grants. Every re-created function: no PUBLIC, anon or authenticated
-- execute; service_role only. The ledger's grants are unchanged (service_role
-- reads and inserts; nothing for anon or authenticated).
REVOKE ALL ON FUNCTION
 public.context_source_freshness_policy(),public.context_source_freshness(),public.context_email_capture_status_at(timestamptz),
 public.context_ghl_capture_policy(),public.context_ghl_capture_status()
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION
 public.context_source_freshness_policy(),public.context_source_freshness(),public.context_email_capture_status_at(timestamptz),
 public.context_ghl_capture_policy(),public.context_ghl_capture_status()
TO service_role;
