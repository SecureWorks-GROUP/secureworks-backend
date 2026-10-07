-- Lanes health contract (ops/lanes-diagnosis.md, 6 Oct 2026). Reproduces each
-- false alarm read on production that morning and proves it is gone, with a
-- control beside each that must still alarm; then the attachment ledger's two
-- new statuses. The bodies are pinned, and the re-apply proved, in the last
-- sections, after the behaviour, so a broken body is caught by what it does
-- first. Every fixture write is rolled back.

-- A source's evidence rows: one every 15 minutes through Perth business hours
-- over the 14 days before p_last (F1's normally-active rate is 2.5 an hour).
CREATE FUNCTION pg_temp.lanes_rows(p_source text,p_last timestamptz) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE ids uuid[];
BEGIN
 WITH ins AS (
  INSERT INTO public.business_events(match_method,payload,occurred_at,source)
  SELECT 'none',jsonb_build_object('body','lanes '||g),g,p_source
  FROM generate_series(p_last-interval '14 days',p_last,interval '15 minutes') g WHERE public.context_in_business_hours(g)
  RETURNING id)
 SELECT array_agg(id) INTO ids FROM ins;
 UPDATE public.business_events SET context_captured_at=occurred_at WHERE id=ANY(ids);
 RETURN cardinality(ids);
END $$;
CREATE FUNCTION pg_temp.lanes_source(p jsonb,p_source text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT value FROM jsonb_array_elements(p->'sources') WHERE value->>'source'=p_source
$$;

BEGIN;
-- 1. Freshness. As read on 6 Oct: monitor-inbox busy until the reader took
-- over, then silent (its group reader and the older writer name with it);
-- ghl_sms_cache_backfill busy until agents stopped syncing; mcp_agent, an
-- action log, quiet overnight. Each is measured exactly as before (normally
-- active, quiet) but does not alarm. A busy capture source that goes silent
-- the same way still alarms.
-- The old path hands over only while the email reader's three flags are on
-- (monitor-inbox/reader_handover.ts readerOwnsEvidence, through
-- context_email_reader_flags()), as they have been since 5 Oct. Review round
-- 3: the handover can be undone (the owner switches the schedule off after a
-- reader problem), and the old path then writes again; its three writer
-- names must alarm again if they then go quiet.
-- Rows another contract committed under these names (P4's concurrent case
-- saves monitor-inbox mail now) are moved out of the lookback first.
UPDATE public.business_events SET context_captured_at=now()-interval '400 days'
WHERE source IN ('monitor-inbox','monitor-inbox-group','monitor_inbox','ghl_sms_cache_backfill','mcp_agent','lanes_busy_quiet');
UPDATE public.feature_flags SET enabled=true WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1','email_capture_v2');
DO $$
DECLARE snap jsonb; src jsonb; s text; quiet_at timestamptz:=now()-interval '10 days'; names text[];
 old_path text[]:=ARRAY['monitor-inbox','monitor-inbox-group','monitor_inbox'];
BEGIN
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1','email_capture_v2') AND enabled)<>3
 THEN RAISE EXCEPTION 'lanes fixture: the email reader flags (EM1, EM2) are missing'; END IF;
 FOREACH s IN ARRAY ARRAY['monitor-inbox','monitor-inbox-group','monitor_inbox','ghl_sms_cache_backfill','mcp_agent','lanes_busy_quiet'] LOOP
  IF pg_temp.lanes_rows(s,quiet_at)<300 THEN RAISE EXCEPTION 'lanes fixture too small for %',s; END IF;
 END LOOP;
 snap:=public.context_source_freshness();
 IF snap->'alarms' @> '[{"source":"monitor-inbox"}]' OR snap->'alarms' @> '[{"source":"monitor-inbox-group"}]'
  OR snap->'alarms' @> '[{"source":"monitor_inbox"}]' OR snap->'alarms' @> '[{"source":"ghl_sms_cache_backfill"}]'
  OR snap->'alarms' @> '[{"source":"mcp_agent"}]'
 THEN RAISE EXCEPTION 'lanes freshness: a retired, handed-over or action-log source alarmed %',snap->'alarms'; END IF;
 IF NOT snap->'alarms' @> '[{"key":"capture_quiet","source":"lanes_busy_quiet"}]'
 THEN RAISE EXCEPTION 'lanes freshness: the control capture source did not alarm %',snap->'alarms'; END IF;
 FOREACH s IN ARRAY ARRAY['monitor-inbox','monitor-inbox-group','monitor_inbox','ghl_sms_cache_backfill','mcp_agent'] LOOP
  src:=pg_temp.lanes_source(snap,s);
  IF src IS NULL OR (src->>'normally_active')::boolean IS NOT TRUE OR (src->>'quiet')::boolean IS NOT TRUE
   OR src->>'alarm_exempt' IS DISTINCT FROM (CASE WHEN s='mcp_agent' THEN 'action_log' WHEN s=ANY(old_path) THEN 'handed_over' ELSE 'retired' END)
  THEN RAISE EXCEPTION 'lanes freshness: % must be listed, measured quiet and exempt: %',s,src; END IF;
  -- A handed-over writer says whether the handover holds, and to whom.
  IF s=ANY(old_path) AND src->'handover' IS DISTINCT FROM '{"replaced_by":"outlook-mail-capture","handed_over":true}'::jsonb
  THEN RAISE EXCEPTION 'lanes freshness: % handover state %',s,src; END IF;
 END LOOP;
 IF pg_temp.lanes_source(snap,'lanes_busy_quiet')->'alarm_exempt' IS DISTINCT FROM 'null'::jsonb
  OR pg_temp.lanes_source(snap,'lanes_busy_quiet') ? 'handover'
 THEN RAISE EXCEPTION 'lanes freshness: control source exempt %',pg_temp.lanes_source(snap,'lanes_busy_quiet'); END IF;
 -- The composer carries the control's alarm and none of the others.
 IF NOT public.context_pipeline_status()->'alarms' @> '[{"block":"capture_sources","key":"capture_quiet","source":"lanes_busy_quiet"}]'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(public.context_pipeline_status()->'alarms') a
   WHERE a->>'source' IN ('monitor-inbox','monitor-inbox-group','monitor_inbox','ghl_sms_cache_backfill','mcp_agent'))
 THEN RAISE EXCEPTION 'lanes freshness: composer alarms %',public.context_pipeline_status()->'alarms'; END IF;
 -- The lists are published in the policy, the earlier retirement kept: the
 -- cache copier retired for good, the old email path handed over.
 IF snap#>'{policy,retired_sources}' IS DISTINCT FROM '[{"source":"transcribe-call","replaced_by":"ghl-call-transcript"},
   {"source":"ghl_sms_cache_backfill","replaced_by":"ghl-message-reconcile"}]'
  OR snap#>'{policy,handover_sources}' IS DISTINCT FROM '[{"source":"monitor-inbox","replaced_by":"outlook-mail-capture"},
   {"source":"monitor-inbox-group","replaced_by":"outlook-mail-capture"},{"source":"monitor_inbox","replaced_by":"outlook-mail-capture"}]'
  OR snap#>>'{policy,handover_flags}' IS DISTINCT FROM 'context_email_reader_flags(): reader, schedule and program all on'
  OR snap#>'{policy,action_log_sources}' IS DISTINCT FROM '[{"source":"mcp_agent","logs":"actions agents take through ops-api"}]'
 THEN RAISE EXCEPTION 'lanes freshness: policy lists %',snap->'policy'; END IF;
 -- One sort order: byte order, so '-' sorts before '_' on every machine.
 SELECT array_agg(value->>'source' ORDER BY ord) INTO names FROM jsonb_array_elements(snap->'sources') WITH ORDINALITY AS t(value,ord)
 WHERE value->>'source' IN ('monitor-inbox','monitor-inbox-group','monitor_inbox');
 IF names IS DISTINCT FROM ARRAY['monitor-inbox','monitor-inbox-group','monitor_inbox']
 THEN RAISE EXCEPTION 'lanes freshness: sources not byte-ordered %',names; END IF;

 -- The handover undone: the schedule off, a reader flag off, the program
 -- off, a flag row missing, or the flags unreadable. The old path writes
 -- again (readerOwnsEvidence false), so its quiet writer names alarm again;
 -- the retired copier and the action log still do not.
 FOREACH s IN ARRAY ARRAY['email_reader_schedule_v1','email_reader_v1','email_capture_v2','missing','unreadable'] LOOP
  UPDATE public.feature_flags SET enabled=true WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1','email_capture_v2');
  IF s='missing' THEN
   UPDATE public.feature_flags SET flag_name='lanes_moved_schedule' WHERE flag_name='email_reader_schedule_v1';
  ELSIF s='unreadable' THEN
   ALTER TABLE public.feature_flags RENAME COLUMN enabled TO lanes_enabled_moved;
  ELSE
   UPDATE public.feature_flags SET enabled=false WHERE flag_name=s;
  END IF;
  snap:=public.context_source_freshness();
  IF NOT snap->'alarms' @> '[{"key":"capture_quiet","source":"monitor-inbox"},{"key":"capture_quiet","source":"monitor-inbox-group"},
    {"key":"capture_quiet","source":"monitor_inbox"},{"key":"capture_quiet","source":"lanes_busy_quiet"}]'
  THEN RAISE EXCEPTION 'lanes freshness: the old path took back over (%) but its quiet writer names did not alarm %',s,snap->'alarms'; END IF;
  IF snap->'alarms' @> '[{"source":"ghl_sms_cache_backfill"}]' OR snap->'alarms' @> '[{"source":"mcp_agent"}]'
  THEN RAISE EXCEPTION 'lanes freshness: % woke the retired copier or the action log %',s,snap->'alarms'; END IF;
  src:=pg_temp.lanes_source(snap,'monitor-inbox');
  IF src->'alarm_exempt' IS DISTINCT FROM 'null'::jsonb OR src->'handover' IS DISTINCT FROM '{"replaced_by":"outlook-mail-capture","handed_over":false}'::jsonb
  THEN RAISE EXCEPTION 'lanes freshness: monitor-inbox with the handover undone (%) %',s,src; END IF;
  IF s='missing' THEN
   UPDATE public.feature_flags SET flag_name='email_reader_schedule_v1' WHERE flag_name='lanes_moved_schedule';
  ELSIF s='unreadable' THEN
   ALTER TABLE public.feature_flags RENAME COLUMN lanes_enabled_moved TO enabled;
  END IF;
 END LOOP;
 -- And back on: handed over again.
 UPDATE public.feature_flags SET enabled=true WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1','email_capture_v2');
 snap:=public.context_source_freshness();
 IF snap->'alarms' @> '[{"source":"monitor-inbox"}]' OR pg_temp.lanes_source(snap,'monitor_inbox')->>'alarm_exempt' IS DISTINCT FROM 'handed_over'
 THEN RAISE EXCEPTION 'lanes freshness: the handover restored did not exempt the old path again %',snap->'alarms'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 2. Email: the first nightly sweep after the reader was switched on (6 Oct
-- 02:00 Perth) re-read 48 hours from 4 Oct 02:00, but the reader's first
-- polls ran at 08:52 on 5 Oct, reading back to 08:22. Mail it saved from
-- before that is not a poll miss. Judged at 6 Oct 09:05 Perth. The shared
-- sources play themselves; the personal line's five selected sources play
-- parts p1 to p5 (in byte order), so no person's mailbox is named here.
UPDATE public.feature_flags SET enabled=true,updated_at='2026-09-20 09:00+08' WHERE flag_name='email_capture_v2';
UPDATE public.monitored_mailboxes SET updated_at='2026-09-20 09:00+08';
DELETE FROM public.context_capture_runs WHERE source LIKE 'outlook\_%' ESCAPE '\';
CREATE TEMP TABLE lanes_part ON COMMIT DROP AS
SELECT m.source_key, CASE WHEN m.scope_label IN ('owner','sales','ops','other')
  THEN 'p'||row_number() OVER (PARTITION BY m.scope_label IN ('owner','sales','ops','other') ORDER BY m.source_key COLLATE "C")
  ELSE m.scope_label END AS part
