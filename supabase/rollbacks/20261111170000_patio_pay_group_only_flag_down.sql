-- Rollback of 20261111170000_patio_pay_group_only_flag: deliberately a no-op.
--
-- The migration only inserts patio_pay_group_only_v1 when the row is missing
-- (ON CONFLICT DO NOTHING), and production's row predates it (written by hand,
-- enabled). This rollback cannot tell a row the migration inserted from one
-- that was already there, so it deletes nothing: deleting production's row
-- would switch the patio pay rule off (a missing row reads as off). To remove
-- the row on a database built from migrations, delete it by hand:
--   DELETE FROM public.feature_flags WHERE flag_name = 'patio_pay_group_only_v1';
SELECT 1;
