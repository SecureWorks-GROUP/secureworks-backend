-- Retained intake cases cannot keep their live-job state after the mutable
-- synthetic job is deleted. Tombstone them honestly and auditably inside the
-- same ledger-bound transaction as the existing readiness/job purge.

CREATE OR REPLACE FUNCTION public.makesafe_intake_case_transition_allowed(
  p_from_state text,
  p_to_state text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE p_from_state
    WHEN 'confirmed_live_job' THEN p_to_state IN (
      'blocked_live_job',
      'synthetic_livefire_terminal'
    )
    WHEN 'blocked_live_job' THEN p_to_state IN (
      'confirmed_live_job',
      'exception',
      'synthetic_livefire_terminal'
    )
    WHEN 'exception' THEN p_to_state IN (
      'confirmed_live_job', 'blocked_live_job', 'accounted_non_wo'
    )
    WHEN 'accounted_non_wo' THEN p_to_state IN ('exception')
    ELSE false
  END;
$$;

ALTER TABLE public.makesafe_intake_cases
  DROP CONSTRAINT IF EXISTS makesafe_intake_cases_state_check;
ALTER TABLE public.makesafe_intake_cases
  ADD CONSTRAINT makesafe_intake_cases_state_check CHECK (state IN (
    'confirmed_live_job',
    'blocked_live_job',
    'exception',
    'accounted_non_wo',
    'synthetic_livefire_terminal'
  ));

ALTER TABLE public.makesafe_intake_cases
  DROP CONSTRAINT IF EXISTS makesafe_intake_cases_reason_code_check;
ALTER TABLE public.makesafe_intake_cases
  ADD CONSTRAINT makesafe_intake_cases_reason_code_check CHECK (reason_code IN (
    'cancellation',
    'cancellation_target_not_found',
    'cancellation_target_ambiguous',
    'cancellation_live_invoice_review',
    'cancellation_target_terminal_conflict',
    'cancellation_apply_failed',
    'duplicate',
    'revision',
    'unknown_builder',
    'non_makesafe',
    'ambiguous_scope',
    'below_identity_floor',
    'adapter_parse_failure',
    'conflicting_fields',
    'awaiting_job_creation',
    'synthetic_livefire_cleanup'
  ));

ALTER TABLE public.makesafe_intake_cases
  ADD CONSTRAINT makesafe_intake_cases_synthetic_terminal_shape_check CHECK (
    state <> 'synthetic_livefire_terminal'
    OR (
      job_id IS NULL
      AND reason_code = 'synthetic_livefire_cleanup'
      AND cardinality(blocked_reasons) = 0
      AND side_effects_suppressed
      AND last_decision_provenance = 'backfill'
      AND (
        raw_identity_json->>'synthetic_livefire_marker'
      ) ~ '^SWG-SES-LIVEFIRE-TEST-ONLY-[0-9A-F]{8}-[0-9A-F]{4}-[1-8][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$'
    )
  );

ALTER TABLE public.makesafe_intake_case_events
  DROP CONSTRAINT IF EXISTS makesafe_intake_case_events_to_state_check;
ALTER TABLE public.makesafe_intake_case_events
  ADD CONSTRAINT makesafe_intake_case_events_to_state_check CHECK (
    to_state IN (
      'confirmed_live_job',
      'blocked_live_job',
      'exception',
      'accounted_non_wo',
      'synthetic_livefire_terminal'
    )
  );

ALTER FUNCTION public.purge_synthetic_livefire_jobs(text)
  RENAME TO purge_synthetic_livefire_jobs_without_case_tombstones;
REVOKE ALL ON FUNCTION
  public.purge_synthetic_livefire_jobs_without_case_tombstones(text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.purge_synthetic_livefire_jobs(
  p_marker text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ledger_job_ids uuid[];
  v_case_tombstones jsonb := '[]'::jsonb;
  v_result jsonb;
  v_job_id uuid;
BEGIN
  IF p_marker !~ '^SWG-SES-LIVEFIRE-TEST-ONLY-[0-9A-F]{8}-[0-9A-F]{4}-[1-8][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$' THEN
    RAISE EXCEPTION 'invalid synthetic live-fire marker';
  END IF;

  SELECT COALESCE(
    array_agg(DISTINCT value::uuid ORDER BY value::uuid),
    ARRAY[]::uuid[]
  )
  INTO v_ledger_job_ids
  FROM public.ses_synthetic_livefire_runs run
  CROSS JOIN LATERAL jsonb_array_elements_text(run.job_ids) item(value)
  WHERE run.marker = p_marker
    AND run.state IN ('active', 'cleanup_complete');
  IF NOT FOUND OR v_ledger_job_ids IS NULL THEN
    RAISE EXCEPTION 'synthetic live-fire run is not purgeable';
  END IF;

  FOR v_job_id IN
    SELECT DISTINCT intake_case.job_id
    FROM public.makesafe_intake_cases intake_case
    WHERE intake_case.job_id = ANY(v_ledger_job_ids)
  LOOP
    PERFORM public.assert_synthetic_livefire_purge_job(
      p_marker,
      v_job_id
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM public.makesafe_intake_cases intake_case
    WHERE intake_case.job_id = ANY(v_ledger_job_ids)
      AND (
        intake_case.raw_identity_json->>'synthetic_livefire_marker'
      ) IS DISTINCT FROM p_marker
  ) THEN
    RAISE EXCEPTION
      'synthetic live-fire cleanup refused an unmarked ledger-job case';
  END IF;

  PERFORM set_config('app.synthetic_livefire_purge_marker', p_marker, true);

  WITH tombstoned AS (
    UPDATE public.makesafe_intake_cases intake_case
    SET
      state = 'synthetic_livefire_terminal',
      reason_code = 'synthetic_livefire_cleanup',
      blocked_reasons = ARRAY[]::text[],
      job_id = NULL,
      side_effects_suppressed = true,
      last_decision_provenance = 'backfill',
      last_decision_actor = 'ses-synthetic-livefire-cleanup',
      last_decision_reason =
        'terminal cleanup for ledger-bound synthetic live-fire job '
        || intake_case.job_id::text
    WHERE intake_case.job_id = ANY(v_ledger_job_ids)
      AND (
        intake_case.raw_identity_json->>'synthetic_livefire_marker'
      ) = p_marker
    RETURNING intake_case.id
  )
  SELECT COALESCE(jsonb_agg(id ORDER BY id), '[]'::jsonb)
  INTO v_case_tombstones
  FROM tombstoned;

  v_result :=
    public.purge_synthetic_livefire_jobs_without_case_tombstones(p_marker);
  RETURN v_result || jsonb_build_object(
    'case_tombstones', v_case_tombstones
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purge_synthetic_livefire_jobs(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_synthetic_livefire_jobs(text)
  TO service_role, postgres;

COMMENT ON FUNCTION public.purge_synthetic_livefire_jobs(text) IS
  'Atomically tombstones only exact-marker cases bound by an active synthetic run ledger, records their audited transition, then invokes the guarded readiness/job purge. Any failure rolls back the complete cleanup transaction.';
