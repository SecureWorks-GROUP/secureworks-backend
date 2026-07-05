-- Manager View — per-user managed verticals (trade app).
--
-- Marnin locked the model (2026-07-05): manager rights are ONE list per user
-- (`managed_verticals`), NOT three bespoke per-vertical booleans. A user whose
-- `managed_verticals` contains a vertical sees the full open pool of that
-- vertical's jobs in the trade app (every active/non-archived job of that
-- jobs.type) unioned with their own assignments, and may allocate any job of
-- that vertical to any active installer — exactly the pattern the legacy
-- `makesafe_manager` boolean gave make-safe managers, generalised to fencing /
-- patio / decking. Enforced server-side in ops-api
-- (_resolveManagerVisibility / myJobs / _resolveAllocationAuthz / allocate_job).
--
-- Values are aligned to jobs.type: 'makesafe', 'fencing', 'patio', 'decking'.
--
-- `makesafe_manager` is KEPT in place and treated as LEGACY INPUT ONLY: this
-- migration backfills `managed_verticals` from it (a makesafe_manager=true row
-- gains 'makesafe'), after which the runtime reads managed_verticals, not the
-- boolean. No named people are hand-seeded here — the fencing/patio/makesafe
-- re-seat (Hugo/Henry/Nithin) is applied separately by the orchestrator with
-- verified user ids (see PR body).
--
-- HAND-APPLIED: applied manually by the orchestrator, not by CI auto-migrate.
-- Additive and idempotent (safe to re-run).

-- 1. Additive column. NOT NULL with an empty-array default so existing rows and
--    all future inserts are well-defined without a backfill of every row.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS managed_verticals text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.users.managed_verticals IS
  'Verticals (jobs.type values: makesafe/fencing/patio/decking) this user manages. A managed vertical grants the full open pool of that vertical in the trade app (unioned with own assignments) plus allocation rights over that vertical, without dispatcher see-all. Supersedes the legacy makesafe_manager boolean (which is backfilled into this list).';

-- 2. Keep values aligned to jobs.type. The `<@` ("is contained by") operator
--    asserts every element is one of the allowed verticals. An empty array
--    trivially satisfies it. Guarded so the migration is idempotent (a plain
--    ADD CONSTRAINT would error on the second run).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_managed_verticals_valid'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_managed_verticals_valid
      CHECK (managed_verticals <@ ARRAY['makesafe','fencing','patio','decking']::text[]);
  END IF;
END $$;

-- 3. Backfill from the legacy boolean: every makesafe_manager=true user gains
--    'makesafe' in managed_verticals. array_append is guarded so it appends
--    only when 'makesafe' is not already present — it never clobbers other
--    verticals a row may already carry, and re-running is a no-op.
UPDATE public.users
  SET managed_verticals = array_append(managed_verticals, 'makesafe')
  WHERE makesafe_manager = true
    AND NOT ('makesafe' = ANY(managed_verticals));
