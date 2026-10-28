-- After the rollback of 20261028190000_context_story_money_book: the saved job story is
-- 20261009100000's again (the policy at 80 calls a day, the staff read without the Money block,
-- the writer's input v1) and none of this migration's functions remain.
\set ON_ERROR_STOP on
DO $$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_job_story_book_policy()', 'public.context_job_story_money_words(numeric)',
   'public.context_job_story_money_sig(uuid)', 'public.context_job_story_book(uuid,timestamptz)', 'public.context_job_story_full_hash(jsonb)'] LOOP
  IF to_regprocedure(f) IS NOT NULL THEN RAISE EXCEPTION 'story money book rollback: % remains', f; END IF;
 END LOOP;
 IF (public.context_job_story_text_policy() ->> 'calls_per_day')::integer <> 80 THEN
  RAISE EXCEPTION 'story money book rollback: the policy is not 20261009100000''s';
 END IF;
 FOREACH f IN ARRAY ARRAY['public.context_job_story_text_policy()', 'public.context_job_story_request(uuid,text,text)',
   'public.context_job_story_enqueue_changed(integer)', 'public.context_job_story_writer_input(uuid)',
   'public.context_job_story_text_get(uuid,jsonb,boolean)'] LOOP
  IF obj_description(to_regprocedure(f), 'pg_proc') NOT LIKE 'Job story text (20261009100000)%' THEN
   RAISE EXCEPTION 'story money book rollback: % comment is not 20261009100000''s', f;
  END IF;
 END LOOP;
END $$;
