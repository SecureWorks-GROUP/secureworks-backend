-- Rollback of 20261117163100 (P3-01.1): drop the stored division options and the account rules,
-- and delete the xero_draft_standard_v1 switch row. Nothing reads either table until the draft
-- writers move onto them (P3-01.6 to .8), so roll those back first.
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS public.xero_account_rules;
DROP TABLE IF EXISTS public.xero_tracking_options;

DELETE FROM public.feature_flags WHERE flag_name = 'xero_draft_standard_v1';
