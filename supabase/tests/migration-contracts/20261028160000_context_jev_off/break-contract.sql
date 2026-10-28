-- Deliberately undo the switch-off: the contract must fail.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'context_jev_shadow_v1';
