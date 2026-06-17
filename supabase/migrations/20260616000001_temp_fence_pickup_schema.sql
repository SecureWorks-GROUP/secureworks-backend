-- ════════════════════════════════════════════════════════════
-- TEMP FENCE PICKUP — schema (lean v1, additive)
-- Mission: temp-fence-pickup-2026-06-16
-- ════════════════════════════════════════════════════════════
--
-- Business meaning:
--   SecureWorks hires out its OWN temp fencing on some make-safe jobs and must
--   later collect it. The hire fee AND retrieval fee are billed UPFRONT in the
--   first invoice — there is NO recurring billing and NO re-invoice on pickup.
--   This migration adds a PICKUP lifecycle to the ORIGINAL make-safe job. It is
--   strictly a tracking/lifecycle change. It touches NO invoice/billing table.
--
-- Why new columns, not the existing substatus enum:
--   makesafe_job_details.substatus (6-value CHECK) drives the REPORT/INVOICE
--   lifecycle and the derived board stage, referenced by 5+ skills. The hire/
--   pickup lifecycle happens MONTHS later, after the job is normally complete.
--   Conflating the two would corrupt board derivation and break the substatus
--   contract. So pickup gets its OWN columns on the same overlay table.
--
-- Lifecycle: fence_hire_status  out -> needs_pickup -> picked_up
--   - NULL          => this make-safe never hired out our fencing (the majority).
--   - 'out'         => our fencing is on site; hire_end_date set (default +3mo).
--   - 'needs_pickup'=> collectable now (timer reached, builder told us, or manual).
--   - 'picked_up'   => collected; done. NO invoice action.
--
-- Safety:
--   PR-review first. Do NOT apply to production without the standard SecureWorks
--   deploy/migration approval gate. Fully additive + idempotent.

ALTER TABLE public.makesafe_job_details
  ADD COLUMN IF NOT EXISTS fence_hire_status text
    CHECK (fence_hire_status IS NULL OR fence_hire_status IN ('out', 'needs_pickup', 'picked_up')),
  ADD COLUMN IF NOT EXISTS hire_end_date date,
  ADD COLUMN IF NOT EXISTS fence_out_at timestamptz,
  ADD COLUMN IF NOT EXISTS pickup_due_logged_at timestamptz,
  ADD COLUMN IF NOT EXISTS picked_up_at timestamptz;

-- Partial index: only the small set of jobs that actually hired out fencing.
-- Drives the "needs pickup" surfacing read + the (gated) cron promotion query.
CREATE INDEX IF NOT EXISTS idx_makesafe_job_details_fence_hire
  ON public.makesafe_job_details (fence_hire_status, hire_end_date)
  WHERE fence_hire_status IS NOT NULL;

COMMENT ON COLUMN public.makesafe_job_details.fence_hire_status IS
  'Temp-fence pickup lifecycle (separate from substatus): out -> needs_pickup -> picked_up. NULL = no SecureWorks fencing hired out on this job. No billing implication: hire + retrieval are billed upfront.';
COMMENT ON COLUMN public.makesafe_job_details.hire_end_date IS
  'Date the temp-fence hire ends; default = fence_out date + 3 months (editable). On/after this date the job derives to needs_pickup.';
