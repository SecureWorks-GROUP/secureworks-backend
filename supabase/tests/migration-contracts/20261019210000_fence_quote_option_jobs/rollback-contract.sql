-- Rollback contract: 20261019210000_fence_quote_option_jobs. The down drops the trigger, both
-- functions, the switch row, the index, the check and the four columns, and leaves jobs in place.
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs'
             AND column_name IN ('quote_option_group_id', 'quote_option_label', 'superseded_by_job_id', 'superseded_at')) THEN
  RAISE EXCEPTION 'fence quote option rollback contract: a column still exists';
 END IF;
 IF to_regprocedure('public.link_fence_quote_option(uuid, uuid, text, uuid)') IS NOT NULL THEN
  RAISE EXCEPTION 'fence quote option rollback contract: the link function still exists';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_jobs_quote_option_supersede') THEN
  RAISE EXCEPTION 'fence quote option rollback contract: the trigger still exists';
 END IF;
 IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'quote_option_supersede_v1') THEN
  RAISE EXCEPTION 'fence quote option rollback contract: the switch row still exists';
 END IF;
END $$;
SELECT count(*) FROM public.jobs;
