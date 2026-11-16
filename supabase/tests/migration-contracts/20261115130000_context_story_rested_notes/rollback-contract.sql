-- After the down: the two new functions are gone and the story is the earlier body again.
DO $c$
BEGIN
 IF to_regprocedure('public.context_job_story_rest(jsonb,jsonb,timestamptz)') IS NOT NULL
    OR to_regprocedure('public.context_job_story_rest_policy()') IS NOT NULL THEN
  RAISE EXCEPTION 'rested notes rollback: the rest functions must be dropped';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)'::regprocedure)
    IS DISTINCT FROM '24dd8ff26a2565acd6006813fb3e24af' THEN
  RAISE EXCEPTION 'rested notes rollback: the story must be the earlier body';
 END IF;
END $c$;
