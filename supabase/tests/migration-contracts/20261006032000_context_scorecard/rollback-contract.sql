-- After the scorecard rollback: its four functions are gone, and everything it
-- read is untouched (the story scorecard of 20261006014000 still answers).
DO $$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_scorecard_policy()','public.context_scorecard_lane_of(text,text,text,text,text,jsonb)',
   'public.context_scorecard(timestamptz)','public.context_scorecard_jobs(uuid,integer,timestamptz)'] LOOP
  IF to_regprocedure(f) IS NOT NULL THEN RAISE EXCEPTION 'scorecard rollback: % left behind', f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_story_scorecard(timestamptz)','public.context_story_scorecard_jobs(uuid,integer)',
   'public.context_source_freshness()','public.context_business_minutes(timestamptz,timestamptz)','public.context_unread_rows(uuid[])'] LOOP
  IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'scorecard rollback: % lost', f; END IF;
 END LOOP;
 IF public.context_story_scorecard_jobs(NULL, 1)->>'version' <> 'story-scorecard-jobs-v1' THEN
  RAISE EXCEPTION 'scorecard rollback: the story scorecard no longer answers';
 END IF;
END $$;
