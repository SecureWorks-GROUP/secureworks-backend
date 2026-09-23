-- Roll back F-ACT (20260924201000_ops_api_actor_recording).
--
-- Refuses if context_core_status() is no longer the F-ACT body (a later
-- foundation slice owns it now; roll that back first). Otherwise it restores
-- F1's context_core_status() byte for byte (md5 3df30c5ccf6db32c4782ba7859591b86,
-- checked afterwards), then drops context_actor_missing_status(),
-- record_ops_api_actor_call() and the ops_api_actor_calls counter. The counter
-- holds counts only (no actor, no request content); its loss removes the
-- actor_missing history, nothing else. The ops-api log line keeps naming the
-- actor after this runs; ops-api's count call then fails quietly (it is
-- best-effort and never affects a request), so roll back the edge code in the
-- same change when possible. No flag, switch or other row is touched.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_core_status()')) IS DISTINCT FROM 'e26a2d4387c9f642f473aa16caf4ab98'
 THEN RAISE EXCEPTION 'f_act_rollback_refused: context_core_status() is no longer the F-ACT body; roll back its later owner first'; END IF;
END $$;

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
  'coverage',public.context_coverage());
END $$;
COMMENT ON FUNCTION public.context_core_status() IS
 'Status block core: the 17 Sep heartbeat body, unchanged. Its keys are the top-level keys of context_pipeline_status(). Owned by F1.';
REVOKE ALL ON FUNCTION public.context_core_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_core_status() TO service_role;

DROP FUNCTION IF EXISTS public.context_actor_missing_status();
DROP FUNCTION IF EXISTS public.record_ops_api_actor_call(text,text,text);
DROP TABLE IF EXISTS public.ops_api_actor_calls;

DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_core_status()')) IS DISTINCT FROM '3df30c5ccf6db32c4782ba7859591b86'
 THEN RAISE EXCEPTION 'f_act_rollback_failed: context_core_status() was not restored to the F1 body'; END IF;
END $$;
