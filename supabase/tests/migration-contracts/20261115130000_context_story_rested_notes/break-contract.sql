-- Remove the promised behaviour: nothing is ever set aside, so the contract's first rest check
-- (a thing somebody said, with no reply owed) must fail.
CREATE OR REPLACE FUNCTION public.context_job_story_rest(p_ledger jsonb, p_story jsonb, p_as_of timestamptz)
RETURNS jsonb LANGUAGE sql STABLE AS $fn$ SELECT NULL::jsonb $fn$;
