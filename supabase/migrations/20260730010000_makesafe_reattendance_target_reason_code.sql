-- Track A D3 (TRACK-A-INTAKE-DIFF-2026-07-30, Ruling 12): lifecycle reopen
-- park reason code for the deterministic make-safe intake.
--
-- Collection / rectification / "-R" reattendance mail is a cycle on the
-- ORIGINAL obligation, never a fresh mint. When neither the exact obligation
-- match nor the persisted lineage parent yields the original job, the runtime
-- now parks the case as 'reattendance_target_not_found' (the reattendance
-- analogue of 'cancellation_target_not_found') for human binding in the
-- review lane instead of minting a duplicate job.
--
-- This constraint update must apply BEFORE the matching ops-api deploy,
-- otherwise the first case write carrying the new reason code is rejected
-- with a check violation. Writes no operational rows.
--
-- The value list mirrors the live constraint (17 values, including
-- 'wo_ref_without_pdf_pending_review' from 20260729040000) plus the new code.

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
    'wo_ref_without_pdf_pending_review',
    'reattendance_target_not_found'
  ));
