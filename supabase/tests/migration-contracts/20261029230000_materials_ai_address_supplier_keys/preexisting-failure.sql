-- A live materials_ai_hard_keys that is neither 20261029093000's body nor this
-- migration's, though its comment is 20261029093000's: the migration must
-- refuse to replace it and name it.
\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION public.materials_ai_hard_keys(p_bill text, p_job_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$ SELECT jsonb_build_object('keys', '[]'::jsonb, 'evidence', '{}'::jsonb) $$;
COMMENT ON FUNCTION public.materials_ai_hard_keys(text, uuid) IS 'AI bill two keys (20261029093000): drifted body, comment kept.';
