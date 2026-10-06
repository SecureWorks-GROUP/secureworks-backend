-- A scorecard function that is not this migration's already exists (another
-- lane wrote one by hand). The guard must refuse and name it, not replace it.
CREATE FUNCTION public.context_scorecard(p_as_of timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
COMMENT ON FUNCTION public.context_scorecard(timestamptz) IS 'hand-made scorecard';
