-- Measure every live job, leads no longer followed up included: the lead rule
-- is wrapped so it calls every job monitored, which is what a scorecard that
-- ignored the owner's 7 Oct ruling would read. The wrapper keeps the name,
-- shape, security, comment and access, so only the scope checks can catch it.
ALTER FUNCTION public.context_lead_monitored_jobs(uuid[], timestamptz) RENAME TO context_lead_monitored_jobs_unwrapped;
CREATE FUNCTION public.context_lead_monitored_jobs(p_job_ids uuid[] DEFAULT NULL, p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, job_number text, monitored boolean, state text, quote_sent_at timestamptz, customer_at timestamptz,
 cutoff_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
 SELECT u.job_id, u.job_number, true, u.state, u.quote_sent_at, u.customer_at, u.cutoff_at
 FROM public.context_lead_monitored_jobs_unwrapped(p_job_ids, p_as_of) u
$$;
COMMENT ON FUNCTION public.context_lead_monitored_jobs(uuid[], timestamptz) IS
 'Lead cutoff (20261007010000): break proof wrapper that calls every live job monitored.';
REVOKE ALL ON FUNCTION public.context_lead_monitored_jobs(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_lead_monitored_jobs(uuid[], timestamptz) TO service_role;
