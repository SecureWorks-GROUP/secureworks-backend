-- MakeSafe Cancel — cancel attribution fields (M-F Wave 1, 2026-07-09)
--
-- Purpose:
--   The make-safe manager (Hugo) or an admin can CANCEL a make-safe card that a
--   builder recalled / reallocated / sent in error. One jobs.status='cancelled'
--   write drives both boards; the reason + who + when live here on
--   makesafe_job_details so the Cancelled card can show reason/who/date and the
--   story reconciler can tell a MANUAL cancel (has cancel_reason) from a legacy /
--   unexplained one. Reversible via reopen_makesafe.
--
-- Safety:
--   Additive only. All columns nullable, no defaults, no existing rows altered,
--   no data destroyed. No sends or invoice changes. jobs.cancelled_at is NOT
--   added (that column does not exist and is intentionally not written — the
--   jobs write is status='cancelled' alone). Apply via the standard
--   migration-approval gate BEFORE the ops-api deploy so cancel_makesafe never
--   runs before its columns exist.

ALTER TABLE public.makesafe_job_details
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS cancel_note  text,
  ADD COLUMN IF NOT EXISTS cancelled_by text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

COMMENT ON COLUMN public.makesafe_job_details.cancel_reason IS
  'Reason code when the make-safe was cancelled (builder_recalled, reallocated, sent_in_error, duplicate, other). NULL if never cancelled. Validated by the cancel_makesafe action, not the DB.';
COMMENT ON COLUMN public.makesafe_job_details.cancel_note IS
  'Typed note (always required) captured when the make-safe was cancelled. NULL if never cancelled.';
COMMENT ON COLUMN public.makesafe_job_details.cancelled_by IS
  'Operator email attributed to the cancel (trade JWT email or ops operator_email). NULL if never cancelled.';
COMMENT ON COLUMN public.makesafe_job_details.cancelled_at IS
  'Timestamp of the cancel action. Drives the ops board Cancelled-column window (last 90 days). NULL if never cancelled; cleared on reopen.';
