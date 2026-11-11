-- Break: let anyone in the company grant an override.
CREATE OR REPLACE FUNCTION public.grant_job_deposit_gate_override(
  p_job_id uuid, p_user_id uuid, p_reason text, p_unpaid_reasons jsonb DEFAULT '[]'::jsonb)
RETURNS public.job_deposit_gate_overrides
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_job record; v_user record; v_row public.job_deposit_gate_overrides;
BEGIN
  SELECT id, org_id INTO v_job FROM public.jobs WHERE id = p_job_id;
  SELECT id, org_id, role, email INTO v_user FROM public.users WHERE id = p_user_id;
  INSERT INTO public.job_deposit_gate_overrides(org_id, job_id, reason, unpaid_reasons, granted_by, granted_by_email, granted_by_role)
    VALUES (v_job.org_id, p_job_id, btrim(p_reason), p_unpaid_reasons, v_user.id, v_user.email, 'admin')
    RETURNING * INTO v_row;
  RETURN v_row;
END $$;
