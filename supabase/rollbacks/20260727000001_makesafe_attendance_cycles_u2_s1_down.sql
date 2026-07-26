-- Rollback for U2-S1 attendance cycles. Additive schema is left in place by
-- default (safe). This script only drops U2-S1 objects when an operator
-- explicitly needs a hard reverse on a non-production database.
-- Production code rollback = previous ops-api edge version; columns remaining
-- are ignored by older readers.

DROP TABLE IF EXISTS public.makesafe_report_pack_cycles;
ALTER TABLE public.job_service_reports
  DROP COLUMN IF EXISTS attendance_cycle_id,
  DROP COLUMN IF EXISTS cycle_attribution;
ALTER TABLE public.makesafe_status_holds
  DROP COLUMN IF EXISTS attendance_cycle_id,
  DROP COLUMN IF EXISTS cycle_attribution;
ALTER TABLE public.job_assignments
  DROP COLUMN IF EXISTS attendance_cycle_id,
  DROP COLUMN IF EXISTS cycle_attribution;
-- review_state / needs_money_review / portal_ready status CHECK left in place
-- (parity columns; dropping them can break live writers that already use them).
DROP TABLE IF EXISTS public.makesafe_attendance_cycles;