FROM public.monitored_mailboxes m WHERE m.enabled AND m.status='active';
DO $$
BEGIN
 IF (SELECT count(*) FROM lanes_part WHERE part LIKE 'p_')<>5 OR NOT EXISTS(SELECT 1 FROM lanes_part WHERE part='admin')
  OR NOT EXISTS(SELECT 1 FROM lanes_part WHERE part='finance')
 THEN RAISE EXCEPTION 'lanes email fixture: expected EM1''s seed (5 selected personal sources, admin, finance)'; END IF;
END $$;
-- Every selected source but p2: a first successful poll on 5 Oct 08:52
-- (reading from 08:22) and a recent one; every source a sweep at 02:00 today.
INSERT INTO public.context_capture_runs(source,status,started_at,updated_at,finished_at,window_from,window_to,counts,cursor)
SELECT 'outlook_'||p.source_key,'succeeded',t.at,t.at+interval '1 minute',t.at+interval '1 minute',t.at-interval '30 minutes',t.at,'{}','{"backlog":false}'
FROM lanes_part p, (VALUES (timestamptz '2026-10-05 08:52+08'),(timestamptz '2026-10-06 09:00+08')) t(at)
WHERE p.part<>'p2';
-- The sweep lists the newest 100 receive times (a null for a time it could
-- not read); every miss past the list is older than its oldest time.
INSERT INTO public.context_capture_runs(source,status,started_at,updated_at,finished_at,window_from,counts,cursor)
SELECT 'outlook_sweep_'||p.source_key,'succeeded','2026-10-06 02:00:02+08','2026-10-06 02:00:40+08','2026-10-06 02:00:40+08',
 '2026-10-04 02:00:02+08',
 CASE p.part
  -- admin: as on 6 Oct, one older email; the sweep (before this change) kept no list.
  WHEN 'admin' THEN '{"sweep_misses":1}'::jsonb
  -- finance: review round 3, a mailbox as busy as admin@ switched on: its
  -- first sweep saved 140 emails, every one received before its first poll.
  -- The list holds the newest 100 (4 Oct 10:00 to 18:15 UTC); the 40 past
  -- it are older still.
  WHEN 'finance' THEN '{"sweep_misses":140}'::jsonb
  -- p1: three misses, two listed: one older, one after the first poll; the
  -- one past the list is older than the older listed one.
  WHEN 'p1' THEN '{"sweep_misses":3}'::jsonb
  -- p2: no successful poll at all: nothing the poll could have missed.
  WHEN 'p2' THEN '{"sweep_misses":4}'::jsonb
  -- p3: three misses, two listed, both counting (one after the first poll,
  -- one whose time could not be read); the list's oldest time is after the
  -- first poll, so the one past it may be too: it counts.
  WHEN 'p3' THEN '{"sweep_misses":3}'::jsonb
  -- p4: a list that cannot be read: every miss counts.
  WHEN 'p4' THEN '{"sweep_misses":1}'::jsonb
  ELSE '{"sweep_misses":0}'::jsonb END,
 CASE p.part
  WHEN 'finance' THEN (SELECT jsonb_build_object('miss_received_at',jsonb_agg(to_char(g AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ORDER BY g))
   FROM generate_series(timestamptz '2026-10-04 10:00Z',timestamptz '2026-10-04 18:15Z',interval '5 minutes') g)
  WHEN 'p1' THEN '{"miss_received_at":["2026-10-04T22:00:00.000Z","2026-10-05T04:00:00.000Z"]}'::jsonb
  WHEN 'p3' THEN '{"miss_received_at":[null,"2026-10-05T03:00:00.000Z"]}'::jsonb
  WHEN 'p4' THEN '{"miss_received_at":["not a time"]}'::jsonb
  ELSE NULL END
FROM lanes_part p;
-- p5: a later sweep that kept no list, read entirely after the first poll: its miss counts.
UPDATE public.context_capture_runs SET window_from='2026-10-05 09:00+08',counts='{"sweep_misses":1}'
WHERE source=(SELECT 'outlook_sweep_'||source_key FROM lanes_part WHERE part='p5');
DO $$
DECLARE s jsonb; got text; a jsonb;
BEGIN
 IF jsonb_array_length((SELECT cursor->'miss_received_at' FROM public.context_capture_runs
   WHERE source=(SELECT 'outlook_sweep_'||source_key FROM lanes_part WHERE part='finance')))<>100
 THEN RAISE EXCEPTION 'lanes email fixture: the busy sweep must list 100 times'; END IF;
 s:=public.context_email_capture_status_at('2026-10-06 09:05+08');
 -- admin and finance read healthy: the false email_poll_missed of 6 Oct is
 -- gone, and so is the busy mailbox's (the 40 past its list are older).
 SELECT string_agg(format('%s|%s|%s',x->>'line',x->>'healthy',x->>'erroring'),',' ORDER BY x->>'line' COLLATE "C") INTO got
 FROM jsonb_array_elements(s->'lines') x WHERE x->>'line' IN ('admin','finance');
 IF got IS DISTINCT FROM 'admin|1|0,finance|1|0' THEN RAISE EXCEPTION 'lanes email: admin and finance lines %',got; END IF;
 -- Only the personal line raises it: p1 (1 after the first poll; the one
 -- past its list is older), p3 (2 listed + 1 past the list), p4 (unreadable
 -- list: 1) and p5 (1); not p2.
 SELECT string_agg(format('%s|%s|%s',x->>'line',x->>'key',x->>'sources'),',' ORDER BY x->>'line' COLLATE "C",x->>'key' COLLATE "C") INTO got
 FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='email_poll_missed';
 IF got IS DISTINCT FROM 'personal|email_poll_missed|4' THEN RAISE EXCEPTION 'lanes email: poll-missed alarms %',got; END IF;
 SELECT x INTO a FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='email_poll_missed';
 IF (a->>'sweep_misses')::integer<>6 THEN RAISE EXCEPTION 'lanes email: counted misses %',a; END IF;
 -- No other alarm on this fixture (p2 has no poll yet and so no sweep miss).
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'<>'email_poll_missed')
 THEN RAISE EXCEPTION 'lanes email: unexpected alarms %',s->'alarms'; END IF;
 -- One sort order: lines and alarms byte-ordered, personal last.
 SELECT string_agg(x->>'line',',' ORDER BY ord) INTO got FROM jsonb_array_elements(s->'lines') WITH ORDINALITY AS t(x,ord);
 IF got IS DISTINCT FROM 'admin,approvals,fencing,finance,patios,ses,personal' THEN RAISE EXCEPTION 'lanes email: line order %',got; END IF;
 -- The next night's sweep (reading from 5 Oct 02:00) saves an email received
 -- after the first poll: a real poll defect, and it alarms on its own line.
 UPDATE public.context_capture_runs SET window_from='2026-10-05 02:00:02+08',counts='{"sweep_misses":1}',
  cursor='{"miss_received_at":["2026-10-05T03:00:00.000Z"]}' WHERE source='outlook_sweep_finance';
 s:=public.context_email_capture_status_at('2026-10-06 09:05+08');
 IF NOT s->'alarms' @> '[{"key":"email_poll_missed","line":"finance","sources":1,"sweep_misses":1}]'
 THEN RAISE EXCEPTION 'lanes email: a real miss after the first poll must alarm %',s->'alarms'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 3. GHL, as on 6 Oct: the item flag on since 23 Sep, the GHL app not built
-- (it has never sent an event), a healthy reconciler, and the call and reply
-- workflows posting their doorbells (CallCompleted, CustomerReplied,
-- UserReplied), about 8 a business day with long quiet spells: production's
-- longest from 24 Sep to 6 Oct was 878 business minutes, Friday 25 Sep 17:57
-- to Monday 28 Sep 10:36 Perth (a Saturday with no call). Review round 3:
-- one 120-minute limit over doorbells and app events rang for 39% of
-- business time while GHL was healthy. Now two parts, each on its own limit:
-- the doorbells on 1320 business minutes (two business days), always
-- judged; the app events on 120, judged only once the app has sent its
-- first accepted event. The alarm rings when an armed part is quiet past
-- its limit.
DELETE FROM public.feature_flags WHERE flag_name='ghl_message_capture_v2';
INSERT INTO public.feature_flags(flag_name,enabled,updated_at) VALUES('ghl_message_capture_v2',true,now()-interval '13 days');
DELETE FROM public.webhook_log WHERE source='ghl_webhook';
DELETE FROM public.context_capture_runs WHERE source='ghl_message_reconcile';
CREATE FUNCTION pg_temp.lanes_receipt(p_type text,p_outcome text,p_at timestamptz) RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.webhook_log(org_id,source,event_type,status,payload,created_at)
 VALUES('00000000-0000-0000-0000-000000000001','ghl_webhook',p_type,'processed',
  jsonb_build_object('receipt','ids_only_v1','type',p_type,'outcome',p_outcome,'auth','workflow_secret','auth_mode','observe'),p_at)
$$;
-- The newest time whose business minutes to now fall in [p_lo, p_hi], so
-- each case means the same thing whatever day and hour the contract runs.
CREATE FUNCTION pg_temp.lanes_ago(p_lo integer,p_hi integer) RETURNS timestamptz LANGUAGE sql AS $$
 SELECT max(g) FROM generate_series(now()-interval '12 days',now(),interval '5 minutes') g
 WHERE public.context_business_minutes(g,now()) BETWEEN p_lo AND p_hi
$$;
CREATE FUNCTION pg_temp.lanes_quiet(p jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT a FROM jsonb_array_elements(p->'alarms') a WHERE a->>'key'='ghl_webhooks_quiet'
$$;
SELECT public.record_capture_run(jsonb_build_object('source','ghl_message_reconcile','status','succeeded','counts','{}'::jsonb));
DO $$
DECLARE s jsonb; t text; at timestamptz; app_at timestamptz; flag_at timestamptz; a jsonb;
BEGIN
 SELECT updated_at INTO flag_at FROM public.feature_flags WHERE flag_name='ghl_message_capture_v2';
 IF pg_temp.lanes_ago(700,1300) IS NULL OR pg_temp.lanes_ago(1400,1700) IS NULL OR pg_temp.lanes_ago(130,600) IS NULL
 THEN RAISE EXCEPTION 'lanes ghl fixture: no time found in a business-minute range'; END IF;
 -- Nothing at all since the flag came on 13 days ago: GHL is silent. The
 -- doorbell part rings, measured from the flag; the app part is not armed.
 s:=public.context_ghl_capture_status();
 a:=pg_temp.lanes_quiet(s);
 IF a IS NULL OR a->'quiet_parts' IS DISTINCT FROM '["doorbells"]' OR (a->>'since')::timestamptz IS DISTINCT FROM flag_at
 THEN RAISE EXCEPTION 'lanes ghl: a silent GHL must ring on its doorbells %',s->'alarms'; END IF;
 IF s#>'{webhooks,app_armed}' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'lanes ghl: app armed with no app event %',s->'webhooks'; END IF;
 -- A refused doorbell and a workflow post that is not a doorbell prove nothing.
 PERFORM pg_temp.lanes_receipt('CallCompleted','unauthorized',now()-interval '5 minutes');
 PERFORM pg_temp.lanes_receipt('ContactStageChanged','event_created',now()-interval '4 minutes');
 s:=public.context_ghl_capture_status();
 IF pg_temp.lanes_quiet(s) IS NULL OR s#>'{webhooks,last_doorbell_at}' IS DISTINCT FROM 'null'
 THEN RAISE EXCEPTION 'lanes ghl: a refused or non-doorbell post cleared the quiet alarm %',s; END IF;
 -- Each doorbell counts, and the app part stays unarmed (production today).
 FOREACH t IN ARRAY ARRAY['CallCompleted','CustomerReplied','UserReplied'] LOOP
  DELETE FROM public.webhook_log WHERE event_type IN ('CallCompleted','CustomerReplied','UserReplied');
  at:=now()-interval '3 minutes';
  PERFORM pg_temp.lanes_receipt(t,'skipped',at);
  s:=public.context_ghl_capture_status();
  IF pg_temp.lanes_quiet(s) IS NOT NULL THEN RAISE EXCEPTION 'lanes ghl: a % doorbell did not count %',t,s->'alarms'; END IF;
  IF (s#>>'{webhooks,last_doorbell_at}')::timestamptz IS DISTINCT FROM at OR s#>'{webhooks,app_armed}' IS DISTINCT FROM 'false'
   OR s#>'{webhooks,last_app_webhook_at}' IS DISTINCT FROM 'null' OR s#>'{webhooks}' ? 'last_lane_webhook_at'
  THEN RAISE EXCEPTION 'lanes ghl: webhook times for % %',t,s->'webhooks'; END IF;
 END LOOP;
 -- Doorbells quiet for more than one business day but less than two (the
 -- Saturday with no call): GHL is healthy, nothing rings. One business day
 -- (660) rang here for 3.6 business hours on 26 and 28 Sep.
 at:=pg_temp.lanes_ago(700,1300);
 UPDATE public.webhook_log SET created_at=at WHERE event_type IN ('CallCompleted','CustomerReplied','UserReplied') AND payload->>'outcome'<>'unauthorized';
 s:=public.context_ghl_capture_status();
 IF pg_temp.lanes_quiet(s) IS NOT NULL THEN RAISE EXCEPTION 'lanes ghl: a quiet Saturday rang %',s->'alarms'; END IF;
 -- Past two business days: the doorbell part rings, measured from the last doorbell.
 at:=pg_temp.lanes_ago(1400,1700);
 UPDATE public.webhook_log SET created_at=at WHERE event_type IN ('CallCompleted','CustomerReplied','UserReplied') AND payload->>'outcome'<>'unauthorized';
 s:=public.context_ghl_capture_status();
 a:=pg_temp.lanes_quiet(s);
 IF a IS NULL OR a->'quiet_parts' IS DISTINCT FROM '["doorbells"]' OR (a->>'since')::timestamptz IS DISTINCT FROM at
  OR (a->>'quiet_business_minutes')::integer<1320 OR a->>'severity' IS DISTINCT FROM 'warning' OR a->>'what_to_do' IS NULL
 THEN RAISE EXCEPTION 'lanes ghl: doorbells quiet past two business days must ring from the last one %',s->'alarms'; END IF;
 -- Doorbells fresh again. A refused app event does not arm the app part.
 UPDATE public.webhook_log SET created_at=now()-interval '3 minutes' WHERE event_type IN ('CallCompleted','CustomerReplied','UserReplied') AND payload->>'outcome'<>'unauthorized';
 PERFORM pg_temp.lanes_receipt('InboundMessage','unauthorized',now()-interval '10 days');
 s:=public.context_ghl_capture_status();
 IF pg_temp.lanes_quiet(s) IS NOT NULL OR s#>'{webhooks,app_armed}' IS DISTINCT FROM 'false'
 THEN RAISE EXCEPTION 'lanes ghl: a refused app event armed the app part %',s; END IF;
 -- The app's first accepted event arms its part, judged on 120 business
 -- minutes: quiet past that, it rings while the doorbells are fresh.
 app_at:=pg_temp.lanes_ago(130,600);
 PERFORM pg_temp.lanes_receipt('InboundMessage','event_created',app_at);
 s:=public.context_ghl_capture_status();
 a:=pg_temp.lanes_quiet(s);
 IF s#>'{webhooks,app_armed}' IS DISTINCT FROM 'true' OR a IS NULL OR a->'quiet_parts' IS DISTINCT FROM '["app"]' OR (a->>'since')::timestamptz IS DISTINCT FROM app_at
  OR (a->>'quiet_business_minutes')::integer<120
 THEN RAISE EXCEPTION 'lanes ghl: an armed app part quiet past 120 business minutes must ring %',s; END IF;
 -- A fresh app event: nothing rings.
 PERFORM pg_temp.lanes_receipt('OutboundMessage','event_created',now()-interval '1 minute');
 s:=public.context_ghl_capture_status();
 IF pg_temp.lanes_quiet(s) IS NOT NULL THEN RAISE EXCEPTION 'lanes ghl: a fresh app event still rang %',s->'alarms'; END IF;
 -- Armed for good: the app's last event older than the 30-day lookback
 -- still arms it (last_app_webhook_at, inside the lookback, is null).
 app_at:=now()-interval '40 days';
 UPDATE public.webhook_log SET created_at=app_at WHERE event_type IN ('InboundMessage','OutboundMessage') AND payload->>'outcome'='event_created';
 s:=public.context_ghl_capture_status();
 a:=pg_temp.lanes_quiet(s);
 IF s#>'{webhooks,app_armed}' IS DISTINCT FROM 'true' OR s#>'{webhooks,last_app_webhook_at}' IS DISTINCT FROM 'null' OR a->'quiet_parts' IS DISTINCT FROM '["app"]'
  OR (a->>'since')::timestamptz IS DISTINCT FROM app_at
 THEN RAISE EXCEPTION 'lanes ghl: an app silent for 40 days must still ring %',s; END IF;
 -- Both parts quiet: one alarm naming both, since the earlier.
 at:=pg_temp.lanes_ago(1400,1700);
 UPDATE public.webhook_log SET created_at=at WHERE event_type IN ('CallCompleted','CustomerReplied','UserReplied') AND payload->>'outcome'<>'unauthorized';
 s:=public.context_ghl_capture_status();
 a:=pg_temp.lanes_quiet(s);
 IF (SELECT count(*) FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='ghl_webhooks_quiet')<>1
  OR a->'quiet_parts' IS DISTINCT FROM '["app","doorbells"]' OR (a->>'since')::timestamptz IS DISTINCT FROM app_at
 THEN RAISE EXCEPTION 'lanes ghl: both parts quiet %',s->'alarms'; END IF;
 -- The flag off: no quiet alarm at all (C1d).
 UPDATE public.feature_flags SET enabled=false WHERE flag_name='ghl_message_capture_v2';
 IF pg_temp.lanes_quiet(public.context_ghl_capture_status()) IS NOT NULL THEN RAISE EXCEPTION 'lanes ghl: flag off rang'; END IF;
 -- The limits and the doorbells are published in the policy.
 IF s#>'{policy,doorbell_event_types}' IS DISTINCT FROM '["CallCompleted","CustomerReplied","UserReplied"]'
  OR s#>'{policy,doorbells_quiet_business_minutes}' IS DISTINCT FROM '1320' OR s#>'{policy,webhooks_quiet_business_minutes}' IS DISTINCT FROM '120'
 THEN RAISE EXCEPTION 'lanes ghl: policy %',s->'policy'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 4. The attachment ledger: a failure with its code, a group file sent
-- without its bytes, and a file another copy of the email already stored
-- (skipped_duplicate, review round 3: its hash, never a file). Everything
-- else as EM2 built it.
DO $$
DECLARE k text:=repeat('a',64); f text; p text:='email:lanes-1@x.example';
BEGIN
 -- A member's mailbox copy of a file the group post stored: the same bytes
 -- (sha256) under its own attachment key, with no file of its own.
 INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status,file_name,size_bytes,sha256)
  VALUES(p,repeat('d',64),'skipped_duplicate','plans.pdf',120000,k);
 BEGIN
  INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status,sha256,storage_bucket,storage_path)
   VALUES(p,repeat('e',64),'skipped_duplicate',k,'context-email-attachments','x/z/plans.pdf');
  RAISE EXCEPTION 'lanes ledger: a duplicate row holding a file accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status,sha256,error_code)
   VALUES(p,repeat('e',64),'skipped_duplicate',k,'graph_503');
  RAISE EXCEPTION 'lanes ledger: a code on a duplicate row accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 -- The failure key is the attachment key's "failed:" hash, the same in both
 -- languages (attachments.ts failureKey, LIST_FAILURE_KEY).
 f:=encode(sha256(convert_to('failed:'||k,'UTF8')),'hex');
 IF encode(sha256(convert_to('failed:list','UTF8')),'hex')<>'f00077086bc3b5369393e87af4a835e277f8bdc296dc01455b53cb3f80d2896f'
 THEN RAISE EXCEPTION 'lanes ledger: failed:list key drifted from attachments.ts'; END IF;
 INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status,file_name,error_code) VALUES(p,f,'failed','plans.pdf','graph_503');
 -- The later success sits beside the failure, keyed as before.
 INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status,sha256,storage_bucket,storage_path)
  VALUES(p,k,'stored',k,'context-email-attachments','x/y/plans.pdf');
 INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status,file_name) VALUES(p,repeat('b',64),'skipped_no_content','big.pdf');
 INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status,error_code)
  VALUES(p,encode(sha256(convert_to('failed:list','UTF8')),'hex'),'failed','attachment_post_too_large');
 -- An open failure is one whose own key holds no row yet.
 IF EXISTS(SELECT 1 FROM public.context_email_attachments a WHERE a.status='failed' AND a.provider_message_id=p
   AND a.attachment_key<>encode(sha256(convert_to('failed:list','UTF8')),'hex')
   AND NOT EXISTS(SELECT 1 FROM public.context_email_attachments b WHERE b.provider_message_id=a.provider_message_id
    AND encode(sha256(convert_to('failed:'||b.attachment_key,'UTF8')),'hex')=a.attachment_key))
 THEN RAISE EXCEPTION 'lanes ledger: a healed failure reads as open'; END IF;
 BEGIN
  INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status) VALUES(p,repeat('c',64),'failed');
  RAISE EXCEPTION 'lanes ledger: a failure without its code accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status,error_code) VALUES(p,repeat('c',64),'skipped_no_content','graph_403');
  RAISE EXCEPTION 'lanes ledger: a code on a row that did not fail accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status,error_code) VALUES(p,repeat('c',64),'failed','Graph refused: secret words');
  RAISE EXCEPTION 'lanes ledger: a code that is not a code accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status) VALUES(p,repeat('c',64),'sent');
  RAISE EXCEPTION 'lanes ledger: unknown status accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status,error_code) VALUES(p,f,'failed','graph_503');
  RAISE EXCEPTION 'lanes ledger: a second failure row for one attachment accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 -- Access unchanged: the service role reads and inserts; nobody else.
 IF has_table_privilege('anon','public.context_email_attachments','SELECT') OR has_table_privilege('authenticated','public.context_email_attachments','SELECT')
  OR has_column_privilege('anon','public.context_email_attachments','error_code','SELECT')
  OR NOT has_table_privilege('service_role','public.context_email_attachments','SELECT,INSERT')
  OR has_table_privilege('service_role','public.context_email_attachments','UPDATE')
 THEN RAISE EXCEPTION 'lanes ledger: access widened'; END IF;
