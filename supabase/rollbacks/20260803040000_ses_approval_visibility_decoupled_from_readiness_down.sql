-- ROLLBACK of 20260803040000_ses_approval_visibility_decoupled_from_readiness.sql
--
-- Restores `makesafe_revision_approvals_current_v2` EXACTLY as 20260728020000
-- defined it, including the `JOIN makesafe_readiness_current_v2 ... AND
-- readiness.ready = true` readiness gate on approval visibility.
--
-- READ THIS BEFORE RUNNING IT. As of the captain's ruling on 2026-08-03 that
-- gate is UNSATISFIABLE: `ready` is false on every readiness row on the board
-- and no Phase-2 producer exists to set it, and the join on
-- readiness_revision can never match the NULL readiness_revision that every
-- post-ruling approval carries. Restoring it makes the view return zero rows,
-- which re-blocks BOTH execution paths (invoice creation and SEND IT release)
-- for every approval on the board. Only run this once a Phase-2 readiness
-- producer can legitimately commit a READY readiness revision without a caller
-- asserting one.
--
-- The view definition below is byte-identical to lines 449-459 of
-- supabase/migrations/20260728020000_makesafe_ses_invoice_release_u5_u6.sql.

CREATE OR REPLACE VIEW public.makesafe_revision_approvals_current_v2
WITH (security_invoker = true)
AS
SELECT approval.*
FROM public.makesafe_revision_approvals approval
JOIN public.makesafe_readiness_current_v2 readiness
  ON readiness.job_id = approval.job_id
 AND readiness.readiness_revision = approval.readiness_revision
 AND readiness.dependency_generation = approval.dependency_generation
WHERE approval.decision = 'approved'
  AND readiness.ready = true;

REVOKE ALL ON public.makesafe_revision_approvals_current_v2
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.makesafe_revision_approvals_current_v2 TO service_role;

COMMENT ON VIEW public.makesafe_revision_approvals_current_v2 IS NULL;
