-- Deliberately undo the resume: the contract must fail.
UPDATE public.context_cadence_settings SET live_reserve_calls_day = 1000 WHERE id;
