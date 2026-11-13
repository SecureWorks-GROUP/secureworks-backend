-- Rollback of 20261113090000_trade_open_access_flags.
--
-- Switches the three flags OFF and keeps the rows. Off is what a missing row
-- reads as, so ops-api behaves as it did before the migration, and the rows
-- stay as a record of what was seeded. To remove them by hand:
--   DELETE FROM public.feature_flags
--    WHERE flag_name IN ('trade_company_job_view_v1', 'trade_self_booking_v1', 'trade_rate_editable_v1');
UPDATE public.feature_flags
   SET enabled = false
 WHERE flag_name IN ('trade_company_job_view_v1', 'trade_self_booking_v1', 'trade_rate_editable_v1')
   AND enabled IS DISTINCT FROM false;
