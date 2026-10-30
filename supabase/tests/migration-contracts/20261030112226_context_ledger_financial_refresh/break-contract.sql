CREATE OR REPLACE FUNCTION public.context_ledger_record_signature(p_job_id uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT repeat('a',32) $$;
