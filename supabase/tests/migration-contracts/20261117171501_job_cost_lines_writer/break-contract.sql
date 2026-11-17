CREATE OR REPLACE FUNCTION public.job_cost_lines_upsert_documents(p_docs jsonb)
RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"documents":0,"lines_written":0,"changed":[]}'::jsonb $$;
