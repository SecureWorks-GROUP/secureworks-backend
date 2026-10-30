-- Plant a constant witness: content corrections with older timestamps must be detected.
CREATE OR REPLACE FUNCTION public.context_job_story_ledger_sig(p_job_id uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$ SELECT md5('constant') $$;
