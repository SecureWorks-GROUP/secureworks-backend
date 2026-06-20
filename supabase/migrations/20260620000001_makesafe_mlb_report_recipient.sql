-- MakeSafe MLB report-recipient correction.
--
-- MLB / Major Loss Builders requires formal close-out packs to be emailed to
-- makesafes@mlbuilders.com.au. Keep this as the work-orders report recipient;
-- do not use invoice_email or a per-job fallback for client sends.

UPDATE public.makesafe_companies
  SET report_recipient = 'makesafes@mlbuilders.com.au',
      updated_at = now()
  WHERE slug = 'mlb'
    AND coalesce(nullif(btrim(report_recipient), ''), '') = '';
