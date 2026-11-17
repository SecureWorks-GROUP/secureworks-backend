CREATE OR REPLACE FUNCTION public.job_page_refresh(p_job_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 SELECT '{"outcome":"built","build_ms":0}'::jsonb
$fn$;
