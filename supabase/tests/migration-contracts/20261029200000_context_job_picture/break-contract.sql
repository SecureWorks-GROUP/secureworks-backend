-- Deliberately break the picture: every given job, holding and cancelled ones
-- included, with its whole row (phones, emails and the scope blob). The
-- contract must catch it.
\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION public.context_job_picture(p_job_ids uuid[], p_phone_keys text[] DEFAULT NULL,
                                                     p_email_keys text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY j.job_number), '[]'::jsonb)
    FROM public.jobs j
   WHERE j.id = ANY (COALESCE(p_job_ids, '{}'::uuid[]))
$$;
