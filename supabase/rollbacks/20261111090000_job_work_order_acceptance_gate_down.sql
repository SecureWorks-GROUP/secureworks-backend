-- Undo 20261111090000: a job work order can again be issued, and a crew
-- group opened, on a fencing or patio job that is not accepted yet. Writes no
-- row.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP TRIGGER IF EXISTS trg_group_work_orders_open_needs_acceptance ON public.group_work_orders;
DROP TRIGGER IF EXISTS trg_work_orders_issue_needs_acceptance ON public.work_orders;
DROP FUNCTION IF EXISTS public.group_work_orders_open_needs_acceptance();
DROP FUNCTION IF EXISTS public.work_orders_issue_needs_acceptance();
DROP FUNCTION IF EXISTS public.job_not_yet_accepted(text, text);
