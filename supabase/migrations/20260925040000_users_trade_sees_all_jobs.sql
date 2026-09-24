-- Trade App "see everything" tier (Captain ruling 2026-09-24).
--
-- The Trade App previously derived company-wide job visibility from
-- `OPS_API_STAFF_OPERATOR_ROLES` (admin/owner/ops_manager) — the SAME set that
-- gates every Ops Dashboard staff action. That role set stays exactly as it is
-- for every non-Trade-App gate; this column exists so Trade App job visibility
-- can be decided independently of it, per-user, per the Captain's explicit
-- named tier ("go A" — office role unchanged, Trade App visibility decided by
-- managed_verticals plus this flag).
--
-- Status-quo-preserving by construction. The backfill below sets the flag for
-- every EXISTING user whose role is admin/owner/ops_manager — matched by role
-- only, never by name or id — so every person who sees everything in the
-- Trade App today keeps seeing everything the instant the matching ops-api
-- deploys. Nobody loses or gains Trade App visibility at merge.
--
-- Two-phase rollout:
--   Phase 1 (this migration + the matching ops-api, one merge): invisible.
--   Phase 2 (a separate, Marnin-approved hand-run SQL block recorded in the
--   pull request that introduces this migration, run any time after merge):
--   applies the Captain's per-person rules by stable user id. That block is
--   what actually narrows Nithin, Khairo and Hugo (trade_sees_all_jobs=false)
--   and corrects managed_verticals; it is never applied by this migration.
--
-- The backfill runs once, only on the apply that adds the column: a re-apply
-- finds the column present and never re-widens a Phase 2 narrowing.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'trade_sees_all_jobs'
  ) THEN
    ALTER TABLE public.users
      ADD COLUMN trade_sees_all_jobs boolean NOT NULL DEFAULT false;

    UPDATE public.users
    SET trade_sees_all_jobs = true
    WHERE role::text IN ('admin', 'owner', 'ops_manager');
  END IF;
END
$$;

COMMENT ON COLUMN public.users.trade_sees_all_jobs IS
  'Explicit Trade App see-everything tier (Captain ruling 2026-09-24): grants full Trade App job visibility, every vertical, full history, independent of users.role and independent of users.managed_verticals. Read by ops-api authTrade() into TradeAuthContext.seeEverything and consumed by _resolveManagerVisibility / resolveTradeJobAccessTier / resolveMakesafeTradeViewer. Backfilled true for every admin/owner/ops_manager when the column was added so the deploy changes no one''s visibility; per-person narrowing is a separate approved data change. Does NOT affect OPS_API_STAFF_OPERATOR_ROLES or any other Ops Dashboard / non-Trade-App authorization gate (allocation authz, pricing, money, admin actions all keep reading users.role exactly as before).';
