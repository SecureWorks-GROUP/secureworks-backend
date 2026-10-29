-- A live materials_ai_candidate_jobs that is neither 20261028173000's nor this
-- migration's: the migration must refuse to replace it.
\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION public.materials_ai_candidate_jobs(p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$ SELECT '[]'::jsonb $$;
