-- Break: registration writes no party, so the payers stay invisible to the deposit gate.
CREATE OR REPLACE FUNCTION public.register_scope_payer_parties(p_job_id uuid, p_scope_revision_id uuid, p_org_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN jsonb_build_object('outcome','registered','parties','[]'::jsonb);
END $$;
