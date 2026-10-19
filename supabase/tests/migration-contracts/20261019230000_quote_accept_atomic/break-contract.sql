-- Remove the atomic context from the trigger's final raise: the contract must then fail when
-- an atomic acceptance whose supersede run records nothing is not rolled back.
CREATE OR REPLACE FUNCTION public.accept_quote_document_atomic(
  p_document_id uuid, p_accepted_at timestamptz, p_job_status text, p_fingerprint text,
  p_run_label text, p_accept_event jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_job uuid;
BEGIN
  SELECT job_id INTO v_job FROM public.job_documents WHERE id = p_document_id;
  UPDATE public.job_documents SET accepted_at = p_accepted_at WHERE id = p_document_id;
  UPDATE public.jobs SET status = p_job_status WHERE id = v_job;
  INSERT INTO public.quote_acceptance_attempts (document_id, job_id, run_label, job_status, accepted_at)
  VALUES (p_document_id, v_job, p_run_label, p_job_status, p_accepted_at);
  RETURN jsonb_build_object('outcome', 'accepted');
END $$;
