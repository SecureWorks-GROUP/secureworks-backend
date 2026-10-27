-- Deliberately drop the flag check: the contract must fail.
ALTER TABLE public.job_deposit_advance_state DROP CONSTRAINT job_deposit_advance_state_flag_check;
