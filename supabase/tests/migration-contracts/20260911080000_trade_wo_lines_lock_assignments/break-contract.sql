-- Deliberately undo the promised narrowing: let the $1000 commission line
-- swallow the trade's unbilled day card from weeks BEFORE the window that line
-- bills. That is the over-locking the window rule exists to prevent, and a
-- migration that omitted the window would leave exactly this state.
-- contract.sql must notice.
UPDATE public.job_assignments
SET invoiced_in = 'e4000000-0000-4000-8000-000000000005'
WHERE id = 'e5000000-0000-4000-8000-000000000012';
