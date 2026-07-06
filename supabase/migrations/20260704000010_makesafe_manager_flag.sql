-- MakeSafe manager visibility flag (trade app).
--
-- Adds a per-user boolean that grants full open make-safe pool visibility in the
-- trade app: a flagged user sees EVERY active (non-archived) make-safe job as an
-- open field-report card, unioned with their own assigned jobs, regardless of
-- assignment. This is the same pool a dispatcher (admin / ops_manager) already
-- sees, but the flagged user is NOT a dispatcher: they do NOT get the see-all
-- view of every job type, only the make-safe pool. Enforced server-side in the
-- ops-api trade route (see _resolveMakesafeVisibility / myJobs).
--
-- HAND-APPLIED: this migration is applied manually by the orchestrator, not by
-- CI auto-migrate. It is additive and idempotent (safe to re-run).

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS makesafe_manager boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.makesafe_manager IS
  'When true, this user sees the full open make-safe pool in the trade app (every active/non-archived make-safe job) unioned with their own assignments, without dispatcher see-all rights.';

-- Seed the initial make-safe managers: Hugo and Nithin. Idempotent.
UPDATE public.users
  SET makesafe_manager = true
  WHERE id IN (
    'b353f39a-b3cc-495d-a016-50ebf4a8497d', -- Hugo
    '5862cf1d-0a3b-4836-8fd1-d69f95aa2f73'  -- Nithin
  );
