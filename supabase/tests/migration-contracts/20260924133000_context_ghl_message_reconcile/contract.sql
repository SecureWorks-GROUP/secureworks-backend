-- C1d contract: the ghl_capture status block, its four alarms, the cron caller
-- and the schedule. Every fixture write is rolled back. Webhook receipts are in
-- the receiver's ids-only shape (slice C1b); run rows go through
-- record_capture_run (F1), as the edge function writes them.

-- Helpers, session-local.
CREATE FUNCTION pg_temp.c1d_receipt(p_type text,p_outcome text,p_auth text,p_mode text,p_at timestamptz,p_receipt text DEFAULT 'ids_only_v1',
 p_source text DEFAULT 'ghl_webhook') RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.webhook_log(org_id,source,event_type,status,payload,created_at)
 VALUES('00000000-0000-0000-0000-000000000001',p_source,p_type,'processed',
  jsonb_build_object('receipt',p_receipt,'type',p_type,'outcome',p_outcome,'auth',p_auth,'auth_mode',p_mode,'message_id','c1dMsg'),p_at)
$$;
CREATE FUNCTION pg_temp.c1d_run(p_status text,p_counts jsonb,p_code text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
 r:=public.record_capture_run(jsonb_build_object('source','ghl_message_reconcile','counts',p_counts,
  'watermark','2026-09-23T06:00:00Z','cursor',jsonb_build_object('v',1,'complete',true)));
 IF p_status<>'running' THEN
  PERFORM public.record_capture_run(jsonb_build_object('run_id',r->>'run_id','source','ghl_message_reconcile','status',p_status)
   ||CASE WHEN p_code IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('error_code',p_code) END);
 END IF;
 RETURN (r->>'run_id')::uuid;
END $$;
CREATE FUNCTION pg_temp.c1d_alarm_keys(p jsonb) RETURNS text[] LANGUAGE sql AS $$
 SELECT coalesce(array_agg(a->>'key' ORDER BY a->>'key'),'{}') FROM jsonb_array_elements(p->'alarms') a
$$;

BEGIN;
-- 1. Grants and hardening: service side only, fixed search_path.
DO $$
DECLARE f regprocedure;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_ghl_capture_policy()','public.context_ghl_item_flag()','public.context_ghl_capture_status()',
  'public.trigger_ghl_message_reconcile()','public.automation_switch_cron_lanes()']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('public',f,'EXECUTE')
  THEN RAISE EXCEPTION 'c1d public execute on %',f; END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid=f) IS NULL THEN RAISE EXCEPTION 'c1d % has no fixed search_path',f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_ghl_capture_policy()','public.context_ghl_item_flag()','public.context_ghl_capture_status()']::regprocedure[] LOOP
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'c1d service_role cannot execute %',f; END IF;
 END LOOP;
 IF has_function_privilege('service_role','public.trigger_ghl_message_reconcile()','EXECUTE')
 THEN RAISE EXCEPTION 'c1d the cron caller must not be callable by service_role'; END IF;
 IF NOT (SELECT prosecdef FROM pg_proc WHERE oid='public.context_ghl_capture_status()'::regprocedure)
  OR NOT (SELECT prosecdef FROM pg_proc WHERE oid='public.trigger_ghl_message_reconcile()'::regprocedure)
 THEN RAISE EXCEPTION 'c1d status and cron caller must be SECURITY DEFINER'; END IF;
 -- The capture lane owns the job; the other two jobs are unchanged.
 IF (SELECT array_agg(cron_jobname||':'||lane ORDER BY cron_jobname) FROM public.automation_switch_cron_lanes())
    IS DISTINCT FROM ARRAY['contact-matching:attribution','ghl-message-reconcile:capture','monitor-inbox-poll:capture']
 THEN RAISE EXCEPTION 'c1d cron lane list %',(SELECT array_agg(to_jsonb(l)) FROM public.automation_switch_cron_lanes() l); END IF;
END $$;
ROLLBACK;

