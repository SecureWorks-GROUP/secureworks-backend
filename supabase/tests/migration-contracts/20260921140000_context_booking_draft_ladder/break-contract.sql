-- Restore the pre-Option-A ladder so a contact whose only open job is a draft
-- no longer pins. The positive contract must then fail on that case.
CREATE OR REPLACE FUNCTION public.context_contact_jobs(p_contact_id text) RETURNS SETOF public.jobs
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT j.* FROM public.jobs j WHERE p_contact_id IS NOT NULL
 AND j.status::text NOT IN ('draft','cancelled','archived','lost','closed','complete','completed')
 AND (j.ghl_contact_id=p_contact_id OR EXISTS (SELECT 1 FROM public.contact_matches m
 WHERE m.job_id=j.id AND (m.ghl_contact_id=p_contact_id OR to_jsonb(m)->>'xero_contact_id'=p_contact_id)))
$$;
