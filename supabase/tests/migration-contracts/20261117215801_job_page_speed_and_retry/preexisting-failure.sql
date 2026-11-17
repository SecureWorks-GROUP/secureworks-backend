CREATE OR REPLACE FUNCTION public.job_page_refresh(p_job_id uuid) RETURNS jsonb
LANGUAGE sql AS $$ SELECT '{"outcome":"unreviewed"}'::jsonb $$;
