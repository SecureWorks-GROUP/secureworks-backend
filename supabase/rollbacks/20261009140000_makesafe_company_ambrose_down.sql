-- Rollback of 20261009140000_makesafe_company_ambrose: deactivate the Ambrose
-- Construct Group intake company. The row is kept, not deleted, because cards
-- minted while it was active point at it through
-- makesafe_job_details.requesting_company_id; an inactive company is no longer
-- resolved by intake, so new Ambrose mail falls back to unknown_builder.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

UPDATE public.makesafe_companies
SET active = false,
    updated_at = now()
WHERE slug = 'acg';
