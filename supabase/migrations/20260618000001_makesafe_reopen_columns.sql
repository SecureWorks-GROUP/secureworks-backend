-- Stage 4 Phase A — make-safe re-open data-model additions
--
-- Business meaning:
--   A completed/archived make-safe job can be re-opened for a second (or
--   later) pipeline cycle when the builder requests a reattendance, flags a
--   rectification, or needs the temp-fence collected.  These columns on
--   makesafe_job_details carry the re-open state for the CURRENT cycle.
--
--   reopen_reason       -- NULL on first cycle; thereafter one of:
--                            reattendance  (a new visit to the same site; CHARGE)
--                            rectification (our fault; re-run, NO charge)
--                            pickup        (collect temp fencing; NO charge)
--   no_charge           -- true iff the current cycle is cost-free to the builder
--                          (rectification + pickup = true; reattendance = false)
--   cycle_number        -- starts at 1; incremented by re_open_makesafe each time
--                          the job is re-opened.  The board uses this to surface
--                          "cycle N" labelling and to scope invoice/gate reads.
--
-- Safety:
--   Additive only.  NULL reopen_reason + no_charge=false + cycle_number=1 is the
--   correct default for every existing job — no backfill required.  This migration
--   does NOT apply any row updates, does NOT void invoices, and does NOT change any
--   job status.

ALTER TABLE public.makesafe_job_details
  ADD COLUMN IF NOT EXISTS reopen_reason TEXT
    CHECK (reopen_reason IS NULL OR reopen_reason IN ('reattendance', 'rectification', 'pickup')),
  ADD COLUMN IF NOT EXISTS no_charge BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cycle_number INTEGER NOT NULL DEFAULT 1;

-- Index for quick lookup of open/re-opened cycles (the routine scans by cycle).
CREATE INDEX IF NOT EXISTS idx_makesafe_job_details_cycle
  ON public.makesafe_job_details (cycle_number)
  WHERE cycle_number > 1;

COMMENT ON COLUMN public.makesafe_job_details.reopen_reason IS
  'NULL on the first cycle.  Reason the job was re-opened: reattendance (charge), rectification (no charge), pickup (no charge).';
COMMENT ON COLUMN public.makesafe_job_details.no_charge IS
  'true when the current cycle is cost-free to the builder (rectification or pickup).  Set by re_open_makesafe; honoured by createMakesafeDraftInvoice (skip) + makesafeSendPack (report-only).';
COMMENT ON COLUMN public.makesafe_job_details.cycle_number IS
  'Pipeline cycle counter.  Starts at 1; incremented each time re_open_makesafe is called.';
