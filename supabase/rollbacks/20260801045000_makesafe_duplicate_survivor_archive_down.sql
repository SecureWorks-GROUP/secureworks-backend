-- Captain-gated rollback for 20260801045000_makesafe_duplicate_survivor_archive.sql.
--
-- Removes only the duplicate-survivor pointer surface. It deliberately does NOT
-- drop makesafe_board_status_applications: that ledger predates this migration
-- and carries the earlier cutover audit.
--
-- Dropping the pointer columns discards any duplicate archive rows' pointers,
-- so the archived cards revert to displaying their declared stage. Operational
-- job state was never changed by the migration or RPC, so nothing else moves.

DROP FUNCTION IF EXISTS public.apply_makesafe_duplicate_survivor_archive(text, text, text, jsonb);

DROP VIEW IF EXISTS public.makesafe_board_status_current;
CREATE VIEW public.makesafe_board_status_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (job_id)
  id,
  run_key,
  job_id,
  job_number,
  source_status,
  before_status,
  after_status,
  computed_at,
  computed_reasons,
  computed_missing,
  evidence_ref,
  applied_by,
  applied_at
FROM public.makesafe_board_status_applications
ORDER BY job_id, applied_at DESC, id DESC;

REVOKE ALL ON public.makesafe_board_status_current FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.makesafe_board_status_current TO service_role;

ALTER TABLE public.makesafe_board_status_applications
  DROP CONSTRAINT IF EXISTS makesafe_board_status_applications_duplicate_pointer_check;
DROP INDEX IF EXISTS public.idx_makesafe_board_status_applications_duplicate_of;
ALTER TABLE public.makesafe_board_status_applications
  DROP COLUMN IF EXISTS duplicate_of_job_id,
  DROP COLUMN IF EXISTS duplicate_of_job_number,
  DROP COLUMN IF EXISTS duplicate_rule,
  DROP COLUMN IF EXISTS duplicate_evidence;
