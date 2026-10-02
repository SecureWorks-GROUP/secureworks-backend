-- Down migration for 20261002170100_context_payload_job_repair.
--
-- Drops the repair function and its read-only classifier. Rows a real run already moved keep their new
-- placement and their metadata.placement_repaired record (from job, status,
-- step, confidence, placed time), which is what a hand reversal reads; this
-- rollback writes no row.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DROP FUNCTION IF EXISTS public.context_payload_job_repair(boolean,integer);
DROP FUNCTION IF EXISTS public.context_payload_job_mismatch_rows();
