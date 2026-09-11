-- Deliberately undo the promised behaviour: release the Alyx card the backfill
-- locked. contract.sql must notice.
UPDATE public.job_assignments SET invoiced_in = NULL
WHERE id = 'a4019f76-8b8c-4c7e-86bd-8ae0758e8635';
