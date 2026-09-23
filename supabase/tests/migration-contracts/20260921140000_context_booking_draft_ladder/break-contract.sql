-- Restore the pre-Option-A ladder so a contact whose only open job is a draft
-- no longer pins. The positive contract must then fail on that case.
CREATE OR REPLACE FUNCTION public.context_contact_jobs(p_contact_id text) RETURNS SETOF public.jobs
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT j.* FROM public.jobs j WHERE p_contact_id IS NOT NULL
 AND j.status::text NOT IN ('draft','cancelled','archived','lost','closed','complete','completed')
 AND (j.ghl_contact_id=p_contact_id OR EXISTS (SELECT 1 FROM public.contact_matches m
 WHERE m.job_id=j.id AND (m.ghl_contact_id=p_contact_id OR to_jsonb(m)->>'xero_contact_id'=p_contact_id)))
$$;
-- Since P1a (20260924140000) the ladder reads its candidates from
-- context_contact_job_timeline, which carries the draft rule; drop drafts there too.
SELECT to_regprocedure('public.context_contact_job_timeline(text,timestamptz)') IS NOT NULL AS p1a_live \gset
\if :p1a_live
ALTER FUNCTION public.context_contact_job_timeline(text,timestamptz) RENAME TO context_contact_job_timeline_real;
CREATE FUNCTION public.context_contact_job_timeline(p_contact_id text,p_at timestamptz)
RETURNS TABLE(job_id uuid,job_number text,type text,status text,basis text,created_at timestamptz,
 terminal boolean,terminal_at timestamptz,terminal_time_source text,window_start timestamptz,candidate boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT t.job_id,t.job_number,t.type,t.status,t.basis,t.created_at,t.terminal,t.terminal_at,t.terminal_time_source,t.window_start,
  t.candidate AND t.status<>'draft'
 FROM public.context_contact_job_timeline_real(p_contact_id,p_at) t
$$;
\endif
