-- F-ACT: who asked, on every ops-api call (INTEGRATION.md X31, Wave 2).
--
-- Owner ruling: per-person identity on every call, for audit only. ops-api
-- reads the verified JWT user, or the x-sw-actor header on a server-key call,
-- and writes it into its log line (supabase/functions/_shared/request_actor.ts
-- and ops-api/actor_calls.ts). A server-key call without one is logged
-- actor_missing and counted here; it is never refused, because refusing would
-- turn an audit field into an access gate.
--
-- This migration is the counting half, owned by the foundation track (same
-- owner as F1 and F1b). Only the missing count is kept: no action name, caller
-- class or present-actor count is stored, so no caller can create a row by
-- choosing what to send.
--
--   1. ops_api_actor_calls: one row per Perth day, `missing` = server-key
--      calls (api_key, routine, agent_read) that carried no usable actor (no
--      x-sw-actor header, or a malformed one). Counts only, never an actor or
--      request content: the log line carries the actor. JWT calls and calls
--      with an actor write nothing. Rows older than 35 days are purged by the
--      writer when it opens a new day row. RLS on, no policies, revoked from
--      PUBLIC, anon, authenticated; service_role may read.
--   2. record_ops_api_actor_missing(): the one writer. Adds one to today's row.
--   3. context_actor_missing_status(): {state, today, last_7_days} for the
--      core status. Never raises: an unreadable counter reads
--      {"state":"unavailable","code":SQLSTATE}, so it can never take the
--      heartbeat down.
--   4. context_core_status(): F1's body with one key added, actor_missing.
--      Core keys are the top-level keys of context_pipeline_status(), so the
--      heartbeat gains that one key and every existing key keeps its value.
--      The composer is not touched.
--
-- No flag or switch changes. No existing row is written or rewritten. No
-- grant, policy or view is added for anon or authenticated.
--
-- Built on the LIVE production definitions, read from production 24 Sep 2026
-- (read-only):
--   context_core_status()      md5(prosrc) 3df30c5ccf6db32c4782ba7859591b86 (F1)
--   context_pipeline_status()  md5(prosrc) 9183a756c0d4b3881507656751c0d422 (F1b; not replaced)
--   ops_api_actor_calls, context_actor_missing_status(): absent
--   ledger: nothing after 20260924183000
-- The guard refuses unless each is still that pre-image or already this
-- migration's result (a re-apply). Anything else is a live change nobody read,
-- and replacing it would silently revert it.
--
-- Rollback: supabase/rollbacks/20260924201000_ops_api_actor_recording_down.sql
-- restores F1's context_core_status() byte for byte (md5 checked), then drops
-- the two functions and the counter table.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; cols text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- Replaced: F1's live body, or this migration's body.
  ('public.context_core_status()',ARRAY['3df30c5ccf6db32c4782ba7859591b86','e26a2d4387c9f642f473aa16caf4ab98'],false),
  -- New: absent, or already this migration's body.
  ('public.record_ops_api_actor_missing()',ARRAY['9fc40f32c34fc28c59c726ab7c437f24'],true),
  ('public.context_actor_missing_status()',ARRAY['fc618726bcec075660deb525225143c9'],true)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF to_regclass('public.ops_api_actor_calls') IS NOT NULL THEN
  SELECT string_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid='public.ops_api_actor_calls'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM 'day date,missing integer,first_at timestamp with time zone,last_at timestamp with time zone'
  THEN problems:=problems||format('ops_api_actor_calls already exists with columns %s',cols); END IF;
 END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'ops_api_actor_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The counter: one row per Perth day, the missing count only.
