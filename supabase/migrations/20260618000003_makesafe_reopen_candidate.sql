-- MakeSafe Reopen Candidate — simple re-open wiring (Stage 4, 2026-06-18)
--
-- Purpose:
--   When an intake email arrives whose external_ref matches an EXISTING live job,
--   surface it as a reopen_candidate draft rather than silently dropping it.
--   The human sees "matches job X — reopen it?" and clicks a single Reopen button.
--   Charge vs no-charge stays the human's call via the normal invoice flow.
--
-- Safety:
--   Additive only. No existing rows altered. No data destroyed. No sends or
--   invoice changes. Apply via the standard migration-approval gate before prod.

-- 1) Add reopen_candidate to the status CHECK on makesafe_intake_drafts.
--    (Preserves the existing allowed values — only appends one new value.)
ALTER TABLE public.makesafe_intake_drafts
  DROP CONSTRAINT IF EXISTS makesafe_intake_drafts_status_check;

ALTER TABLE public.makesafe_intake_drafts
  ADD CONSTRAINT makesafe_intake_drafts_status_check
  CHECK (status IN (
    'draft',
    'needs_review',
    'approved',
    'rejected',
    'superseded',
    'reopen_candidate'
  ));

-- 2) Add reopen_job_id to makesafe_intake_drafts.
--    Points to the existing job this email is a reopen signal for.
ALTER TABLE public.makesafe_intake_drafts
  ADD COLUMN IF NOT EXISTS reopen_job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_makesafe_intake_drafts_reopen_job
  ON public.makesafe_intake_drafts (reopen_job_id)
  WHERE reopen_job_id IS NOT NULL;

-- 3) Add reopen_reason + cycle_number to makesafe_job_details.
--    reopen_reason is a short free-text label (e.g. "reattendance", "rectification",
--    or any human-provided value — NOT validated by DB, validated by the action handler).
--    cycle_number starts at 1 (first activation) and increments on each reopen.
ALTER TABLE public.makesafe_job_details
  ADD COLUMN IF NOT EXISTS reopen_reason text,
  ADD COLUMN IF NOT EXISTS cycle_number integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.makesafe_intake_drafts.reopen_job_id IS
  'For reopen_candidate drafts: the existing make-safe job this email matches. NULL for normal new-WO drafts.';

COMMENT ON COLUMN public.makesafe_job_details.reopen_reason IS
  'Reason provided when the job was last reopened (e.g. reattendance, rectification, pickup). NULL on first activation.';

COMMENT ON COLUMN public.makesafe_job_details.cycle_number IS
  'Monotonically incrementing activation counter. Starts at 1. Incremented by the reopen_makesafe action.';
