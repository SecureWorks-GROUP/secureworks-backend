-- Stand the historical mark/build contract back up; the successor has its own proofs.
\ir ../../../rollbacks/20261117172503_job_pages_queue_safety_down.sql
CREATE OR REPLACE FUNCTION public.job_pages_keep_ready_set() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 SELECT id FROM public.jobs WHERE false
$fn$;
