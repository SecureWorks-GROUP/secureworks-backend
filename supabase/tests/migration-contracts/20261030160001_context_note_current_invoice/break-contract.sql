CREATE OR REPLACE FUNCTION public.context_job_story_note_current_invoice(p_ledger jsonb,p_money jsonb,p_as_of timestamptz) RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT $1 $$;
