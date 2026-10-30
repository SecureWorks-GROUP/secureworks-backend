-- Deliberately remove the second key: every decision above the bar is placed
-- at once, as before TP-03. The contract must catch it.
\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION public.materials_ai_hard_keys(p_bill text, p_job_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$ SELECT jsonb_build_object('keys', '["job_number"]'::jsonb, 'evidence', '{}'::jsonb) $$;
