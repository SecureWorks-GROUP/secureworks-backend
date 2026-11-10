-- After the down migration the release is back to exactly 'accepted'.
BEGIN;
DO $$
BEGIN
  ASSERT position('IS DISTINCT FROM ''accepted''' IN pg_get_functiondef(
    'public.release_scope_job_drafts(uuid,uuid,boolean)'::regprocedure)) > 0,
    'the down migration restores the accepted-only release';
  ASSERT NOT has_function_privilege('authenticated', 'public.release_scope_job_drafts(uuid,uuid,boolean)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.release_scope_job_drafts(uuid,uuid,boolean)', 'EXECUTE'),
    'the release stays the service role''s only';
END $$;
ROLLBACK;
