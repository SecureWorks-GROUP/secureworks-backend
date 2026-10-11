-- Someone else's change where this migration's pre-image should be: an assembler body that is
-- neither 20261009133000's nor this migration's. The guard must refuse before touching anything.
CREATE OR REPLACE FUNCTION public.context_job_story_assemble(p_job jsonb, p_record jsonb, p_ledger jsonb, p_meta jsonb,
 p_as_of timestamptz, p_since timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE AS $fn$ SELECT '{}'::jsonb $fn$;
