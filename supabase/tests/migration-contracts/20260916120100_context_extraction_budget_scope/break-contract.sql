CREATE OR REPLACE FUNCTION public.context_job_extractable(j public.jobs) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
