-- U2-S1: immutable attendance_cycle_id + safe cycle attribution for make-safe
-- evidence. Additive only. Does not rewrite jobs/substatus, send packs, or
-- invent evidence attribution onto the current cycle.
--
-- Apply before deploying the matching ops-api. Rollback leaves additive columns
-- in place (harmless); code rollback is the previous edge version.

-- 1) Immutable attendance cycles (UUID identity + display cycle_number)
CREATE TABLE IF NOT EXISTS public.makesafe_attendance_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  cycle_number integer NOT NULL CHECK (cycle_number >= 1),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  open_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT makesafe_attendance_cycles_job_cycle_unique UNIQUE (job_id, cycle_number),
  CONSTRAINT makesafe_attendance_cycles_closed_after_open CHECK (
    closed_at IS NULL OR closed_at >= opened_at
  )
);

CREATE INDEX IF NOT EXISTS idx_makesafe_attendance_cycles_job
  ON public.makesafe_attendance_cycles (job_id, cycle_number DESC);

COMMENT ON TABLE public.makesafe_attendance_cycles IS
  'U2-S1 immutable attendance identity. cycle_number is the human display counter; id is the correlation-spine attendance_cycle_id. One row per (job, cycle_number).';
COMMENT ON COLUMN public.makesafe_attendance_cycles.id IS
  'Immutable attendance_cycle_id for the correlation spine.';
COMMENT ON COLUMN public.makesafe_attendance_cycles.cycle_number IS
  'Display cycle number matching makesafe_job_details.cycle_number at open time.';

ALTER TABLE public.makesafe_attendance_cycles ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.makesafe_attendance_cycles TO service_role;
DROP POLICY IF EXISTS service_role_all_makesafe_attendance_cycles
  ON public.makesafe_attendance_cycles;
CREATE POLICY service_role_all_makesafe_attendance_cycles
  ON public.makesafe_attendance_cycles FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Deterministic backfill: for each make-safe detail row, ensure cycles 1..N exist.
-- Does not invent evidence; only materialises identity rows from the counter.
INSERT INTO public.makesafe_attendance_cycles (job_id, cycle_number, opened_at, open_reason)
SELECT d.job_id, gs.cycle_number, COALESCE(d.created_at, now()),
  CASE WHEN gs.cycle_number = 1 THEN 'backfill_first_attendance' ELSE 'backfill_cycle_counter' END
FROM public.makesafe_job_details d
JOIN public.jobs j ON j.id = d.job_id AND j.type = 'makesafe'
CROSS JOIN LATERAL generate_series(1, GREATEST(COALESCE(d.cycle_number, 1), 1)) AS gs(cycle_number)
ON CONFLICT (job_id, cycle_number) DO NOTHING;

-- 2) Nullable cycle identity + attribution on service reports, holds, assignments
-- attribution: bound | backfill_cycle_scope | legacy_unscoped
ALTER TABLE public.job_service_reports
  ADD COLUMN IF NOT EXISTS attendance_cycle_id uuid
    REFERENCES public.makesafe_attendance_cycles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cycle_attribution text
    CHECK (cycle_attribution IS NULL OR cycle_attribution IN (
      'bound', 'backfill_cycle_scope', 'legacy_unscoped'
    ));

ALTER TABLE public.makesafe_status_holds
  ADD COLUMN IF NOT EXISTS attendance_cycle_id uuid
    REFERENCES public.makesafe_attendance_cycles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cycle_attribution text
    CHECK (cycle_attribution IS NULL OR cycle_attribution IN (
      'bound', 'backfill_cycle_scope', 'legacy_unscoped'
    ));

ALTER TABLE public.job_assignments
  ADD COLUMN IF NOT EXISTS attendance_cycle_id uuid
    REFERENCES public.makesafe_attendance_cycles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cycle_attribution text
    CHECK (cycle_attribution IS NULL OR cycle_attribution IN (
      'bound', 'backfill_cycle_scope', 'legacy_unscoped'
    ));

