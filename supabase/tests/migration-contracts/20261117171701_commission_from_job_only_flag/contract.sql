-- Re-apply the actual migration, then read the stored switch.
\ir ../../../migrations/20261117171701_commission_from_job_only_flag.sql
DO $$ BEGIN
  IF (SELECT count(*) FROM public.feature_flags WHERE flag_name = 'commission_from_job_only_v1') <> 1 THEN
    RAISE EXCEPTION 'commission switch contract: expected one row after re-apply';
  END IF;
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'commission_from_job_only_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'commission switch contract: expected off';
  END IF;
END $$;
