-- Maybe-box reason code for the deterministic make-safe intake.
--
-- The maybe-box change (feat/intake-maybe-box) teaches the deterministic
-- planner to park "WO ref present, but no work order PDF" emails under
-- 'wo_ref_without_pdf_pending_review' instead of 'below_identity_floor'.
-- This constraint update must apply BEFORE the matching ops-api deploy,
-- otherwise the first case write carrying the new reason code is rejected
-- with a check violation. Writes no operational rows.
--
-- The value list mirrors the live constraint (16 values, including
-- 'synthetic_livefire_cleanup' from 20260727080821) plus the new code.

ALTER TABLE public.makesafe_intake_cases
  DROP CONSTRAINT IF EXISTS makesafe_intake_cases_reason_code_check;
ALTER TABLE public.makesafe_intake_cases
  ADD CONSTRAINT makesafe_intake_cases_reason_code_check CHECK (reason_code IN (
    'cancellation',
    'cancellation_target_not_found',
    'cancellation_target_ambiguous',
    'cancellation_live_invoice_review',
    'cancellation_target_terminal_conflict',
    'cancellation_apply_failed',
    'duplicate',
    'revision',
    'unknown_builder',
    'non_makesafe',
    'ambiguous_scope',
    'below_identity_floor',
    'adapter_parse_failure',
    'conflicting_fields',
    'awaiting_job_creation',
    'synthetic_livefire_cleanup',
    'wo_ref_without_pdf_pending_review'
  ));
