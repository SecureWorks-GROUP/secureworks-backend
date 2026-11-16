-- Remove the promised behaviour: a closed, paid job is never read as complete, so the contract's
-- closed and paid check must fail.
CREATE OR REPLACE FUNCTION public.context_job_story_closed_paid(p_story jsonb)
RETURNS jsonb LANGUAGE sql STABLE AS $fn$ SELECT p_story $fn$;
