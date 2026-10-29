-- A live materials_ai_candidate_jobs that is neither 20261028173000's nor this
-- migration's, and a job picture helper whose body is not this migration's but
-- whose comment is: the migration must refuse both and name both.
\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION public.materials_ai_candidate_jobs(p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$ SELECT '[]'::jsonb $$;
CREATE FUNCTION public.context_job_picture(p_job_ids uuid[], p_phone_keys text[] DEFAULT NULL,
                                           p_email_keys text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$ SELECT '[]'::jsonb $$;
COMMENT ON FUNCTION public.context_job_picture(uuid[], text[], text[]) IS 'Job picture (20261029200000): drifted body, comment kept.';
