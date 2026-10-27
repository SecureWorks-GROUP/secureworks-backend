-- After the rollback, context_job_story_meta is the card events (20261021150000) body again.
\set ON_ERROR_STOP 1
DO $$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_job_story_meta(uuid,timestamptz)'))
     <> '8081ce3fad879ce86a321ed3bdc30e46' THEN
    RAISE EXCEPTION 'split cost check rollback: context_job_story_meta is not the 20261021150000 body';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND has_function_privilege('authenticated', 'public.context_job_story_meta(uuid, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'split cost check rollback: a browser role holds a grant';
  END IF;
END $$;
