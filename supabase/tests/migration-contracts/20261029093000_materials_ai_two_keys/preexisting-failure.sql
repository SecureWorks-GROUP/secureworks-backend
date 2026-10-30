-- A live materials_ai_apply that is neither 20261028173000's nor this
-- migration's: the migration must refuse to replace it.
\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION public.materials_ai_apply(p_call uuid, p_model text, p_decision jsonb)
RETURNS jsonb
LANGUAGE sql
AS $$ SELECT jsonb_build_object('outcome', 'drifted') $$;
