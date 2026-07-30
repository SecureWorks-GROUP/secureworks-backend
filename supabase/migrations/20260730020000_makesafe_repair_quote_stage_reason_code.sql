-- Track A D4 (TRACK-A-INTAKE-DIFF-2026-07-30, Ruling 1): quote-stage repair
-- lane reason code for the deterministic make-safe intake.
--
-- A builder "please price this" request with no work order PDF and no PO is a
-- sealed pre-deliverable exception to the WO+PO unit: it files as a
-- repair-family case under 'repair_quote_stage' (mirroring the maybe-box
-- 'wo_ref_without_pdf_pending_review' review lane) so the repair job manager
-- sees and dispositions it. When the real WO+PO arrives, the deliverable case
-- forms normally and takes the WO PDF's declared family.
--
-- This constraint update must apply BEFORE the matching ops-api deploy,
-- otherwise the first case write carrying the new reason code is rejected
-- with a check violation. Writes no operational rows.
--
-- The value list mirrors the constraint as of 20260730010000 (18 values)
-- plus the new code.

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
    'reattendance_target_not_found',
    'repair_quote_stage'
  ));