END $$;
ROLLBACK;

-- 5. Shape and access: every replaced function service-role only, with a
-- fixed search_path, SECURITY DEFINER where it was; the bodies pinned.
DO $$
DECLARE x record; f regprocedure;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_source_freshness_policy()','0b131a763a53c21811465e04a66be539',false),
  ('public.context_source_freshness()','474f94e13b3be83ffe7ce6c4f5b2d774',true),
  ('public.context_email_capture_status_at(timestamptz)','ee6f8e5d57e41fe8c2691b59d4b51856',true),
  ('public.context_ghl_capture_policy()','d803ce75d024366040936b4002d19b30',false),
  ('public.context_ghl_capture_status()','6c2648a6307b6f6e5a08f52fb45690d2',true)
 ) AS t(sig,want,definer) LOOP
  f:=x.sig::regprocedure;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=f)<>x.want THEN RAISE EXCEPTION 'lanes body moved %',x.sig; END IF;
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('public',f,'EXECUTE')
   OR NOT has_function_privilege('service_role',f,'EXECUTE')
  THEN RAISE EXCEPTION 'lanes grants on %',x.sig; END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid=f)<>x.definer
   OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=f AND EXISTS(SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search_path=%'))
  THEN RAISE EXCEPTION 'lanes % security or search_path',x.sig; END IF;
 END LOOP;
 -- The email status wrapper is unchanged and still reads the replaced body.
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_email_capture_status()'::regprocedure) IS DISTINCT FROM '39f700ff23752f161c2215ecc500ece8'
 THEN RAISE EXCEPTION 'lanes touched context_email_capture_status()'; END IF;
END $$;

-- 6. Re-apply is a no-op: same bodies, same ledger, no row touched.
BEGIN;
INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status,error_code)
 VALUES('email:lanes-2@x.example',repeat('d',64),'failed','graph_403');
\ir ../../../migrations/20261006050000_context_lanes_health.sql
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ghl_capture_status()'::regprocedure) IS DISTINCT FROM '6c2648a6307b6f6e5a08f52fb45690d2'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_email_capture_status_at(timestamptz)'::regprocedure) IS DISTINCT FROM 'ee6f8e5d57e41fe8c2691b59d4b51856'
 THEN RAISE EXCEPTION 'lanes re-apply moved a body'; END IF;
 IF (SELECT error_code FROM public.context_email_attachments WHERE provider_message_id='email:lanes-2@x.example') IS DISTINCT FROM 'graph_403'
 THEN RAISE EXCEPTION 'lanes re-apply touched a ledger row'; END IF;
END $$;
ROLLBACK;
