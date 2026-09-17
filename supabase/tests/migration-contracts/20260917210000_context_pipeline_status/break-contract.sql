-- Restore the event_at-only missing-time count so the coalesce contract fails.
CREATE OR REPLACE FUNCTION public.context_pipeline_status() RETURNS jsonb
LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object(
  'run_date',(now() AT TIME ZONE 'Australia/Perth')::date,
  'model_call_budget_state','available',
  'model_calls_used',0,
  'missing_event_time',(SELECT count(*) FROM public.business_events WHERE event_at IS NULL AND attribution_status NOT IN ('empty','automated')),
  'coverage',public.context_coverage())
$$;
