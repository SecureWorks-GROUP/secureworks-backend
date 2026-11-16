-- Rollback of 20261112140000_makesafe_company_restoration_recipients.
-- Drops the outbound restoration recipient list. Roll back the matching
-- ops-api first: it selects this column on every mailer ops send.
ALTER TABLE public.makesafe_companies
  DROP COLUMN IF EXISTS restoration_recipients;
