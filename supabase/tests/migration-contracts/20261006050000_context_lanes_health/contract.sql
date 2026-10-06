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
-- active, quiet) but never alarms. A busy capture source that goes silent the
-- same way still alarms.
-- Rows another contract committed under these names (P4's concurrent case
-- saves monitor-inbox mail now) are moved out of the lookback first.
UPDATE public.business_events SET context_captured_at=now()-interval '400 days'
WHERE source IN ('monitor-inbox','monitor-inbox-group','monitor_inbox','ghl_sms_cache_backfill','mcp_agent','lanes_busy_quiet');
DO $$
DECLARE snap jsonb; src jsonb; s text; quiet_at timestamptz:=now()-interval '10 days'; names text[];
BEGIN
 FOREACH s IN ARRAY ARRAY['monitor-inbox','monitor-inbox-group','monitor_inbox','ghl_sms_cache_backfill','mcp_agent','lanes_busy_quiet'] LOOP
  IF pg_temp.lanes_rows(s,quiet_at)<300 THEN RAISE EXCEPTION 'lanes fixture too small for %',s; END IF;
 END LOOP;
 snap:=public.context_source_freshness();
 IF snap->'alarms' @> '[{"source":"monitor-inbox"}]' OR snap->'alarms' @> '[{"source":"monitor-inbox-group"}]'
  OR snap->'alarms' @> '[{"source":"monitor_inbox"}]' OR snap->'alarms' @> '[{"source":"ghl_sms_cache_backfill"}]'
  OR snap->'alarms' @> '[{"source":"mcp_agent"}]'
 THEN RAISE EXCEPTION 'lanes freshness: retired or action-log source alarmed %',snap->'alarms'; END IF;
 IF NOT snap->'alarms' @> '[{"key":"capture_quiet","source":"lanes_busy_quiet"}]'
 THEN RAISE EXCEPTION 'lanes freshness: the control capture source did not alarm %',snap->'alarms'; END IF;
 FOREACH s IN ARRAY ARRAY['monitor-inbox','monitor-inbox-group','monitor_inbox','ghl_sms_cache_backfill','mcp_agent'] LOOP
  src:=pg_temp.lanes_source(snap,s);
  IF src IS NULL OR (src->>'normally_active')::boolean IS NOT TRUE OR (src->>'quiet')::boolean IS NOT TRUE
   OR src->>'alarm_exempt' IS DISTINCT FROM (CASE WHEN s='mcp_agent' THEN 'action_log' ELSE 'retired' END)
  THEN RAISE EXCEPTION 'lanes freshness: % must be listed, measured quiet and exempt: %',s,src; END IF;
 END LOOP;
 IF pg_temp.lanes_source(snap,'lanes_busy_quiet')->'alarm_exempt'<>'null'::jsonb
 THEN RAISE EXCEPTION 'lanes freshness: control source exempt %',pg_temp.lanes_source(snap,'lanes_busy_quiet'); END IF;
 -- The composer carries the control's alarm and none of the others.
 IF NOT public.context_pipeline_status()->'alarms' @> '[{"block":"capture_sources","key":"capture_quiet","source":"lanes_busy_quiet"}]'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(public.context_pipeline_status()->'alarms') a
   WHERE a->>'source' IN ('monitor-inbox','monitor-inbox-group','monitor_inbox','ghl_sms_cache_backfill','mcp_agent'))
 THEN RAISE EXCEPTION 'lanes freshness: composer alarms %',public.context_pipeline_status()->'alarms'; END IF;
 -- The lists are published in the policy, the earlier retirement kept.
 IF NOT snap#>'{policy,retired_sources}' @> '[{"source":"transcribe-call","replaced_by":"ghl-call-transcript"},
   {"source":"monitor-inbox","replaced_by":"outlook-mail-capture"},{"source":"monitor-inbox-group","replaced_by":"outlook-mail-capture"},
   {"source":"monitor_inbox","replaced_by":"outlook-mail-capture"},{"source":"ghl_sms_cache_backfill","replaced_by":"ghl-message-reconcile"}]'
  OR jsonb_array_length(snap#>'{policy,retired_sources}')<>5
  OR snap#>'{policy,action_log_sources}'<>'[{"source":"mcp_agent","logs":"actions agents take through ops-api"}]'
 THEN RAISE EXCEPTION 'lanes freshness: policy lists %',snap->'policy'; END IF;
 -- One sort order: byte order, so '-' sorts before '_' on every machine.
 SELECT array_agg(value->>'source' ORDER BY ord) INTO names FROM jsonb_array_elements(snap->'sources') WITH ORDINALITY AS t(value,ord)
 WHERE value->>'source' IN ('monitor-inbox','monitor-inbox-group','monitor_inbox');
 IF names IS DISTINCT FROM ARRAY['monitor-inbox','monitor-inbox-group','monitor_inbox']
 THEN RAISE EXCEPTION 'lanes freshness: sources not byte-ordered %',names; END IF;
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
INSERT INTO public.context_capture_runs(source,status,started_at,updated_at,finished_at,window_from,counts,cursor)
SELECT 'outlook_sweep_'||p.source_key,'succeeded','2026-10-06 02:00:02+08','2026-10-06 02:00:40+08','2026-10-06 02:00:40+08',
 '2026-10-04 02:00:02+08',
 CASE p.part
  -- admin: as on 6 Oct, one older email; the sweep (before this change) kept no list.
  WHEN 'admin' THEN '{"sweep_misses":1}'::jsonb
  -- finance: two older emails, listed (4 Oct 15:35 and 5 Oct 07:32 Perth).
  WHEN 'finance' THEN '{"sweep_misses":2}'::jsonb
  -- p1: three misses, two listed: one older, one after the first poll, one past the list.
  WHEN 'p1' THEN '{"sweep_misses":3}'::jsonb
  -- p2: no successful poll at all: nothing the poll could have missed.
  WHEN 'p2' THEN '{"sweep_misses":4}'::jsonb
  -- p4: a list that cannot be read: every miss counts.
  WHEN 'p4' THEN '{"sweep_misses":1}'::jsonb
  ELSE '{"sweep_misses":0}'::jsonb END,
 CASE p.part
  WHEN 'finance' THEN '{"miss_received_at":["2026-10-04T07:35:00.000Z","2026-10-04T23:32:00.000Z"]}'::jsonb
  WHEN 'p1' THEN '{"miss_received_at":["2026-10-04T22:00:00.000Z","2026-10-05T04:00:00.000Z"]}'::jsonb
  WHEN 'p4' THEN '{"miss_received_at":["not a time"]}'::jsonb
  ELSE NULL END
FROM lanes_part p;
-- p5: a later sweep that kept no list, read entirely after the first poll: its miss counts.
UPDATE public.context_capture_runs SET window_from='2026-10-05 09:00+08',counts='{"sweep_misses":1}'
WHERE source=(SELECT 'outlook_sweep_'||source_key FROM lanes_part WHERE part='p5');
DO $$
DECLARE s jsonb; got text; a jsonb;
BEGIN
 s:=public.context_email_capture_status_at('2026-10-06 09:05+08');
 -- admin and finance read healthy: the false email_poll_missed of 6 Oct is gone.
 SELECT string_agg(format('%s|%s|%s',x->>'line',x->>'healthy',x->>'erroring'),',' ORDER BY x->>'line' COLLATE "C") INTO got
 FROM jsonb_array_elements(s->'lines') x WHERE x->>'line' IN ('admin','finance');
 IF got IS DISTINCT FROM 'admin|1|0,finance|1|0' THEN RAISE EXCEPTION 'lanes email: admin and finance lines %',got; END IF;
 -- Only the personal line raises it: p1 (1 after the first poll + 1 past the
 -- list), p4 (unreadable list: 1) and p5 (1); not p2.
 SELECT string_agg(format('%s|%s|%s',x->>'line',x->>'key',x->>'sources'),',' ORDER BY x->>'line' COLLATE "C",x->>'key' COLLATE "C") INTO got
 FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='email_poll_missed';
 IF got IS DISTINCT FROM 'personal|email_poll_missed|3' THEN RAISE EXCEPTION 'lanes email: poll-missed alarms %',got; END IF;
 SELECT x INTO a FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='email_poll_missed';
 IF (a->>'sweep_misses')::integer<>4 THEN RAISE EXCEPTION 'lanes email: counted misses %',a; END IF;
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
-- 3. GHL: the item flag on since 23 Sep, the GHL app never built (its last
-- event long ago), a healthy reconciler, and the call and reply workflows
-- posting. ghl_webhooks_quiet counted only app events, so it alarmed while
-- GHL was talking to us; the doorbells now count as the lane's traffic.
DELETE FROM public.feature_flags WHERE flag_name='ghl_message_capture_v2';
INSERT INTO public.feature_flags(flag_name,enabled,updated_at) VALUES('ghl_message_capture_v2',true,now()-interval '13 days');
DELETE FROM public.webhook_log WHERE source='ghl_webhook';
DELETE FROM public.context_capture_runs WHERE source='ghl_message_reconcile';
CREATE FUNCTION pg_temp.lanes_receipt(p_type text,p_outcome text,p_at timestamptz) RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.webhook_log(org_id,source,event_type,status,payload,created_at)
 VALUES('00000000-0000-0000-0000-000000000001','ghl_webhook',p_type,'processed',
  jsonb_build_object('receipt','ids_only_v1','type',p_type,'outcome',p_outcome,'auth','workflow_secret','auth_mode','observe'),p_at)
$$;
SELECT pg_temp.lanes_receipt('InboundMessage','event_created',now()-interval '12 days');
SELECT public.record_capture_run(jsonb_build_object('source','ghl_message_reconcile','status','succeeded','counts','{}'::jsonb));
DO $$
DECLARE s jsonb; t text; at timestamptz;
BEGIN
 -- Nothing since the old app event: quiet, measured from it.
 s:=public.context_ghl_capture_status();
 IF NOT s->'alarms' @> '[{"key":"ghl_webhooks_quiet"}]' THEN RAISE EXCEPTION 'lanes ghl: a silent door must alarm %',s->'alarms'; END IF;
 -- A refused doorbell and a workflow post that is not a doorbell prove nothing.
 PERFORM pg_temp.lanes_receipt('CallCompleted','unauthorized',now()-interval '5 minutes');
 PERFORM pg_temp.lanes_receipt('ContactStageChanged','event_created',now()-interval '4 minutes');
 s:=public.context_ghl_capture_status();
 IF NOT s->'alarms' @> '[{"key":"ghl_webhooks_quiet"}]'
 THEN RAISE EXCEPTION 'lanes ghl: a refused or non-doorbell post cleared the quiet alarm %',s->'alarms'; END IF;
 FOREACH t IN ARRAY ARRAY['CallCompleted','CustomerReplied','UserReplied'] LOOP
  DELETE FROM public.webhook_log WHERE event_type IN ('CallCompleted','CustomerReplied','UserReplied');
  at:=now()-interval '3 minutes';
  PERFORM pg_temp.lanes_receipt(t,'skipped',at);
  s:=public.context_ghl_capture_status();
  IF s->'alarms' @> '[{"key":"ghl_webhooks_quiet"}]' THEN RAISE EXCEPTION 'lanes ghl: a % doorbell did not count as lane traffic %',t,s->'alarms'; END IF;
  IF (s#>>'{webhooks,last_lane_webhook_at}')::timestamptz IS DISTINCT FROM at
  THEN RAISE EXCEPTION 'lanes ghl: last_lane_webhook_at % for %',s->'webhooks',t; END IF;
  -- "The app is sending" keeps its meaning: app events only.
  IF (s#>>'{webhooks,last_app_webhook_at}')::timestamptz>now()-interval '11 days'
  THEN RAISE EXCEPTION 'lanes ghl: a doorbell moved last_app_webhook_at %',s->'webhooks'; END IF;
 END LOOP;
 IF s#>'{policy,doorbell_event_types}'<>'["CallCompleted","CustomerReplied","UserReplied"]'
 THEN RAISE EXCEPTION 'lanes ghl: policy doorbells %',s->'policy'; END IF;
 -- Two business hours after the last doorbell, quiet again, measured from it.
 UPDATE public.webhook_log SET created_at=now()-interval '3 days' WHERE event_type='UserReplied';
 s:=public.context_ghl_capture_status();
 IF NOT s->'alarms' @> jsonb_build_array(jsonb_build_object('key','ghl_webhooks_quiet','since',s#>'{webhooks,last_lane_webhook_at}'))
 THEN RAISE EXCEPTION 'lanes ghl: quiet must measure from the last doorbell %',s->'alarms'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 4. The attachment ledger: a failure with its code, and a group file sent
-- without its bytes. Everything else as EM2 built it.
DO $$
DECLARE k text:=repeat('a',64); f text; p text:='email:lanes-1@x.example';
BEGIN
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
  ('public.context_source_freshness_policy()','9fa5eda472d13c07afa9701d83372f1b',false),
  ('public.context_source_freshness()','52ace5e52f143486d1cae30144ecb985',true),
  ('public.context_email_capture_status_at(timestamptz)','9dbe9e6dfbb94ce06789539301679841',true),
  ('public.context_ghl_capture_policy()','0bc1a690b25375de97cab346d53e0068',false),
  ('public.context_ghl_capture_status()','07f8cd44cb45d0325577659559e83fc3',true)
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
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_email_capture_status()'::regprocedure)<>'39f700ff23752f161c2215ecc500ece8'
 THEN RAISE EXCEPTION 'lanes touched context_email_capture_status()'; END IF;
END $$;

-- 6. Re-apply is a no-op: same bodies, same ledger, no row touched.
BEGIN;
INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,status,error_code)
 VALUES('email:lanes-2@x.example',repeat('d',64),'failed','graph_403');
\ir ../../../migrations/20261006050000_context_lanes_health.sql
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ghl_capture_status()'::regprocedure)<>'07f8cd44cb45d0325577659559e83fc3'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_email_capture_status_at(timestamptz)'::regprocedure)<>'9dbe9e6dfbb94ce06789539301679841'
 THEN RAISE EXCEPTION 'lanes re-apply moved a body'; END IF;
 IF (SELECT error_code FROM public.context_email_attachments WHERE provider_message_id='email:lanes-2@x.example')<>'graph_403'
 THEN RAISE EXCEPTION 'lanes re-apply touched a ledger row'; END IF;
END $$;
ROLLBACK;
