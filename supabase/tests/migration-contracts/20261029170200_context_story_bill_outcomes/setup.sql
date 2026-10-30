-- Prerequisites for 20261029170200_context_story_bill_outcomes: the H7 read
-- (20261029170100) and the job story's money book (20261028190000), whose four
-- bodies this migration replaces. Adds nothing.
DO $$
BEGIN
  IF to_regprocedure('public.context_job_bill_outcomes(uuid)') IS NULL THEN
    RAISE EXCEPTION 'story bill outcomes setup: context_job_bill_outcomes missing from the registered stack';
  END IF;
  IF to_regprocedure('public.context_job_story_book(uuid,timestamptz)') IS NULL
     OR to_regprocedure('public.context_job_story_full_hash(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'story bill outcomes setup: the story money book missing from the registered stack';
  END IF;
END $$;
