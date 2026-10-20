-- After the down migration: no reader, no flag row, the tables it does not
-- own are still there, and a second run of the down changes nothing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'context_job_superseded_during') THEN
    RAISE EXCEPTION 'rollback contract: reader still present';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_job_superseded_reader_v1') THEN
    RAISE EXCEPTION 'rollback contract: flag row still present';
  END IF;
  IF to_regclass('public.job_events') IS NULL OR to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the down dropped a table it does not own';
  END IF;
  RAISE NOTICE 'pass: rollback leaves no trace';
END $$;

BEGIN;
\ir ../../../rollbacks/20261020100000_context_job_superseded_reader_down.sql
COMMIT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'context_job_superseded_during')
     OR EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_job_superseded_reader_v1') THEN
    RAISE EXCEPTION 'rollback contract: second down run left a trace';
  END IF;
  RAISE NOTICE 'pass: second down run is a no-op';
END $$;
