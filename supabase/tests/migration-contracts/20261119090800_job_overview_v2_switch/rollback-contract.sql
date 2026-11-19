DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_overview_v2') THEN
    RAISE EXCEPTION 'job overview v2 switch rollback: off row remains';
  END IF;
END $$;
BEGIN;
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('job_overview_v2', true, 'ZZTEST existing switch');
\ir ../../../rollbacks/20261119090800_job_overview_v2_switch_down.sql
DO $$ BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'job_overview_v2') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'job overview v2 switch rollback: existing on row changed';
  END IF;
END $$;
ROLLBACK;
