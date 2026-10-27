-- Drop the one-group-per-job-and-work-order rule. The contract must then
-- fail closed on that absence.
ALTER TABLE public.group_work_orders
  DROP CONSTRAINT uq_group_work_orders_job_work_order;
