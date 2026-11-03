-- Undo 20261103100000_fence_auto_group_off: the combined coverage view, the
-- labour-outside-pool helper and the fence flag go. The patio auto-group
-- (20261102120000) is untouched.
DROP VIEW IF EXISTS public.v_group_coverage;
DROP FUNCTION IF EXISTS public.group_work_order_labour_outside_pool(jsonb);
DELETE FROM public.feature_flags WHERE flag_name = 'group_work_order_auto_fence_v1';
