-- C1d (context build plan, Wave 3; design sms.md §2 "Pull (safety net)", §7
-- step 9, §8; INTEGRATION X1, X14, X17, X32): the 15-minute GHL message
-- reconciler's schedule and the ghl_capture status block with its alarms.
--
-- What it does:
--  1. context_ghl_capture_policy(): the thresholds, in one place.
--  2. context_ghl_item_flag(): reads feature_flags.ghl_message_capture_v2.
--     A missing or unreadable row reads as off (fail closed). This migration
--     does not create or change the flag row.
--  3. context_ghl_capture_status() replaces the F1 stub (the only change to the
--     status composer's inputs; the composer itself is untouched). It reports:
--     the item flag and capture lane; webhooks in the last 24 h by outcome and
--     by auth and mode, from the receiver's ids-only webhook_log receipts
--     (slice C1b); last webhook at; unresolved ids; the reconciler's last run,
--     last successful run, watermark, backlog, and webhook misses and errors
--     in 24 h, from context_capture_runs. Alarms (each: key, severity, since,
--     what_to_do), computed, never stored:
--       ghl_webhooks_quiet       no app webhook for 2 business hours while the
--                                capture lane and the item flag are on;
--       ghl_webhook_misses_high  more than 5 messages in 24 h that only the
--                                reconciler found;
--       ghl_reconcile_stale      no successful reconcile for 45 minutes while
--                                the capture lane and the item flag are on
--                                (the reconciler is idle while the flag is off,
--                                so the alarm is too; see sms.md §12 rollback);
--       ghl_auth_missing         any unauthenticated post refused after the
--                                receiver was switched to enforcing (security).
--  4. trigger_ghl_message_reconcile(): posts to the ghl-message-reconcile edge
--     function with the service key, only while the item flag is on.
--  5. pg_cron job ghl-message-reconcile every 15 minutes, wrapped in
--     WHERE public.automation_lane_enabled('capture'), and listed in
--     automation_switch_cron_lanes() so the switch's unwrap and wrap know it.
--
-- No flag or switch is turned on, no business_events row is written, and no
-- grant, policy or view is added for anon or authenticated. Every new or
-- re-created function: fixed search_path, EXECUTE revoked from PUBLIC, anon,
-- authenticated.
--
-- Built on the LIVE production definitions, read 23 Sep 2026 (read-only, in a
-- rolled-back transaction):
--   context_ghl_capture_status()      md5(prosrc) 155104bfb08b8b3c2f98bdec089d4ee4 (the F1 stub)
--   automation_switch_cron_lanes()    md5(prosrc) e67b1b27f41133154915f3666421f475
--     = the 20260911170000 body: monitor-inbox-poll (capture), contact-matching (attribution)
--   capture_business_event(jsonb)     md5(prosrc) 4819869e6dcc40d5cd19a7eba295392c (C1a, called by the edge function)
--   record_capture_run(jsonb)         md5(prosrc) a85b48f9422fff111ee96093bad55c40 (F1, called by the edge function)
--   context_ghl_capture_policy, context_ghl_item_flag, trigger_ghl_message_reconcile: absent
--   cron job ghl-message-reconcile: absent; feature flag ghl_message_capture_v2: no row
-- The guard refuses unless each is still that pre-image or already this
-- migration's result (a re-apply).
--
-- Rollback: supabase/rollbacks/20260924133000_context_ghl_message_reconcile_down.sql
-- (unschedules the job, restores the stub and the two-row lane list, drops the
-- new functions). The edge function idles on its own while the flag is off.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; cmd text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_ghl_capture_status()',ARRAY['155104bfb08b8b3c2f98bdec089d4ee4','c2a1df7fe3cbc405f552c0bf2268f5ed'],false),
  ('public.automation_switch_cron_lanes()',ARRAY['e67b1b27f41133154915f3666421f475','459035de5d3f7f7af49c36f09d9be29e'],false),
  ('public.capture_business_event(jsonb)',ARRAY['4819869e6dcc40d5cd19a7eba295392c'],false),
  ('public.record_capture_run(jsonb)',ARRAY['a85b48f9422fff111ee96093bad55c40'],false),
  ('public.context_ghl_capture_policy()',ARRAY['4deabf30725e64f01f5778d2e853c344'],true),
  ('public.context_ghl_item_flag()',ARRAY['83e26c517d21f4796061bc0f8cf86a93'],true),
  ('public.trigger_ghl_message_reconcile()',ARRAY['e7d460c5681b9806d5add35343b9c156'],true)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF to_regclass('cron.job') IS NOT NULL THEN
  EXECUTE 'SELECT string_agg(command,'' | '') FROM cron.job WHERE jobname=''ghl-message-reconcile''' INTO cmd;
  IF cmd IS NOT NULL AND cmd<>'SELECT public.trigger_ghl_message_reconcile() WHERE public.automation_lane_enabled(''capture'')' THEN
   problems:=problems||'cron job ghl-message-reconcile exists with another command'::text;
  END IF;
 END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'ghl_reconcile_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. Thresholds. Business hours are F1's: Mon to Sat, 07:00 to 18:00 Perth.
CREATE OR REPLACE FUNCTION public.context_ghl_capture_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'item_flag','ghl_message_capture_v2',
  'run_source','ghl_message_reconcile',
  'webhook_receipt','ids_only_v1',
  -- ghl_webhooks_quiet: business minutes without an app webhook.
  'webhooks_quiet_business_minutes',120,
  -- ghl_webhook_misses_high: messages only the reconciler found, over 24 h.
  'webhook_misses_high_24h',5,
  -- ghl_reconcile_stale: minutes since the last successful reconcile.
  'reconcile_stale_minutes',45,
  -- Receipts older than this are not searched for "last webhook at".
  'lookback_days',30,
  -- The GHL app webhook events (sms.md §13 P1). Workflow posts do not count
  -- towards "the app is still sending".
  'app_event_types',jsonb_build_array('InboundMessage','OutboundMessage','NoteCreate','NoteUpdate','TaskCreate','TaskComplete',
   'TaskDelete','AppointmentCreate','AppointmentUpdate','AppointmentDelete'),
  -- Receipt outcomes that are not an accepted delivery.
  'refused_outcomes',jsonb_build_array('unauthorized','invalid_json'))