CREATE INDEX IF NOT EXISTS idx_job_service_reports_attendance_cycle
  ON public.job_service_reports (attendance_cycle_id)
  WHERE attendance_cycle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_assignments_attendance_cycle
  ON public.job_assignments (attendance_cycle_id)
  WHERE attendance_cycle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_makesafe_status_holds_attendance_cycle
  ON public.makesafe_status_holds (attendance_cycle_id)
  WHERE attendance_cycle_id IS NOT NULL;

-- Bind reports when (job_id, cycle_number) matches exactly one attendance cycle.
UPDATE public.job_service_reports r
SET attendance_cycle_id = c.id,
    cycle_attribution = 'bound'
FROM public.makesafe_attendance_cycles c
WHERE r.attendance_cycle_id IS NULL
  AND c.job_id = r.job_id
  AND c.cycle_number = COALESCE(r.cycle_number, 1);

-- Holds: bind by matching cycle_number.
UPDATE public.makesafe_status_holds h
SET attendance_cycle_id = c.id,
    cycle_attribution = 'bound'
FROM public.makesafe_attendance_cycles c
WHERE h.attendance_cycle_id IS NULL
  AND c.job_id = h.job_id
  AND c.cycle_number = COALESCE(h.cycle_number, 1);

-- Assignments: only bind when the job has exactly one attendance cycle (first
-- attendance only). Multi-cycle jobs leave assignments unbound so runtime fails
-- closed as backfill_cycle_scope rather than guessing the current cycle.
UPDATE public.job_assignments a
SET attendance_cycle_id = c.id,
    cycle_attribution = 'bound'
FROM public.makesafe_attendance_cycles c
JOIN public.makesafe_job_details d ON d.job_id = c.job_id
WHERE a.attendance_cycle_id IS NULL
  AND a.job_id = c.job_id
  AND c.cycle_number = 1
  AND COALESCE(d.cycle_number, 1) = 1
  AND COALESCE(d.reattend_count, 0) = 0;

UPDATE public.job_assignments a
SET cycle_attribution = 'backfill_cycle_scope'
FROM public.makesafe_job_details d
WHERE a.job_id = d.job_id
  AND a.attendance_cycle_id IS NULL
  AND (COALESCE(d.cycle_number, 1) > 1 OR COALESCE(d.reattend_count, 0) > 0)
  AND (a.cycle_attribution IS NULL OR a.cycle_attribution = 'legacy_unscoped');

-- Mark remaining unbound reports/holds/assignments on multi-cycle jobs as
-- fail-closed backfill (never treat as current-cycle readiness).
UPDATE public.job_service_reports r
SET cycle_attribution = 'backfill_cycle_scope'
FROM public.makesafe_job_details d
WHERE r.job_id = d.job_id
  AND r.attendance_cycle_id IS NULL
  AND (COALESCE(d.reattend_count, 0) > 0 OR COALESCE(d.cycle_number, 1) > 1)
  AND r.cycle_attribution IS NULL;

UPDATE public.makesafe_status_holds h
SET cycle_attribution = 'backfill_cycle_scope'
FROM public.makesafe_job_details d
WHERE h.job_id = d.job_id
  AND h.attendance_cycle_id IS NULL
  AND (COALESCE(d.reattend_count, 0) > 0 OR COALESCE(d.cycle_number, 1) > 1)
  AND h.cycle_attribution IS NULL;

-- First-attendance leftovers stay legacy_unscoped (byte-compatible any-cycle path).
UPDATE public.job_service_reports r
SET cycle_attribution = 'legacy_unscoped'
WHERE r.attendance_cycle_id IS NULL AND r.cycle_attribution IS NULL;

UPDATE public.job_assignments a
SET cycle_attribution = 'legacy_unscoped'
WHERE a.attendance_cycle_id IS NULL AND a.cycle_attribution IS NULL;

