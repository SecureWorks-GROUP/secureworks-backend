DO $check$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure)<>'fc9a1c8f605a1dfd6c7d1ef7667bfa0d'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure)<>'ac51513f6164fa256011d67c1bd82b10' THEN
 RAISE EXCEPTION 'story stored rollback did not restore main'; END IF;
END $check$;
