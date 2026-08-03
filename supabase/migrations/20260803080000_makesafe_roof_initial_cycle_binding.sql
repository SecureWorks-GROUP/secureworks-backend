-- A live roof-report card must acquire its first immutable attendance identity
-- and bind the detail pointer in one transaction. The existing cycle identity
-- trigger refuses deletes, so split insert/update calls cannot safely clean up
-- after a partial failure.

CREATE OR REPLACE FUNCTION public.bind_makesafe_roof_initial_cycle_v1(
  p_job_id uuid,
  p_open_reason text,
  p_expected_case_id uuid DEFAULT NULL,
  p_expected_cycle_count integer DEFAULT 0,
  p_expected_existing_cycle_id uuid DEFAULT NULL,
  p_require_zero_operational_evidence boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job public.jobs%ROWTYPE;
  v_detail public.makesafe_job_details%ROWTYPE;
  v_cycle public.makesafe_attendance_cycles%ROWTYPE;
  v_cycle_count integer;
  v_case_count integer;
  v_matching_case_count integer;
  v_evidence_count bigint;
  v_updated_count integer;
  v_cycle_created boolean := false;
BEGIN
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'roof initial cycle binding requires a job id';
  END IF;
  IF btrim(COALESCE(p_open_reason, '')) = '' THEN
    RAISE EXCEPTION 'roof initial cycle binding requires an open reason';
  END IF;
  IF p_expected_cycle_count IS NULL OR p_expected_cycle_count NOT IN (0, 1) THEN
    RAISE EXCEPTION 'roof initial cycle binding expected cycle count must be zero or one';
  END IF;
  IF (p_expected_cycle_count = 0) <> (p_expected_existing_cycle_id IS NULL) THEN
    RAISE EXCEPTION 'roof initial cycle binding expected cycle identity is inconsistent';
  END IF;

  SELECT job.*
  INTO v_job
  FROM public.jobs job
  WHERE job.id = p_job_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_job.type IS DISTINCT FROM 'makesafe'
     OR v_job.metadata->>'makesafe_job_family' IS DISTINCT FROM 'roof_report' THEN
    RAISE EXCEPTION 'roof initial cycle binding job identity drifted';
  END IF;
  IF lower(COALESCE(v_job.status, '')) IN (
    'archived', 'complete', 'completed', 'closed', 'cancelled', 'canceled',
    'lost', 'deleted'
  ) THEN
    RAISE EXCEPTION 'roof initial cycle binding refuses a terminal job';
  END IF;

  SELECT detail.*
  INTO v_detail
  FROM public.makesafe_job_details detail
  WHERE detail.job_id = p_job_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_detail.report_type IS DISTINCT FROM 'roof_report'
     OR v_detail.cycle_number IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'roof initial cycle binding detail identity drifted';
  END IF;
  IF v_detail.attendance_cycle_id IS NOT NULL
     OR v_detail.cycle_attribution IS NOT NULL THEN
    RAISE EXCEPTION 'roof initial cycle binding requires an unbound detail row';
  END IF;

  IF p_expected_case_id IS NOT NULL THEN
    PERFORM 1
    FROM public.makesafe_intake_cases intake_case
    WHERE intake_case.job_id = p_job_id
      AND intake_case.target_job_id IS NULL
      AND intake_case.state = 'confirmed_live_job'
    FOR SHARE;
    SELECT
      count(*),
      count(*) FILTER (
        WHERE intake_case.id = p_expected_case_id
          AND btrim(COALESCE(intake_case.instruction_key, '')) <> ''
          AND btrim(COALESCE(v_detail.external_ref, '')) <> ''
          AND (
            regexp_replace(upper(COALESCE(v_detail.external_ref, '')), '[^A-Z0-9]', '', 'g') =
              regexp_replace(upper(COALESCE(intake_case.builder_wo_canonical, '')), '[^A-Z0-9]', '', 'g')
            OR regexp_replace(upper(COALESCE(v_detail.external_ref, '')), '[^A-Z0-9]', '', 'g') =
              regexp_replace(upper(COALESCE(intake_case.builder_po_canonical, '')), '[^A-Z0-9]', '', 'g')
            OR regexp_replace(upper(COALESCE(v_detail.external_ref, '')), '[^A-Z0-9]', '', 'g') =
              regexp_replace(upper(COALESCE(intake_case.external_ref_canonical, '')), '[^A-Z0-9]', '', 'g')
          )
      )
    INTO v_case_count, v_matching_case_count
    FROM public.makesafe_intake_cases intake_case
    WHERE intake_case.job_id = p_job_id
      AND intake_case.target_job_id IS NULL
      AND intake_case.state = 'confirmed_live_job';
    IF v_case_count <> 1 OR v_matching_case_count <> 1 THEN
      RAISE EXCEPTION 'roof initial cycle binding canonical intake authority drifted';
    END IF;
  END IF;

  IF p_require_zero_operational_evidence THEN
    SELECT
      (SELECT count(*) FROM public.job_assignments WHERE job_id = p_job_id) +
      (SELECT count(*) FROM public.job_service_reports WHERE job_id = p_job_id) +
      (SELECT count(*) FROM public.job_media WHERE job_id = p_job_id) +
      (SELECT count(*) FROM public.makesafe_report_packs WHERE job_id = p_job_id) +
      (SELECT count(*) FROM public.makesafe_portal_capture_revisions WHERE job_id = p_job_id) +
      (SELECT count(*) FROM public.makesafe_roof_report_drafts WHERE job_id = p_job_id) +
      (SELECT count(*) FROM public.makesafe_docket_revisions WHERE job_id = p_job_id) +
      (SELECT count(*) FROM public.job_documents WHERE job_id = p_job_id AND type = 'roof_report')
    INTO v_evidence_count;
    IF v_evidence_count <> 0 THEN
      RAISE EXCEPTION 'roof initial cycle binding operational evidence drifted';
    END IF;
  END IF;

  PERFORM 1
  FROM public.makesafe_attendance_cycles cycle
  WHERE cycle.job_id = p_job_id
  FOR UPDATE;
  SELECT count(*)
  INTO v_cycle_count
  FROM public.makesafe_attendance_cycles cycle
  WHERE cycle.job_id = p_job_id;
  IF v_cycle_count IS DISTINCT FROM p_expected_cycle_count THEN
    RAISE EXCEPTION 'roof initial cycle binding immutable cycle set drifted';
  END IF;

  IF v_cycle_count = 1 THEN
    SELECT cycle.*
    INTO v_cycle
    FROM public.makesafe_attendance_cycles cycle
    WHERE cycle.job_id = p_job_id;
    IF v_cycle.id IS DISTINCT FROM p_expected_existing_cycle_id
       OR v_cycle.cycle_number IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'roof initial cycle binding existing cycle identity drifted';
    END IF;
  ELSE
    INSERT INTO public.makesafe_attendance_cycles (
      job_id,
      cycle_number,
      open_reason
    ) VALUES (
      p_job_id,
      1,
      p_open_reason
    )
    RETURNING * INTO v_cycle;
    v_cycle_created := true;
  END IF;

  UPDATE public.makesafe_job_details detail
  SET attendance_cycle_id = v_cycle.id,
      cycle_attribution = 'bound',
      updated_at = now()
  WHERE detail.job_id = p_job_id
    AND detail.cycle_number = 1
    AND detail.attendance_cycle_id IS NULL
    AND detail.cycle_attribution IS NULL;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION 'roof initial cycle binding detail update drifted';
  END IF;

  RETURN jsonb_build_object(
    'attendance_cycle_id', v_cycle.id,
    'cycle_number', v_cycle.cycle_number,
    'cycle_created', v_cycle_created,
    'cycle_bound', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bind_makesafe_roof_initial_cycle_v1(
  uuid, text, uuid, integer, uuid, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_makesafe_roof_initial_cycle_v1(
  uuid, text, uuid, integer, uuid, boolean
) TO service_role;

COMMENT ON FUNCTION public.bind_makesafe_roof_initial_cycle_v1(
  uuid, text, uuid, integer, uuid, boolean
) IS
  'Atomically materializes or selects exactly one initial roof-report attendance cycle and binds it to the unbound detail row. Optional exact case and zero-evidence guards support bounded historical recovery.';
