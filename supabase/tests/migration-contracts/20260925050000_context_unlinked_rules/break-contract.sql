-- Ship P4 with an aftercare rule that ignores the invoice: every finished job
-- counts as unpaid, so a paid-up customer's text reaches review flagged as an
-- unpaid balance that does not exist (adminbucket Review M1: the unpaid fact
-- must be the invoice's, never assumed). The contract must catch it.
CREATE OR REPLACE FUNCTION public.context_job_unpaid_at(p_job_id uuid,p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT true $$;
