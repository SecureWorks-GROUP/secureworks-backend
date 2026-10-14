-- Daily placement re-check: messages first; delayed placement is not fresh news.
-- Based on SELECT pg_get_functiondef reads from production on 14 Oct 2026.
-- Both prosrc bodies equal their latest repository definitions byte for byte:
-- rerun: 20260924140000; core status: 20261013100000.
-- No data run, no budget/setting change, no new eligibility or placement rule.
-- Message types come from the eligible-row census and their capture producers;
-- no event is excluded. See docs/context/placement-recheck.md for counts/safety.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
DECLARE x record; actual text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.rerun_context_attribution(integer,text)', ARRAY['c80fea38727a0302b57a1111e6099c1c','70326b3836093f400ddf44558a66846e']),
  ('public.context_core_status()', ARRAY['07c51159715c91663a1038f01bf6e09c','bf6a84ad3b2fdcc0f9f1ba2f253b72a2'])
 ) AS t(sig, accepted) LOOP
  SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid=to_regprocedure(x.sig);
  IF actual IS NULL OR NOT actual=ANY(x.accepted) THEN
   RAISE EXCEPTION 'placement recheck pre-image drift: % md5 %', x.sig, actual;
  END IF;
 END LOOP;
END $guard$;

CREATE OR REPLACE FUNCTION public.rerun_context_attribution(p_limit integer DEFAULT 250, p_contact_id text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  e public.business_events;
  resolved public.business_events;
  n int := 0;
BEGIN
  IF NOT public.automation_lane_enabled('attribution') THEN RETURN 0; END IF;
  FOR e IN
    SELECT * FROM public.business_events
    WHERE (attribution_status = 'admin_bucket' OR attribution_status IS NULL)
      AND job_id IS NULL
      AND (p_contact_id IS NULL OR contact_id = p_contact_id)
    -- Message event types, not channel: reconcile diagnostics also use channel=email.
    -- Preserve the existing least-recently-checked rotation inside each priority.
    ORDER BY CASE WHEN event_type IN (
      'client.reply', 'client.sms_in', 'client.sms_out',
      'client.email_in', 'client.email_out', 'client.email_forwarded',
      'supplier.email_in', 'staff.email_internal', 'staff.email_unknown_audience',
      'client.call_logged', 'client.call_complete', 'client.call_initiated',
      'call.transcript_completed'
    ) THEN 0 ELSE 1 END,
      attribution_checked_at NULLS FIRST, occurred_at, id
    LIMIT greatest(0, least(coalesce(p_limit, 250), 1000))
    FOR UPDATE SKIP LOCKED
  LOOP
    resolved := public.resolve_context_attribution(e);
    -- Decide with the original mode: the ladder uses it to choose pending_luna
    -- versus resting unplaced. Only then mark a new bind/ask as historical.
    -- Jarvis otherwise treats attributed_at=now on an old reply as fresh news.
    -- A queued Luna placement preserves this metadata when it later binds.
    -- Still-bucket rows keep their mode so a later first ask is not suppressed.
    IF (resolved.job_id IS NOT NULL OR resolved.attribution_status = 'pending_luna')
       AND coalesce(resolved.metadata->>'capture_mode', '') NOT IN ('backfill', 'relink') THEN
      resolved.metadata := coalesce(resolved.metadata, '{}'::jsonb) ||
        jsonb_build_object('capture_mode_before', resolved.metadata->'capture_mode',
                           'capture_mode', 'relink');
    END IF;
    UPDATE public.business_events SET
      job_id = resolved.job_id,
      contact_id = resolved.contact_id,
      attribution_status = resolved.attribution_status,
      attribution_step = resolved.attribution_step,
      attribution_confidence = resolved.attribution_confidence,
      attributed_at = resolved.attributed_at,
      attribution_checked_at = resolved.attribution_checked_at,
      event_at = resolved.event_at,
      match_status = resolved.match_status,
      match_method = resolved.match_method,
      match_confidence = resolved.match_confidence,
      candidate_job_ids = resolved.candidate_job_ids,
      payload = resolved.payload,
      metadata = resolved.metadata
    WHERE id = e.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $function$;

CREATE OR REPLACE FUNCTION public.context_core_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  'runs_used',(SELECT count(*) FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction'),'run_cap',(public.context_cadence_policy_today()->>'model_call_cap')::integer,
  'runs_by_status',(SELECT coalesce(jsonb_object_agg(status,n),'{}'::jsonb) FROM (SELECT status,count(*) n FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction' GROUP BY status) s),
  'failed_by_error',(SELECT coalesce(jsonb_object_agg(coalesce(nullif(error,''),'(none)'),n),'{}'::jsonb) FROM (SELECT error,count(*) n FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction' AND status='failed' GROUP BY error) s),
  'model_calls_used',calls,'model_call_cap',(public.context_cadence_policy_today()->>'model_call_cap')::integer,'model_call_budget_state',call_state,
  'evidence_by_attribution_status',coalesce(queue,'{}'::jsonb),'ready_jobs',ready,'ready_jobs_is_lower_bound',ready=400,
  'admin_bucket_size',(SELECT count(*) FROM public.business_events WHERE attribution_status='admin_bucket'),
  'missing_event_time',(SELECT count(*) FROM public.business_events WHERE event_at IS NULL AND occurred_at IS NULL AND attribution_status NOT IN ('empty','automated')),
  'oldest_pending_event_at',(SELECT min(coalesce(e.event_at, e.occurred_at)) FROM public.business_events e WHERE e.attribution_status NOT IN ('empty','automated') AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')),
  'last_pass_finished_at',(SELECT max(finished_at) FROM public.context_pass_days WHERE status='done'),
  'today_pass',(SELECT to_jsonb(p)-'attribution_done_at' FROM public.context_pass_days p WHERE run_date=d),
  'coverage',public.context_coverage(),
  'actor_missing',public.context_actor_missing_status());
END $function$;
