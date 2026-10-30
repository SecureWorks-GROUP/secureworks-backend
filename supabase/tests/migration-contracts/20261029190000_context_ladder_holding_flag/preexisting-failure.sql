-- A body that is not the one TP-04 was built on (here a hand edit of
-- context_job_real): the migration must refuse before it replaces anything.
CREATE OR REPLACE FUNCTION public.context_job_real(p_job_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT nullif(btrim(coalesce(j.job_number,'')),'') IS NOT NULL FROM public.jobs j WHERE j.id=p_job_id),false)
$$;
