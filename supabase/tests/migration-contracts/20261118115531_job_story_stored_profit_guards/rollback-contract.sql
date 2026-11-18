\set ON_ERROR_STOP on
DO $c$ BEGIN
 IF to_regprocedure('public.job_story_stored_profit_arm()') IS NOT NULL
 OR to_regprocedure('public.job_story_stored_profit_setup()') IS NOT NULL
 OR to_regprocedure('public.job_story_stored_profit_rearm_trg()') IS NOT NULL
 OR to_regprocedure('public.job_story_stored_profit_count_trg()') IS NOT NULL
 OR to_regclass('public.job_story_stored_profit_arm') IS NOT NULL
 OR to_regclass('public.job_story_stored_profit_counts') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN ('job_story_stored_profit_rearm','job_story_stored_profit_counts')) THEN
  RAISE EXCEPTION 'FU26.1 follow-up rollback left an object'; END IF;
 -- FU26.1's own bodies are back exactly; no entry point moved.
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_story_stored_profit_as_at(uuid,timestamptz)'::regprocedure)<>'33655a0a0bf3c36cb83ff2796d747af6'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.install_job_story_stored_profit()'::regprocedure)<>'597475dfd06f211f9b836675f0cb172f'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.remove_job_story_stored_profit()'::regprocedure)<>'8e96644715a2ca31fe88b6a48a1df499'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure)<>'935cecb054f2ff9cc77e05df5e1a199a' THEN
  RAISE EXCEPTION 'FU26.1 follow-up rollback did not restore FU26.1''s bodies'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure)
    NOT IN ('fc9a1c8f605a1dfd6c7d1ef7667bfa0d','af4fc8363060be37e1aec1046d933561')
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure)
    <>'ac51513f6164fa256011d67c1bd82b10' THEN
  RAISE EXCEPTION 'FU26.1 follow-up rollback changed an entry point'; END IF;
END $c$;
