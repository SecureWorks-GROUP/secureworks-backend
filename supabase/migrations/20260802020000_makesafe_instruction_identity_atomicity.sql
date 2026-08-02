CREATE TABLE IF NOT EXISTS public.makesafe_instruction_key_mints (
  org_id uuid NOT NULL,
  instruction_key text NOT NULL,
  draft_id uuid NOT NULL REFERENCES public.makesafe_intake_drafts(id),
  job_id uuid NULL REFERENCES public.jobs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, instruction_key)
);

ALTER TABLE public.makesafe_instruction_key_mints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.makesafe_instruction_key_mints FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.makesafe_instruction_key_mints TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_makesafe_instruction_key_mint(
  p_org_id uuid, p_draft_id uuid, p_instruction_keys text[]
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_key text;
BEGIN
  FOREACH v_key IN ARRAY p_instruction_keys LOOP
    INSERT INTO public.makesafe_instruction_key_mints (org_id, instruction_key, draft_id)
    VALUES (p_org_id, trim(v_key), p_draft_id)
    ON CONFLICT (org_id, instruction_key) DO NOTHING;
    IF NOT EXISTS (
      SELECT 1 FROM public.makesafe_instruction_key_mints
      WHERE org_id = p_org_id AND instruction_key = trim(v_key) AND draft_id = p_draft_id
    ) THEN
      RAISE EXCEPTION 'instruction key already reserved: %', trim(v_key);
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_makesafe_instruction_key_mint(
  p_org_id uuid, p_draft_id uuid
) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM public.makesafe_instruction_key_mints
   WHERE org_id = p_org_id AND draft_id = p_draft_id AND job_id IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.apply_makesafe_work_order_identity_correction(
  p_job_id uuid, p_external_ref text, p_metadata jsonb, p_document_id uuid,
  p_prior_instruction_keys text[], p_corrected_instruction_key text, p_reason text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.makesafe_job_details SET external_ref = p_external_ref WHERE job_id = p_job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'make-safe detail not found for job %', p_job_id; END IF;
  UPDATE public.jobs SET metadata = p_metadata WHERE id = p_job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'job not found: %', p_job_id; END IF;
  INSERT INTO public.job_events (job_id, event_type, detail_json) VALUES (
    p_job_id, 'makesafe_work_order_identity_corrected',
    jsonb_build_object('document_id', p_document_id, 'prior_instruction_keys', p_prior_instruction_keys,
      'corrected_instruction_key', p_corrected_instruction_key, 'reason', p_reason)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_makesafe_instruction_key_mint(uuid, uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_makesafe_instruction_key_mint(uuid, uuid, text[]) TO service_role, postgres;
REVOKE ALL ON FUNCTION public.release_makesafe_instruction_key_mint(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_makesafe_instruction_key_mint(uuid, uuid) TO service_role, postgres;
REVOKE ALL ON FUNCTION public.apply_makesafe_work_order_identity_correction(uuid, text, jsonb, uuid, text[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_makesafe_work_order_identity_correction(uuid, text, jsonb, uuid, text[], text, text) TO service_role, postgres;
