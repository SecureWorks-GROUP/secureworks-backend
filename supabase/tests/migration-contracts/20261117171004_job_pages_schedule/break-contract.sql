CREATE OR REPLACE FUNCTION public.job_pages_keep_ready_set() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 SELECT id FROM public.jobs WHERE false
$fn$;
