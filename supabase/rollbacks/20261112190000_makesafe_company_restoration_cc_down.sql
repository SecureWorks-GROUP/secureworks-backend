-- Rollback of 20261112190000_makesafe_company_restoration_cc.
-- Drops the restoration CC list. Roll back the matching ops-api first: both
-- restoration send routes select this column.
ALTER TABLE public.makesafe_companies
  DROP COLUMN IF EXISTS restoration_cc;
