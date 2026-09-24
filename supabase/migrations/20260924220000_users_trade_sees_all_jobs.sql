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
-- Schema-only, additive, safe default. No production data is seeded here —
-- the Captain-approved per-person tier assignment (Shaun/Marnin/Jan/Esther
-- true; Khairo/Hugo/Nithin/Ryan's managed_verticals corrected) is a separate
-- hand-run SQL block, gated on Marnin's explicit approval, recorded in the
-- pull request that introduces this migration. Applying that data change
-- BEFORE this code deploys is a no-op under the old (role-based) visibility
-- code, so the required order is: data first, then deploy — see the PR body.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS trade_sees_all_jobs boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.trade_sees_all_jobs IS
  'Explicit Trade App see-everything tier (Captain ruling 2026-09-24): grants full Trade App job visibility, every vertical, full history, independent of users.role and independent of users.managed_verticals. Read by ops-api authTrade() into TradeAuthContext.seeEverything and consumed by _resolveManagerVisibility / resolveTradeJobAccessTier / resolveMakesafeTradeViewer. Does NOT affect OPS_API_STAFF_OPERATOR_ROLES or any other Ops Dashboard / non-Trade-App authorization gate (allocation authz, pricing, money, admin actions all keep reading users.role exactly as before).';