$$;

-- 2. The item flag. Fails closed: no table, no row, or an error is off.
CREATE OR REPLACE FUNCTION public.context_ghl_item_flag() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE on_flag boolean; changed timestamptz;
BEGIN
 IF to_regclass('public.feature_flags') IS NULL THEN RETURN jsonb_build_object('enabled',false,'updated_at',NULL,'state','missing'); END IF;
 EXECUTE 'SELECT f.enabled,f.updated_at FROM public.feature_flags f WHERE f.flag_name=$1 ORDER BY f.updated_at DESC NULLS LAST LIMIT 1'
  INTO on_flag,changed USING 'ghl_message_capture_v2';
 RETURN jsonb_build_object('enabled',coalesce(on_flag,false),'updated_at',changed,'state',CASE WHEN on_flag IS NULL THEN 'missing' ELSE 'present' END);
EXCEPTION WHEN OTHERS THEN
 RETURN jsonb_build_object('enabled',false,'updated_at',NULL,'state','unreadable');
END $$;
COMMENT ON FUNCTION public.context_ghl_item_flag() IS
 'feature_flags.ghl_message_capture_v2 as {enabled, updated_at, state}. Missing or unreadable reads as off. Owned by sms slice C1d.';

-- 3. The ghl_capture status block.
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
 refused text[]:=ARRAY(SELECT jsonb_array_elements_text(policy->'refused_outcomes'));
 by_outcome jsonb; by_auth jsonb; received integer; unresolved integer; auth_missing integer; auth_missing_enforced integer;
 first_enforced_missing timestamptz; last_webhook timestamptz; last_app_webhook timestamptz;
 last_run jsonb; last_success timestamptz; runs_by_status jsonb; misses integer; write_errors integer; failed_runs integer;
 watermark timestamptz; backlog integer; quiet_minutes integer; alarms jsonb:='[]'::jsonb; stale_since timestamptz;
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

 SELECT max(w.created_at), max(w.created_at) FILTER (WHERE w.event_type=ANY(app_types))
 INTO last_webhook,last_app_webhook
 FROM public.webhook_log w
 WHERE w.source='ghl_webhook' AND w.created_at>now_time-make_interval(days=>(policy->>'lookback_days')::integer) AND w.created_at<=now_time
  AND w.payload->>'receipt'=policy->>'webhook_receipt' AND NOT (coalesce(w.payload->>'outcome','')=ANY(refused));

 -- Reconciler runs (context_capture_runs, written only through record_capture_run).
 SELECT jsonb_build_object('run_id',c.id,'status',c.status,'started_at',c.started_at,'finished_at',c.finished_at,
   'error_code',c.error_code,'window_from',c.window_from,'window_to',c.window_to,'counts',c.counts),
  c.watermark, CASE WHEN c.counts ? 'backlog_conversations' AND jsonb_typeof(c.counts->'backlog_conversations')='number'
   THEN (c.counts->>'backlog_conversations')::integer END
 INTO last_run,watermark,backlog
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
  quiet_minutes:=public.context_business_minutes(coalesce(last_app_webhook,flag_since),now_time);
  IF coalesce(last_app_webhook,flag_since) IS NOT NULL AND quiet_minutes>=(policy->>'webhooks_quiet_business_minutes')::integer THEN
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','ghl_webhooks_quiet','severity','warning',
    'since',coalesce(last_app_webhook,flag_since),'quiet_business_minutes',quiet_minutes,
    'what_to_do','GHL has sent no app webhook for 2 business hours. Check the GHL app install and its webhook settings, the token, and the capture lane; the reconciler keeps catching texts meanwhile.'));
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
   'last_webhook_at',last_webhook,'last_app_webhook_at',last_app_webhook,
   'unresolved_ids_24h',coalesce(unresolved,0),'auth_missing_24h',coalesce(auth_missing,0),'auth_missing_enforced_24h',coalesce(auth_missing_enforced,0)),
  'reconciler',jsonb_build_object('last_run',last_run,'last_success_at',last_success,'watermark',watermark,
   'backlog_conversations',backlog,'runs_24h',runs_by_status,'webhook_misses_24h',misses,'write_errors_24h',write_errors,'failed_runs_24h',failed_runs),
  -- The contactless-sibling data-quality count needs the placement slice's
  -- candidate function (P1a); it is not measured here.
  'not_measured',jsonb_build_array('contactless_sibling_matches'),
  'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_ghl_capture_status() IS
 'Status block ghl_capture (sms slice C1d): item flag, capture lane, GHL webhook receipts in 24 h, the 15-minute reconciler''s runs, and the alarms ghl_webhooks_quiet, ghl_webhook_misses_high, ghl_reconcile_stale, ghl_auth_missing. Counts and codes only, never message text.';

