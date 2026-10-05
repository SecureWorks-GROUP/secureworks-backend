-- Rollback for 20261006014000_context_job_story.sql: drops the story functions.
-- The record layer (20261006011000) and the ledger tables are left in place.
-- Roll the ops-api read doors back first (they call these functions).
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.context_story_scorecard_jobs(uuid, integer);
DROP FUNCTION IF EXISTS public.context_story_scorecard(timestamptz);
DROP FUNCTION IF EXISTS public.context_client_story(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.context_job_story(uuid, timestamptz, uuid, timestamptz, boolean);
DROP FUNCTION IF EXISTS public.context_job_story_meta(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.context_job_story_ledger(uuid, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.context_job_story_facts(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.context_job_story_assemble(jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz);
