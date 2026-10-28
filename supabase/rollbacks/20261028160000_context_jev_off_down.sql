-- Rollback of 20261028160000_context_jev_off: Jev back in shadow and tier 1 back on, as they stood
-- before (both on since 7 Oct and 28 Oct 2026). The five watch points stay off: each needs its own word.
UPDATE public.feature_flags SET enabled = true, updated_at = now()
WHERE flag_name IN ('context_jev_shadow_v1', 'context_jev_gate_decides_v1');
