\set ON_ERROR_STOP on
DO $c$ BEGIN
 IF to_regprocedure('public.install_job_story_stored_profit()') IS NOT NULL
 OR to_regprocedure('public.context_job_story_book_switch(uuid,timestamptz)') IS NOT NULL
 OR to_regprocedure('public.context_job_story_book_stored(uuid,timestamptz)') IS NOT NULL
 OR to_regprocedure('public.job_story_stored_profit_as_at(uuid,timestamptz)') IS NOT NULL
 OR to_regprocedure('public.context_job_story_text_get_stamped(uuid,jsonb,boolean)') IS NOT NULL
 OR to_regclass('public.job_profit_change_events_job_idx') IS NOT NULL THEN
  RAISE EXCEPTION 'FU26.1 rollback left an object'; END IF;
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_story_stored_profit_v1') THEN
  RAISE EXCEPTION 'FU26.1 rollback left the switch'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure)
    NOT IN ('fc9a1c8f605a1dfd6c7d1ef7667bfa0d','af4fc8363060be37e1aec1046d933561')
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure)
    <>'ac51513f6164fa256011d67c1bd82b10' THEN
  RAISE EXCEPTION 'FU26.1 rollback changed an entry point'; END IF;
END $c$;