BEGIN;
-- 2. Nothing built on yet: no flag row (production today), no receipts, no runs.
DO $$
DECLARE s jsonb:=public.context_ghl_capture_status(); c jsonb:=public.context_pipeline_status();
BEGIN
 IF s->'item_flag'<>'{"enabled":false,"state":"missing","updated_at":null}'::jsonb THEN RAISE EXCEPTION 'c1d missing flag must read off %',s->'item_flag'; END IF;
 IF (s->>'capture_lane')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'c1d capture lane %',s->'capture_lane'; END IF;
 IF s->'alarms'<>'[]'::jsonb THEN RAISE EXCEPTION 'c1d flag off must raise no alarm %',s->'alarms'; END IF;
 IF s#>>'{webhooks,received_24h}'<>'0' OR s#>'{reconciler,last_run}'<>'null'::jsonb OR s#>>'{reconciler,webhook_misses_24h}'<>'0'
 THEN RAISE EXCEPTION 'c1d empty status %',s; END IF;
 IF NOT s->'not_measured' @> '["contactless_sibling_matches"]' THEN RAISE EXCEPTION 'c1d not_measured %',s->'not_measured'; END IF;
 -- The composer now carries the block (it was null while F1's stub stood).
 IF jsonb_typeof(c->'ghl_capture')<>'object' OR c#>'{ghl_capture,policy,item_flag}'<>'"ghl_message_capture_v2"'
 THEN RAISE EXCEPTION 'c1d composer block %',c->'ghl_capture'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 3. Flag off: the reconciler is idle, so a quiet door and no runs are not alarms.
INSERT INTO public.feature_flags(flag_name,enabled,updated_at) VALUES('ghl_message_capture_v2',false,now()-interval '4 days');
SELECT pg_temp.c1d_receipt('InboundMessage','capture_disabled','app_signature','observe',now()-interval '4 days');
DO $$
DECLARE s jsonb:=public.context_ghl_capture_status();
BEGIN
 IF s#>>'{item_flag,enabled}'<>'false' OR s#>>'{item_flag,state}'<>'present' THEN RAISE EXCEPTION 'c1d flag row off %',s->'item_flag'; END IF;
 IF pg_temp.c1d_alarm_keys(s)<>'{}' THEN RAISE EXCEPTION 'c1d flag off alarms %',s->'alarms'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 4. Flag on, nothing arriving: sms.md §8 F1 (GHL stopped sending) and F6
-- (the reconciler stopped): ghl_webhooks_quiet and ghl_reconcile_stale.
INSERT INTO public.feature_flags(flag_name,enabled,updated_at) VALUES('ghl_message_capture_v2',true,now()-interval '4 days');
SELECT pg_temp.c1d_receipt('InboundMessage','event_created','app_signature','observe',now()-interval '4 days');
-- A workflow post today does not prove the app is sending.
SELECT pg_temp.c1d_receipt('CallCompleted','event_created','workflow_secret','observe',now()-interval '5 minutes');
-- The last successful run was an hour ago; the newest run failed (rate limit).
SELECT pg_temp.c1d_run('succeeded','{"inserted":0,"webhook_misses":0}');
UPDATE public.context_capture_runs SET started_at=now()-interval '61 minutes',finished_at=now()-interval '60 minutes',updated_at=now()-interval '60 minutes';
SELECT pg_temp.c1d_run('failed','{"inserted":0}','ghl_rate_limited');
DO $$
DECLARE s jsonb:=public.context_ghl_capture_status(); a jsonb;
BEGIN
 IF pg_temp.c1d_alarm_keys(s)<>ARRAY['ghl_reconcile_stale','ghl_webhooks_quiet'] THEN RAISE EXCEPTION 'c1d F1/F6 alarms %',s->'alarms'; END IF;
 SELECT x INTO a FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='ghl_reconcile_stale';
 IF a->>'last_run_status'<>'failed' OR a->>'last_run_error'<>'ghl_rate_limited' OR a->>'severity'<>'warning' OR a->>'what_to_do' IS NULL
 THEN RAISE EXCEPTION 'c1d stale alarm detail %',a; END IF;
 IF s#>>'{reconciler,runs_24h,failed}'<>'1' OR s#>>'{reconciler,failed_runs_24h}'<>'1' THEN RAISE EXCEPTION 'c1d run counts %',s->'reconciler'; END IF;
 IF (s#>>'{webhooks,last_webhook_at}')::timestamptz<now()-interval '10 minutes'
  OR (s#>>'{webhooks,last_app_webhook_at}')::timestamptz>now()-interval '3 days'
 THEN RAISE EXCEPTION 'c1d last webhook times %',s->'webhooks'; END IF;
 -- The composer carries the block's alarms, tagged with the block.
 IF NOT public.context_pipeline_status()->'alarms' @> '[{"block":"ghl_capture","key":"ghl_webhooks_quiet"},{"block":"ghl_capture","key":"ghl_reconcile_stale"}]'
 THEN RAISE EXCEPTION 'c1d composer alarms %',public.context_pipeline_status()->'alarms'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 5. Healthy: an app webhook a minute ago and a successful run 10 minutes ago.
INSERT INTO public.feature_flags(flag_name,enabled,updated_at) VALUES('ghl_message_capture_v2',true,now()-interval '4 days');
SELECT pg_temp.c1d_receipt('InboundMessage','event_created','app_signature','observe',now()-interval '1 minute');
SELECT pg_temp.c1d_run('partial','{"inserted":2,"webhook_misses":2,"backlog_conversations":4}');
UPDATE public.context_capture_runs SET finished_at=now()-interval '10 minutes';
DO $$
DECLARE s jsonb:=public.context_ghl_capture_status();
BEGIN
 IF pg_temp.c1d_alarm_keys(s)<>'{}' THEN RAISE EXCEPTION 'c1d healthy alarms %',s->'alarms'; END IF;
 IF s#>>'{reconciler,backlog_conversations}'<>'4' OR s#>>'{reconciler,webhook_misses_24h}'<>'2'
  OR s#>>'{reconciler,watermark}' IS NULL OR s#>>'{reconciler,last_run,status}'<>'partial'
 THEN RAISE EXCEPTION 'c1d healthy reconciler %',s->'reconciler'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 6. ghl_webhook_misses_high: more than 5 in 24 h, and only within 24 h.
SELECT pg_temp.c1d_run('succeeded','{"webhook_misses":3}');
SELECT pg_temp.c1d_run('succeeded','{"webhook_misses":2}');
SELECT pg_temp.c1d_run('succeeded','{"webhook_misses":9}');
UPDATE public.context_capture_runs SET started_at=now()-interval '25 hours'
 WHERE (counts->>'webhook_misses')::int=9;
DO $$
BEGIN
 IF pg_temp.c1d_alarm_keys(public.context_ghl_capture_status())<>'{}' THEN RAISE EXCEPTION 'c1d 5 misses must not alarm'; END IF;
END $$;
SELECT pg_temp.c1d_run('succeeded','{"webhook_misses":1}');
DO $$
DECLARE s jsonb:=public.context_ghl_capture_status();
BEGIN
 IF pg_temp.c1d_alarm_keys(s)<>ARRAY['ghl_webhook_misses_high'] OR s#>>'{reconciler,webhook_misses_24h}'<>'6'
 THEN RAISE EXCEPTION 'c1d misses alarm %',s; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 7. Auth: observe-mode missing proofs are counted, never alarmed (gate G-AUTH
-- reads the count); after the enforcing flip any refused post is a critical
-- security alarm. Receipts of other kinds or sources are ignored.
SELECT pg_temp.c1d_receipt('CallCompleted','event_created','missing','observe',now()-interval '2 hours');
SELECT pg_temp.c1d_receipt('InboundMessage','unresolved_id','app_signature','observe',now()-interval '3 hours');
SELECT pg_temp.c1d_receipt('InboundMessage','event_created','app_signature','observe',now()-interval '3 hours','raw_body_v0');
SELECT pg_temp.c1d_receipt('InboundMessage','event_created','app_signature','observe',now()-interval '3 hours','ids_only_v1','ghl');
DO $$
DECLARE s jsonb:=public.context_ghl_capture_status();
BEGIN
 IF pg_temp.c1d_alarm_keys(s)<>'{}' THEN RAISE EXCEPTION 'c1d observe mode must not alarm %',s->'alarms'; END IF;
 IF s#>'{webhooks,by_outcome_24h}'<>'{"event_created":1,"unresolved_id":1}' OR s#>'{webhooks,by_auth_24h}'<>'{"missing:observe":1,"app_signature:observe":1}'
  OR s#>>'{webhooks,unresolved_ids_24h}'<>'1' OR s#>>'{webhooks,auth_missing_24h}'<>'1' OR s#>>'{webhooks,received_24h}'<>'2'
 THEN RAISE EXCEPTION 'c1d receipt counts %',s->'webhooks'; END IF;
END $$;
SELECT pg_temp.c1d_receipt('InboundMessage','unauthorized','missing','enforce',now()-interval '30 minutes');
DO $$
DECLARE s jsonb:=public.context_ghl_capture_status(); a jsonb;
BEGIN
 SELECT x INTO a FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key'='ghl_auth_missing';
 IF a IS NULL OR a->>'severity'<>'critical' OR a->>'refused_24h'<>'1' THEN RAISE EXCEPTION 'c1d auth alarm %',s->'alarms'; END IF;
 -- A refused post never counts as "the app is still sending".
 IF (s#>>'{webhooks,last_webhook_at}')::timestamptz>now()-interval '1 hour' THEN RAISE EXCEPTION 'c1d refused post counted as a delivery'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 8. The cron caller posts only while the flag is on, with the service key.
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE pg_temp.c1d_posts(url text,body jsonb,headers jsonb,timeout_ms integer);
CREATE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,headers jsonb DEFAULT '{}'::jsonb,
 timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO pg_temp.c1d_posts VALUES(url,body,headers,timeout_milliseconds) RETURNING 1::bigint
$$;
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text LANGUAGE sql AS $$ SELECT 'eyJ.c1d.fixture'::text $$;
SELECT public.trigger_ghl_message_reconcile();
DO $$ BEGIN IF (SELECT count(*) FROM pg_temp.c1d_posts)<>0 THEN RAISE EXCEPTION 'c1d posted with no flag row'; END IF; END $$;
INSERT INTO public.feature_flags(flag_name,enabled) VALUES('ghl_message_capture_v2',false);
SELECT public.trigger_ghl_message_reconcile();
DO $$ BEGIN IF (SELECT count(*) FROM pg_temp.c1d_posts)<>0 THEN RAISE EXCEPTION 'c1d posted with the flag off'; END IF; END $$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='ghl_message_capture_v2';
SELECT public.trigger_ghl_message_reconcile();
DO $$
DECLARE p record;
BEGIN
 SELECT * INTO p FROM pg_temp.c1d_posts;
 IF (SELECT count(*) FROM pg_temp.c1d_posts)<>1 OR p.url<>'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ghl-message-reconcile'
  OR p.headers->>'Authorization'<>'Bearer eyJ.c1d.fixture' OR p.body<>'{"actor":"cron:ghl-message-reconcile"}' OR p.timeout_ms<>5000
 THEN RAISE EXCEPTION 'c1d cron post %',row_to_json(p); END IF;
END $$;
ROLLBACK;

BEGIN;
-- 9. The schedule, on a pg_cron stand-in (pg_cron 1.6 columns): created gated,
-- idempotent on re-apply, recognised by the switch's wrap and unwrap.
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY,schedule text NOT NULL,command text NOT NULL,active boolean NOT NULL DEFAULT true,jobname text);
CREATE FUNCTION cron.schedule(job_name text,schedule text,command text) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO cron.job(jobname,schedule,command) VALUES(job_name,schedule,command) RETURNING jobid
$$;
CREATE FUNCTION cron.alter_job(job_id bigint,schedule text DEFAULT NULL,command text DEFAULT NULL,database text DEFAULT NULL,
 username text DEFAULT NULL,active boolean DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
 UPDATE cron.job SET command=coalesce(alter_job.command,job.command) WHERE jobid=job_id
$$;
\ir ../../../migrations/20260924133000_context_ghl_message_reconcile.sql
\ir ../../../migrations/20260924133000_context_ghl_message_reconcile.sql
DO $$
DECLARE w record;
BEGIN
 IF (SELECT count(*) FROM cron.job WHERE jobname='ghl-message-reconcile')<>1 THEN RAISE EXCEPTION 'c1d re-apply scheduled twice'; END IF;
 IF (SELECT command FROM cron.job WHERE jobname='ghl-message-reconcile')<>'SELECT public.trigger_ghl_message_reconcile() WHERE public.automation_lane_enabled(''capture'')'
  OR (SELECT schedule FROM cron.job WHERE jobname='ghl-message-reconcile')<>'3-59/15 * * * *'
 THEN RAISE EXCEPTION 'c1d job %',(SELECT row_to_json(j) FROM cron.job j WHERE jobname='ghl-message-reconcile'); END IF;
 SELECT * INTO w FROM public.automation_switch_wrap_cron_jobs() x WHERE x.cron_jobname='ghl-message-reconcile';
 IF w.outcome<>'already_wrapped' THEN RAISE EXCEPTION 'c1d wrap %',row_to_json(w); END IF;
 SELECT * INTO w FROM public.automation_switch_unwrap_cron_jobs() x WHERE x.cron_jobname='ghl-message-reconcile';
 IF w.outcome<>'unwrapped' OR (SELECT command FROM cron.job WHERE jobname='ghl-message-reconcile')<>'SELECT public.trigger_ghl_message_reconcile()'
 THEN RAISE EXCEPTION 'c1d unwrap %',row_to_json(w); END IF;
END $$;
ROLLBACK;
