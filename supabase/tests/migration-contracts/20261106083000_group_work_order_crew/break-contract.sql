CREATE OR REPLACE FUNCTION public.group_work_order_crew(p_job_ids uuid[])
RETURNS TABLE(job_id uuid,user_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $$ SELECT NULL::uuid,NULL::uuid WHERE false $$;
