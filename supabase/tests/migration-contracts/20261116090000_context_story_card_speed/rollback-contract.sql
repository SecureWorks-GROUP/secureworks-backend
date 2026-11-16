-- After the down: the story meta is the body 20261030165500 left, with its comment and grants.
DO $c$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_story_meta(uuid,timestamptz)'::regprocedure)
    IS DISTINCT FROM '636e3aa055351f73d4747f610447cd63' THEN
  RAISE EXCEPTION 'card speed rollback: the story meta must be the earlier body';
 END IF;
 IF position('Card speed (20261116090000)' IN obj_description('public.context_job_story_meta(uuid,timestamptz)'::regprocedure, 'pg_proc')) > 0 THEN
  RAISE EXCEPTION 'card speed rollback: the comment must be the earlier one';
 END IF;
 IF has_function_privilege('anon', 'public.context_job_story_meta(uuid,timestamptz)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.context_job_story_meta(uuid,timestamptz)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.context_job_story_meta(uuid,timestamptz)', 'EXECUTE') THEN
  RAISE EXCEPTION 'card speed rollback: service role only';
 END IF;
END $c$;
