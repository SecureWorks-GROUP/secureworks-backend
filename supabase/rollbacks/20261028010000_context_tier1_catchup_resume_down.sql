-- Rollback of 20261028010000_context_tier1_catchup_resume: Jev decides nothing again, and catch-up
-- reads are paused again (the whole day's cap and the whole morning cap kept for live reads, the
-- pause as it stood before). The flag row stays, off, so a later switch-on is one update.
UPDATE public.feature_flags SET enabled = false, updated_at = now() WHERE flag_name = 'context_jev_gate_decides_v1';
UPDATE public.context_cadence_settings
SET live_reserve_calls_day = 1000, live_reserve_calls_morning = 750, updated_at = now(),
    note = 'Catch-up paused again: rollback of 20261028010000.'
WHERE id;