CREATE TABLE IF NOT EXISTS public.ops_api_actor_calls (
 day date PRIMARY KEY,
 missing integer NOT NULL DEFAULT 0 CHECK (missing>=0),
 first_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.ops_api_actor_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ops_api_actor_calls FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.ops_api_actor_calls TO service_role;
COMMENT ON TABLE public.ops_api_actor_calls IS
 'F-ACT (INTEGRATION X31): per Perth day, server-key ops-api calls that carried no usable actor. The count only, never an actor, action or request content (the ops-api log line carries the actor). Written only through record_ops_api_actor_missing(); service_role has SELECT only. Rows older than 35 days are purged by the writer.';

-- 2. The one writer.
CREATE OR REPLACE FUNCTION public.record_ops_api_actor_missing() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE d date:=(now() AT TIME ZONE 'Australia/Perth')::date; opened boolean;
BEGIN
 INSERT INTO public.ops_api_actor_calls AS c(day,missing) VALUES(d,1)
 ON CONFLICT (day) DO UPDATE SET missing=c.missing+1,last_at=clock_timestamp()
 RETURNING (c.xmax=0) INTO opened;
 IF opened THEN DELETE FROM public.ops_api_actor_calls c WHERE c.day<d-35; END IF;
END $$;
COMMENT ON FUNCTION public.record_ops_api_actor_missing() IS
 'F-ACT: the one writer of ops_api_actor_calls. Adds one server-key call with no usable actor to today''s (Perth) row. Takes no argument, so a caller cannot choose what is stored.';

-- 3. The count the core status carries. Last seven Perth days, today included.
CREATE OR REPLACE FUNCTION public.context_actor_missing_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE d date:=(now() AT TIME ZONE 'Australia/Perth')::date; r jsonb;
BEGIN
 SELECT jsonb_build_object('state','available',
  'today',coalesce(sum(c.missing) FILTER (WHERE c.day=d),0),
  'last_7_days',coalesce(sum(c.missing),0))
 INTO r FROM public.ops_api_actor_calls c WHERE c.day>d-7 AND c.day<=d;
 RETURN r;
EXCEPTION WHEN OTHERS THEN
 RETURN jsonb_build_object('state','unavailable','code',SQLSTATE);
END $$;
COMMENT ON FUNCTION public.context_actor_missing_status() IS
 'F-ACT: server-key ops-api calls with no usable actor (no x-sw-actor header, or a malformed one), today and over the last 7 Perth days. Audit only: such calls are never refused. Never raises; an unreadable counter reads state unavailable.';

-- 4. context_core_status(): F1's body plus the one actor_missing key.
CREATE OR REPLACE FUNCTION public.context_core_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d date:=(now() AT TIME ZONE 'Australia/Perth')::date; switches jsonb; queue jsonb; calls integer; call_state text:='available'; ready integer;
BEGIN
 SELECT to_jsonb(s) INTO switches FROM public.automation_switches s WHERE id=1;
 SELECT jsonb_object_agg(status,n) INTO queue FROM (SELECT coalesce(e.attribution_status,'unknown') status,count(*) n
 FROM public.business_events e WHERE e.attribution_status NOT IN ('empty','automated')
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')
 GROUP BY e.attribution_status) q;
 BEGIN
  EXECUTE 'SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=$1' INTO calls USING d;
 EXCEPTION WHEN OTHERS THEN calls:=NULL;call_state:='unavailable'; END;
 ready:=public.context_ready_jobs_count(400);
 RETURN jsonb_build_object('as_of',now(),'run_date',d,'switches',switches,
  'lanes',jsonb_build_object('capture',public.automation_lane_enabled('capture'),'attribution',public.automation_lane_enabled('attribution'),'extraction',public.automation_lane_enabled('extraction')),
  'runs_used',(SELECT count(*) FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction'),'run_cap',400,
  'runs_by_status',(SELECT coalesce(jsonb_object_agg(status,n),'{}'::jsonb) FROM (SELECT status,count(*) n FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction' GROUP BY status) s),
  'failed_by_error',(SELECT coalesce(jsonb_object_agg(coalesce(nullif(error,''),'(none)'),n),'{}'::jsonb) FROM (SELECT error,count(*) n FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction' AND status='failed' GROUP BY error) s),
  'model_calls_used',calls,'model_call_cap',400,'model_call_budget_state',call_state,
  'evidence_by_attribution_status',coalesce(queue,'{}'::jsonb),'ready_jobs',ready,'ready_jobs_is_lower_bound',ready=400,
  'admin_bucket_size',(SELECT count(*) FROM public.business_events WHERE attribution_status='admin_bucket'),
  'missing_event_time',(SELECT count(*) FROM public.business_events WHERE event_at IS NULL AND occurred_at IS NULL AND attribution_status NOT IN ('empty','automated')),
  'oldest_pending_event_at',(SELECT min(coalesce(e.event_at, e.occurred_at)) FROM public.business_events e WHERE e.attribution_status NOT IN ('empty','automated') AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')),
  'last_pass_finished_at',(SELECT max(finished_at) FROM public.context_pass_days WHERE status='done'),
  'today_pass',(SELECT to_jsonb(p) FROM public.context_pass_days p WHERE run_date=d),
  'coverage',public.context_coverage(),
  'actor_missing',public.context_actor_missing_status());
END $$;
COMMENT ON FUNCTION public.context_core_status() IS
 'Status block core: the 17 Sep heartbeat body, unchanged, plus actor_missing (F-ACT). Its keys are the top-level keys of context_pipeline_status(). Owned by the foundation track (F1, F-ACT).';

-- 5. Grants. No PUBLIC, anon or authenticated execute; service_role only.
REVOKE ALL ON FUNCTION public.record_ops_api_actor_missing(),public.context_actor_missing_status(),public.context_core_status()
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_ops_api_actor_missing(),public.context_actor_missing_status(),public.context_core_status()
TO service_role;