UPDATE public.makesafe_status_holds h
SET cycle_attribution = 'legacy_unscoped'
WHERE h.attendance_cycle_id IS NULL AND h.cycle_attribution IS NULL;

-- 3) Pack cycle junction — preserve UNIQUE (job_id, pack_kind) send lock
CREATE TABLE IF NOT EXISTS public.makesafe_report_pack_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid NOT NULL REFERENCES public.makesafe_report_packs(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  attendance_cycle_id uuid NOT NULL
    REFERENCES public.makesafe_attendance_cycles(id) ON DELETE CASCADE,
  cycle_attribution text NOT NULL DEFAULT 'bound'
    CHECK (cycle_attribution IN ('bound', 'backfill_cycle_scope', 'legacy_unscoped')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT makesafe_report_pack_cycles_pack_cycle_unique
    UNIQUE (pack_id, attendance_cycle_id)
);

CREATE INDEX IF NOT EXISTS idx_makesafe_report_pack_cycles_job
  ON public.makesafe_report_pack_cycles (job_id, attendance_cycle_id);

ALTER TABLE public.makesafe_report_pack_cycles ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.makesafe_report_pack_cycles TO service_role;
DROP POLICY IF EXISTS service_role_all_makesafe_report_pack_cycles
  ON public.makesafe_report_pack_cycles;
CREATE POLICY service_role_all_makesafe_report_pack_cycles
  ON public.makesafe_report_pack_cycles FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.makesafe_report_pack_cycles IS
  'U2-S1 cycle binding for report packs. Send lock remains on makesafe_report_packs (job_id, pack_kind); this junction scopes readiness to an attendance_cycle_id without breaking that uniqueness.';

-- Bind packs only for first-attendance (cycle 1, reattend_count 0). Multi-cycle
-- packs stay unbound so runtime never treats a prior-cycle send as current.
INSERT INTO public.makesafe_report_pack_cycles (pack_id, job_id, attendance_cycle_id, cycle_attribution)
SELECT p.id, p.job_id, c.id, 'bound'
FROM public.makesafe_report_packs p
JOIN public.makesafe_job_details d ON d.job_id = p.job_id
JOIN public.makesafe_attendance_cycles c
  ON c.job_id = p.job_id AND c.cycle_number = 1
WHERE COALESCE(d.cycle_number, 1) = 1
  AND COALESCE(d.reattend_count, 0) = 0
ON CONFLICT (pack_id, attendance_cycle_id) DO NOTHING;

-- 4) Pack schema parity (runtime already selects these; migrations lacked them).
-- Live information_schema was not probed in this task; ADD COLUMN IF NOT EXISTS
-- and a recreatable CHECK are safe on both migration-only and already-live DBs.
ALTER TABLE public.makesafe_report_packs
  ADD COLUMN IF NOT EXISTS review_state text,
  ADD COLUMN IF NOT EXISTS needs_money_review boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.makesafe_report_packs.review_state IS
  'Optional pack review/readiness label (e.g. READY, READY_TO_BUILD). Nullable; Docs Ready may also derive from artifacts.';
COMMENT ON COLUMN public.makesafe_report_packs.needs_money_review IS
  'When true, send_pack blocks unless money_review_confirmed=true. Default false (Wave 0).';

-- Expand status CHECK to include portal_ready (runtime write path for portal-only builders).
ALTER TABLE public.makesafe_report_packs
  DROP CONSTRAINT IF EXISTS makesafe_report_packs_status_check;
ALTER TABLE public.makesafe_report_packs
  ADD CONSTRAINT makesafe_report_packs_status_check
  CHECK (status IN (
    'drafted', 'admin_to_send_report', 'sending',
    'authorised_not_sent', 'sent_marker_failed', 'sent_not_closed',
    'sent', 'close_failed', 'failed',
    'portal_ready'
  ));

COMMENT ON COLUMN public.makesafe_report_packs.status IS
  'SEND lifecycle including portal_ready for portal-only builders (no email send).';
