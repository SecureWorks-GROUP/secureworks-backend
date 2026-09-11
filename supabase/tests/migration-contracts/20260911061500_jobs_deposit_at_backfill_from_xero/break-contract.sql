-- Deliberately undo the promised behaviour: clear the stamp the backfill wrote.
-- contract.sql must notice.
UPDATE public.jobs SET deposit_at = NULL WHERE job_number = 'SWF-CONTRACT-PAID';
