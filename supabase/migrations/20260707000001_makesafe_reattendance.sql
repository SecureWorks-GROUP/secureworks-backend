-- MakeSafe Re-attendance — second report on the SAME work order (M-C, 2026-07-07)
--
-- Purpose:
--   A builder asks a crew to re-attend the SAME make-safe (e.g. temp fencing blows
--   down again) with no new work order. A manager puts the already-reported card
--   back to allocated as a re-attend visit, the crew submits ANOTHER report, and
--   BOTH reports are retained. This migration adds the columns that let the second
--   report be stored additively (never overwriting report #1) and give the board /
--   reporting skill a visible re-attend marker (visit count).
--
-- Safety:
--   Additive only. No existing rows altered, no data destroyed, no sends or invoice
--   changes. Apply via the standard migration-approval gate before prod.

-- 1) Tag each service report with the work cycle it belongs to.
--    cycle_number mirrors makesafe_job_details.cycle_number at submit time. Existing
--    rows default to 1 (first attendance), so single-report jobs are unchanged and
--    the board's cycle-scoped read keeps behaving exactly as before.
ALTER TABLE public.job_service_reports
  ADD COLUMN IF NOT EXISTS cycle_number integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_service_reports_job_cycle
  ON public.job_service_reports (job_id, cycle_number);

COMMENT ON COLUMN public.job_service_reports.cycle_number IS
  'Work cycle this report belongs to (mirrors makesafe_job_details.cycle_number at submit time). First attendance = 1; a re-attend increments the cycle so the new report is stored additively without overwriting the prior visit''s report.';

-- 2) Re-attend marker on the make-safe detail row.
--    reattend_count is the human-visible visit marker: 0 = first attendance only,
--    N = N re-attend visits. Distinct from cycle_number (which also advances on a
--    reopen) so the board / reporting skill can tell a re-attend from a first visit.
ALTER TABLE public.makesafe_job_details
  ADD COLUMN IF NOT EXISTS reattend_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reattend_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_reattend_reason text;

COMMENT ON COLUMN public.makesafe_job_details.reattend_count IS
  'Number of re-attend visits sent back to the trade on the SAME work order (0 = first attendance only). Incremented by the reattend_makesafe action; drives the board / reporting-skill re-attend marker.';
COMMENT ON COLUMN public.makesafe_job_details.last_reattend_at IS
  'Timestamp of the most recent re-attend (reattend_makesafe). NULL if never re-attended.';
COMMENT ON COLUMN public.makesafe_job_details.last_reattend_reason IS
  'Short free-text reason for the most recent re-attend (e.g. "temp fence blew down again"). Not DB-validated; the action handler validates non-empty.';
