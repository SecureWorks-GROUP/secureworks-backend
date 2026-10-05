-- Remove the promise: put M4's reservation back, which counts every offered job
-- for the day and writes a run row even when nothing is due.
CREATE OR REPLACE FUNCTION public.reserve_ghl_history_run(p_max_jobs integer, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pol jsonb:=public.context_ghl_history_policy(); v_actor text:=coalesce(nullif(p_actor,''),'actor_missing');
 live_run record; due jsonb; created jsonb;
BEGIN
 IF v_actor !~ '^[A-Za-z0-9_.:@-]{1,128}$' THEN RAISE EXCEPTION 'history_reserve_actor_invalid'; END IF;
 -- One reservation at a time: a second caller waits here, then sees the first
 -- run's counted jobs.
 PERFORM pg_advisory_xact_lock(hashtextextended('context_ghl_history_load',0));
 SELECT c.id, c.updated_at INTO live_run FROM public.context_capture_runs c
 WHERE c.source=pol->>'run_source' AND c.status='running' ORDER BY c.started_at DESC LIMIT 1;
 IF FOUND THEN
  IF live_run.updated_at>clock_timestamp()-make_interval(mins=>(pol->>'running_stale_minutes')::integer) THEN
   RETURN jsonb_build_object('outcome','run_in_progress','run_id',live_run.id);
  END IF;
  -- The worker died mid-run. Its counted jobs stay counted.
  PERFORM public.record_capture_run(jsonb_build_object('run_id',live_run.id,'source',pol->>'run_source','status','failed','error_code','run_abandoned'));
 END IF;
 due:=public.context_ghl_history_due(p_max_jobs);
 created:=public.record_capture_run(jsonb_build_object('source',pol->>'run_source','status','running','window_to',clock_timestamp(),
  'cursor',jsonb_build_object('v',1,'actor',v_actor),
  'counts',jsonb_build_object('dry_run',0,'jobs_covered',(due->>'jobs_offered')::integer,'daily_job_limit',(due->>'daily_job_limit')::integer,
   'jobs_counted_before',(due->>'jobs_counted_today')::integer,'daily_remaining',(due->>'daily_remaining')::integer,
   'contacts_due',jsonb_array_length(due->'contacts'))));
 RETURN jsonb_build_object('outcome','reserved','run_id',created->>'run_id','due',due);
END $$;
COMMENT ON FUNCTION public.reserve_ghl_history_run(integer,text) IS
 'M4: starts a real history-load run atomically. Under one transaction-scoped advisory lock: refuses while another real run is live (run_in_progress), closes an abandoned one (run_abandoned), selects the due contacts and creates the run row with their jobs already counted in jobs_covered, so simultaneous callers never share the remaining daily quota. Returns {outcome: reserved, run_id, due} or {outcome: run_in_progress, run_id}.';
