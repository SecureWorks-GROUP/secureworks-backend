-- Break: drop the append-only trigger; the contract must then fail on the update.
DROP TRIGGER trg_job_client_signoffs_append_only ON public.job_client_signoffs;
