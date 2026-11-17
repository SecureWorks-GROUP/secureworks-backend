CREATE OR REPLACE FUNCTION public.job_cost_lines_sync_credit_notes(p_credit_note_ids text[])
RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
