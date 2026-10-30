CREATE OR REPLACE FUNCTION public.context_job_story_money_sig(p_job_id uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT 'unknown'::text $$;
