-- C1d retry-status projection follow-up.
--
-- The GHL reconciler's completed cursor is the durable retry coordinate. Keep
-- the latest coordinate visible beside the watermark in the owned ghl_capture
-- status block; the foundation composer and all capture data remain unchanged.
--
-- Built on the C1d function body (20260924133000), md5(prosrc)
-- c2a1df7fe3cbc405f552c0bf2268f5ed. This migration adds no schema or writes.
--
-- Rollback: supabase/rollbacks/20260924210000_context_ghl_retry_status_down.sql
-- restores the C1d status function and its comment.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE live text;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p
 WHERE p.oid=to_regprocedure('public.context_ghl_capture_status()');
 IF live IS NULL OR live NOT IN ('c2a1df7fe3cbc405f552c0bf2268f5ed','ecdec7c3bc7f09cb3ea23d35ac096cd2')
 THEN
  RAISE EXCEPTION 'context_ghl_retry_status_preimage_mismatch: public.context_ghl_capture_status() md5 %; read the live definition before replacing it',coalesce(live,'<missing>');
 END IF;
END $guard$;

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
 last_run jsonb; last_success timestamptz; retry_from text; runs_by_status jsonb; misses integer; write_errors integer; failed_runs integer;
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
   'backlog_conversations',backlog,'retry_from',retry_from,'runs_24h',runs_by_status,'webhook_misses_24h',misses,'write_errors_24h',write_errors,'failed_runs_24h',failed_runs),
  -- The contactless-sibling data-quality count needs the placement slice's
  -- candidate function (P1a); it is not measured here.
  'not_measured',jsonb_build_array('contactless_sibling_matches'),
  'alarms',alarms);
END $$;

COMMENT ON FUNCTION public.context_ghl_capture_status() IS
 'Status block ghl_capture (sms slice C1d): item flag, capture lane, GHL webhook receipts in 24 h, the 15-minute reconciler''s runs, latest retry_from, and the alarms ghl_webhooks_quiet, ghl_webhook_misses_high, ghl_reconcile_stale, ghl_auth_missing. Counts and codes only, never message text.';
REVOKE ALL ON FUNCTION public.context_ghl_capture_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_ghl_capture_status() TO service_role;
