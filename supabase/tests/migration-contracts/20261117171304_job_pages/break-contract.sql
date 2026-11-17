-- Stand the historical mark/build contract back up; the successor has its own proofs.
\ir ../../../rollbacks/20261117172102_job_pages_queue_safety_down.sql
CREATE OR REPLACE FUNCTION public.job_page_refresh(p_job_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 SELECT '{"outcome":"built","build_ms":0}'::jsonb
$fn$;
