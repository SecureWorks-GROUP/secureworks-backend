-- Drop the named-mark check; the contract must then fail on it.
ALTER TABLE public.job_dispatch_state DROP CONSTRAINT job_dispatch_state_install_confirmed_named;
