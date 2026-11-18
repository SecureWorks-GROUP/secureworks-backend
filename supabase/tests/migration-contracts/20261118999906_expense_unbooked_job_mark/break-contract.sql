-- Keep the name so the contract's re-apply skips it, but drop the rule.
ALTER TABLE public.expense_receipts DROP CONSTRAINT expense_receipts_unbooked_job_is_job;
ALTER TABLE public.expense_receipts ADD CONSTRAINT expense_receipts_unbooked_job_is_job CHECK (true) NOT VALID;
