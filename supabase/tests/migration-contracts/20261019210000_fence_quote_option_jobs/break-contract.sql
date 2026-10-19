-- Drop the supersede trigger: the contract must then fail when accepting B supersedes nothing.
DROP TRIGGER trg_jobs_quote_option_supersede ON public.jobs;
