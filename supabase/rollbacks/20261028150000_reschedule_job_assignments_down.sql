-- Rollback for 20261028150000_reschedule_job_assignments.sql.
--
-- Roll the matching ops-api back first: reschedule_job_bookings calls this
-- function. The function writes no table of its own, so nothing else is
-- undone; bookings it moved stay where they were moved. Re-running it is a
-- no-op.
DROP FUNCTION IF EXISTS public.reschedule_job_assignments_v1(uuid, jsonb, jsonb, jsonb, uuid[], text[], text);
DROP FUNCTION IF EXISTS public.reschedule_job_assignments_refuse(text, text, jsonb);
