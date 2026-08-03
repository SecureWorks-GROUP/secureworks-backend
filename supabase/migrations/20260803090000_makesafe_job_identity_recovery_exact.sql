CREATE OR REPLACE FUNCTION public.apply_makesafe_job_identity_recovery_exact(
  p_job_id uuid,
  p_expected_external_ref text,
  p_expected_metadata jsonb,
  p_external_ref text,
  p_metadata jsonb,
  p_prior_instruction_keys text[],
  p_corrected_instruction_key text,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_external_ref text;
  v_metadata jsonb;
BEGIN
  SELECT external_ref
    INTO v_external_ref
    FROM public.makesafe_job_details
   WHERE job_id = p_job_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'make-safe detail not found for exact identity recovery';
  END IF;

  SELECT metadata
    INTO v_metadata
    FROM public.jobs
   WHERE id = p_job_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job not found for exact identity recovery';
  END IF;

  IF v_external_ref IS DISTINCT FROM p_expected_external_ref OR
     v_metadata IS DISTINCT FROM p_expected_metadata THEN
    RAISE EXCEPTION 'stale exact identity recovery preimage';
  END IF;

  UPDATE public.makesafe_job_details
     SET external_ref = p_external_ref
   WHERE job_id = p_job_id;
  UPDATE public.jobs
     SET metadata = p_metadata
   WHERE id = p_job_id;
  INSERT INTO public.job_events (job_id, event_type, detail_json)
  VALUES (
    p_job_id,
    'makesafe_work_order_identity_corrected',
    jsonb_build_object(
      'document_id', NULL,
      'prior_instruction_keys', p_prior_instruction_keys,
      'corrected_instruction_key', p_corrected_instruction_key,
      'reason', p_reason
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_makesafe_job_identity_recovery_exact(
  uuid, text, jsonb, text, jsonb, text[], text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_makesafe_job_identity_recovery_exact(
  uuid, text, jsonb, text, jsonb, text[], text, text
) TO service_role, postgres;
