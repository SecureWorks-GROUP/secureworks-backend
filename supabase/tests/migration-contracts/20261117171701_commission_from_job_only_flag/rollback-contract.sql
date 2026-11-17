DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'commission_from_job_only_v1') THEN
    RAISE EXCEPTION 'commission switch rollback: off row remains';
  END IF;
END $$;
BEGIN;
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('commission_from_job_only_v1', true, 'ZZTEST existing switch');
\ir ../../../rollbacks/20261117171701_commission_from_job_only_flag_down.sql
DO $$ BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'commission_from_job_only_v1') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'commission switch rollback: existing on row changed';
  END IF;
END $$;
ROLLBACK;
