-- P0-03.1: read-only worker state and due placement rows.
-- No trigger, schedule, switch or existing function is changed.
-- The lane selector uses PL/pgSQL for the explicit invalid-lane exception.
-- Build under the pending-marker migration's lock budget. Writes wait during
-- the index build; do not queue behind a long writer. No row is changed.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE INDEX IF NOT EXISTS business_events_pending_luna_due
  ON public.business_events (occurred_at, id)
  WHERE attribution_status = 'pending_luna';

COMMENT ON INDEX public.business_events_pending_luna_due IS
  'P0-03.1: oldest-first pending placement reads for both context_attribution_due lanes, including an empty backlog.';

CREATE OR REPLACE FUNCTION public.context_attribution_due(p_lane text, p_limit integer DEFAULT 20)
RETURNS SETOF public.business_events
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$ BEGIN
  IF p_lane IS NULL OR p_lane NOT IN ('live', 'history') THEN
    RAISE EXCEPTION 'context_attribution_due: lane must be live or history' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT e.*
  FROM public.business_events e
  WHERE e.attribution_status = 'pending_luna'
    AND NOT (e.metadata @> '{"history_tier":"deep"}'::jsonb)
    AND CASE WHEN p_lane = 'history' THEN
      e.metadata->>'capture_mode' IN ('backfill', 'relink')
      AND (e.metadata->>'capture_mode' = 'backfill' OR e.metadata->>'capture_mode_before' = 'backfill')
    ELSE
      NOT (e.metadata @> '{"capture_mode":"backfill"}'::jsonb)
      AND NOT (e.metadata @> '{"capture_mode":"relink","capture_mode_before":"backfill"}'::jsonb)
    END
    AND NOT EXISTS (
      SELECT 1 FROM public.context_attribution_attempts a
      WHERE a.event_id = e.id AND a.next_at > now()
    )
  ORDER BY e.occurred_at ASC NULLS LAST, e.id ASC
  LIMIT greatest(1, least(p_limit, 200));
END $fn$;
REVOKE ALL ON FUNCTION public.context_attribution_due(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_attribution_due(text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.context_worker_state()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '8s'
AS $fn$ DECLARE
  v_models jsonb := '[]'::jsonb;
  v_date date := (now() AT TIME ZONE 'Australia/Perth')::date; BEGIN
  IF to_regclass('public.context_ai_job_models') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(m)), ''[]''::jsonb) FROM public.context_ai_job_models m'
      INTO v_models;
  END IF;
  RETURN jsonb_build_object(
    'at', clock_timestamp(),
    'lanes', jsonb_build_object(
      'attribution', public.automation_lane_enabled('attribution'),
      'extraction', public.automation_lane_enabled('extraction'),
      'capture', public.automation_lane_enabled('capture')),
    'ledger_settings', (SELECT to_jsonb(st) FROM public.context_ledger_settings st WHERE st.id),
    'cadence', public.context_cadence_policy(),
    'pass', jsonb_build_object('run_date', v_date,
      'status', (SELECT p.status FROM public.context_pass_days p WHERE p.run_date = v_date)),
    'flags', (SELECT coalesce(jsonb_object_agg(f.flag_name, f.enabled), '{}'::jsonb)
      FROM public.feature_flags f WHERE left(f.flag_name, 8) = 'context_'),
    'models', v_models,
    'due', jsonb_build_object(
      'placement_live', (SELECT count(*) FROM public.context_attribution_due('live', 50)),
      'placement_history', (SELECT count(*) FROM public.context_attribution_due('history', 50)),
      'facts', CASE WHEN EXISTS (SELECT 1 FROM public.context_extraction_candidates(1)) THEN 1 ELSE 0 END,
      'notes', (SELECT count(*) FROM (SELECT 1 FROM public.job_change_marks m
        WHERE m.notes_done_at IS NULL OR m.last_marked_at > m.notes_done_at LIMIT 50) due_notes),
      'stories', (SELECT count(*) FROM (SELECT 1 FROM public.context_job_story_requests r
        WHERE r.done_at IS NULL AND (r.lease_expires_at IS NULL OR r.lease_expires_at < now())
          AND coalesce(r.next_attempt_at, '-infinity'::timestamptz) <= now() LIMIT 50) due_stories)),
    'marks_newest', (SELECT max(m.last_marked_at) FROM public.job_change_marks m)
  );
END $fn$;
REVOKE ALL ON FUNCTION public.context_worker_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_worker_state() TO service_role;
