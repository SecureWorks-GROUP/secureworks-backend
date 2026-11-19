-- Re-apply the actual migration, then read the stored switch: one row, off.
\ir ../../../migrations/20261119090800_job_overview_v2_switch.sql
DO $$ BEGIN
  IF (SELECT count(*) FROM public.feature_flags WHERE flag_name = 'job_overview_v2') <> 1 THEN
    RAISE EXCEPTION 'job overview v2 switch contract: expected one row after re-apply';
  END IF;
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'job_overview_v2') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'job overview v2 switch contract: expected off';
  END IF;
END $$;
-- A row that is already on is left on by a re-apply.
BEGIN;
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_overview_v2';
\ir ../../../migrations/20261119090800_job_overview_v2_switch.sql
DO $$ BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'job_overview_v2') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'job overview v2 switch contract: a re-apply changed an existing on row';
  END IF;
END $$;
ROLLBACK;