-- 4. The cron caller. Idle while the item flag is off, so a flagged-off
-- reconciler makes no HTTP call at all.
CREATE OR REPLACE FUNCTION public.trigger_ghl_message_reconcile() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT (public.context_ghl_item_flag()->>'enabled')::boolean THEN
  RETURN;
 END IF;
 PERFORM net.http_post(
  url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ghl-message-reconcile',
  body := jsonb_build_object('actor','cron:ghl-message-reconcile'),
  headers := jsonb_build_object('Authorization','Bearer '||public.sw_service_key(),'Content-Type','application/json'),
  timeout_milliseconds := 5000
 );
END $$;
COMMENT ON FUNCTION public.trigger_ghl_message_reconcile() IS
 'pg_cron ghl-message-reconcile (every 15 minutes, capture lane): posts to the ghl-message-reconcile edge function with the service key while feature flag ghl_message_capture_v2 is on. Owned by sms slice C1d.';

-- 5. The capture lane owns the new job. Same body as 20260911170000 plus one row.
CREATE OR REPLACE FUNCTION public.automation_switch_cron_lanes()
RETURNS TABLE (cron_jobname text, lane text)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT * FROM (VALUES
    -- capture: pollers that write evidence rows into business_events
    ('monitor-inbox-poll', 'capture'),
    ('ghl-message-reconcile', 'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;

-- Scheduled already gated, so the switch's wrap reports already_wrapped and its
-- unwrap can remove the suffix. Skipped where pg_cron is absent (contract runner).
DO $cron$
BEGIN
 IF to_regclass('cron.job') IS NULL THEN
  RAISE NOTICE 'ghl-message-reconcile: pg_cron absent, not scheduled';
  RETURN;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='ghl-message-reconcile') THEN
  PERFORM cron.schedule('ghl-message-reconcile','3-59/15 * * * *',
   $cmd$SELECT public.trigger_ghl_message_reconcile() WHERE public.automation_lane_enabled('capture')$cmd$);
 END IF;
END $cron$;

-- 6. Grants. Service-side only.
REVOKE ALL ON FUNCTION public.context_ghl_capture_policy(),public.context_ghl_item_flag(),public.context_ghl_capture_status(),
 public.trigger_ghl_message_reconcile() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_ghl_capture_policy(),public.context_ghl_item_flag(),public.context_ghl_capture_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.trigger_ghl_message_reconcile() TO postgres;
REVOKE ALL ON FUNCTION public.automation_switch_cron_lanes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_switch_cron_lanes() TO service_role, postgres;
