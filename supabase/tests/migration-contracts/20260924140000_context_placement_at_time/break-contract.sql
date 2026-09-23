-- Ship time-blind candidates: every job the contact has open today, whatever
-- the message time (the rule P1a replaces). The contract must catch it.
ALTER FUNCTION public.context_contact_job_timeline(text,timestamptz) RENAME TO context_contact_job_timeline_real;
CREATE FUNCTION public.context_contact_job_timeline(p_contact_id text,p_at timestamptz)
RETURNS TABLE(job_id uuid,job_number text,type text,status text,basis text,created_at timestamptz,
 terminal boolean,terminal_at timestamptz,terminal_time_source text,window_start timestamptz,candidate boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT t.job_id,t.job_number,t.type,t.status,t.basis,t.created_at,t.terminal,t.terminal_at,t.terminal_time_source,t.window_start,NOT t.terminal
 FROM public.context_contact_job_timeline_real(p_contact_id,now()) t
$$;
