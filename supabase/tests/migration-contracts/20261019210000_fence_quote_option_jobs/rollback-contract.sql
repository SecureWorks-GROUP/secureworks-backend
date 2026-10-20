-- Rollback contract: 20261019210000_fence_quote_option_jobs. The down drops the trigger, every
-- function, the event order sequence, the switch row, the index, the check and the four columns, and leaves jobs in place.
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
 IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND (p.proname LIKE 'fence_quote_option_%' OR p.proname = 'jobs_quote_option_supersede')) THEN
  RAISE EXCEPTION 'fence quote option rollback contract: a function still exists';
 END IF;
 IF to_regclass('public.quote_option_settle_runs') IS NOT NULL THEN
  RAISE EXCEPTION 'fence quote option rollback contract: the run table still exists';
 END IF;
 IF to_regclass('public.quote_option_event_seq') IS NOT NULL THEN
  RAISE EXCEPTION 'fence quote option rollback contract: the event order sequence still exists';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_jobs_quote_option_supersede') THEN
  RAISE EXCEPTION 'fence quote option rollback contract: the trigger still exists';
 END IF;
 IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name IN ('quote_option_supersede_v1', 'fence_same_site_guard_v1')) THEN
  RAISE EXCEPTION 'fence quote option rollback contract: the switch row still exists';
 END IF;
END $$;
SELECT count(*) FROM public.jobs;
