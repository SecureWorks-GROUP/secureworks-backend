DO $$ BEGIN
  IF to_regclass('public.xero_bill_attachment_reads') IS NOT NULL THEN
    RAISE EXCEPTION 'xero bill attachment reads rollback: table remains';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.feature_flags WHERE flag_name = 'xero_bill_attachment_read_v1'
  ) THEN
    RAISE EXCEPTION 'xero bill attachment reads rollback: off switch remains';
  END IF;
END $$;

BEGIN;
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('xero_bill_attachment_read_v1', true, 'ZZTEST existing switch');
\ir ../../../rollbacks/20261119091400_xero_bill_attachment_reads_down.sql
DO $$ BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'xero_bill_attachment_read_v1') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'xero bill attachment reads rollback: existing on switch changed';
  END IF;
END $$;
ROLLBACK;
