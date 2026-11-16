-- After the down: the new function is gone and the story and the rest rule are the earlier bodies.
DO $c$
BEGIN
 IF to_regprocedure('public.context_job_story_closed_paid(jsonb)') IS NOT NULL THEN
  RAISE EXCEPTION 'finished notes rollback: context_job_story_closed_paid must be dropped';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_story_rest(jsonb,jsonb,timestamptz)'::regprocedure)
    IS DISTINCT FROM '40b194570828d7cc834ab8d1a39a390a' THEN
  RAISE EXCEPTION 'finished notes rollback: the rest rule must be the earlier body';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)'::regprocedure)
    IS DISTINCT FROM '8d3084454a285899dcf477018c8f7a3d' THEN
  RAISE EXCEPTION 'finished notes rollback: the story must be the earlier body';
 END IF;
END $c$;
