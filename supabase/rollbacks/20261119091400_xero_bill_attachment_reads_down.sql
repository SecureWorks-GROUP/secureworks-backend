-- Down for 20261119091400_xero_bill_attachment_reads.sql.
-- A switch someone turned on is left, and its findings stay.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag_name = 'xero_bill_attachment_read_v1' AND enabled
  ) THEN
    RETURN;
  END IF;
  DROP TABLE IF EXISTS public.xero_bill_attachment_reads;
  DELETE FROM public.feature_flags
  WHERE flag_name = 'xero_bill_attachment_read_v1' AND enabled = false;
END $$;
