-- Remove the known later V8 view first (20261103100000): v_group_coverage
-- reads the office-fee helper this rollback drops, so roll back in reverse
-- order, as the down files would be run.
SELECT to_regclass('public.v_group_coverage') IS NOT NULL AS break_has_group_coverage \gset
\if :break_has_group_coverage
\ir ../../../rollbacks/20261103100000_fence_auto_group_off_down.sql
\endif
-- Put the fence back as it was: a council fee must block the group again,
-- and the contract must catch it.
\ir ../../../rollbacks/20261102120000_patio_auto_group_down.sql
