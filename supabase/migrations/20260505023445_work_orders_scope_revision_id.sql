-- Scope-Memory-Saving Loop 1, step 7 — work_orders.scope_revision_id
--
-- Status: APPLIED 2026-05-05 to project kevgrhcjxspbxgovpmfl
--   Supabase ledger: version=20260505023445 name=work_orders_scope_revision_id
--   Filename: was authored as 20260505000003_work_orders_scope_revision_id.sql
--     in supabase/migrations/_drafts/. After apply, promoted to
--     supabase/migrations/ and renamed to
--     20260505023445_work_orders_scope_revision_id.sql so the filename
--     prefix matches the Supabase ledger version exactly (same
--     convention adopted in step 6 for 20260504090757 + 20260504125852).
--     Marnin's literal approval phrase used the original draft name:
--     "apply 20260505000003_work_orders_scope_revision_id.sql"
--     — preserved verbatim here for the audit record.
--
-- Re-apply safety: idempotent. ALTER TABLE ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS. A `supabase db push` against a fresh branch
-- that replays this migration no-ops cleanly against the existing schema.
--
-- Roadmap : cio/operations/board/Scope-Memory-Saving/scope-freeze-end-to-end/roadmap.md (step 7)
-- Strategy: strategy/scope-freeze-lifecycle-evidence.md (Loop 0 §6 step 6 + §8 Loop 4)
-- Companion: 20260501100000_quote_revision_binding_and_read_shape.sql added work_orders.quote_revision_id last week
--            following the same shape; this migration adds the parallel scope_revision_id column.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why
-- ─────────────────────────────────────────────────────────────────────────────
-- Per strategy doc § 6 step 6: "Generate WO PDF from frozen revision.
-- Operator (or Shaun) creates a work order from the dashboard.
-- createWorkOrder accepts scope_revision_id. WO PDF generator reads frozen
-- scope/pricing canonical text + frozen scope_artifacts PNGs, renders WO
-- PDF, saves as scope_artifacts row of artifact_type='work_order_pdf'."
--
-- The work_orders table currently exposes scope_items as a free-form jsonb
-- array passed by the caller. After this column ships:
--   * ops-api create_work_order accepts scope_revision_id on the body.
--   * When set, the helper loads frozen scope_canonical_text + pricing_canonical_text
--     from scope_revisions instead of trusting the caller's scope_items shape.
--   * The frozen revision id is recorded on the WO row so audits can
--     reconstruct exactly which sealed scope produced the WO.
--   * The WO PDF (when produced) is persisted as a scope_artifacts row of
--     artifact_type='work_order_pdf' tied to the same scope_revision_id.
--
-- Cap 0 V2 enforce-mode is NOT flipped by this migration. Existing WOs
-- without a scope_revision_id continue to work — the column is nullable.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Core principles
-- ─────────────────────────────────────────────────────────────────────────────
--   * Additive only. New nullable uuid column + a partial index. No row,
--     trigger, RLS policy, or constraint on existing columns is touched.
--   * Backwards compatible. Pre-step-7 WOs already exist (10 quote_revisions
--     in prod implies similar shape on work_orders) — they remain valid
--     after apply with scope_revision_id NULL.
--   * No backfill in this migration. A future read-only Loop 11 audit can
--     identify candidates; backfill is a separate Marnin-gated slice.
--   * The FK references public.scope_revisions(id) ON DELETE RESTRICT,
--     mirroring the work_orders.quote_revision_id pattern from
--     20260501100000_quote_revision_binding_and_read_shape.sql so the
--     constraint shape stays uniform across the four citation columns
--     on work_orders / purchase_orders / job_documents / quote_revisions.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback (time-to-revert: <2s)
-- ─────────────────────────────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS work_orders_scope_revision_idx;
--   ALTER TABLE public.work_orders DROP COLUMN IF EXISTS scope_revision_id;
--   -- Safe IFF no WOs have been written with a non-null scope_revision_id;
--   -- if any have, the rollback drops the citation but the WO row remains.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Apply notes (historical — this migration HAS BEEN APPLIED; see Status block)
-- ─────────────────────────────────────────────────────────────────────────────
-- The pre-apply approval phrase Marnin used at the protected gate was
-- "apply 20260505000003_work_orders_scope_revision_id.sql", referencing
-- the original draft filename. Apply was via
-- mcp__claude_ai_Supabase__apply_migration with
-- name='work_orders_scope_revision_id' against project kevgrhcjxspbxgovpmfl.
-- Postflight verification (read-only):
--   data_type=uuid, is_nullable=YES, FK → scope_revisions(id) ON DELETE RESTRICT,
--   partial index work_orders_scope_revision_idx WHERE scope_revision_id IS NOT NULL,
--   9 existing work_orders rows preserved with scope_revision_id NULL.

BEGIN;

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS scope_revision_id uuid NULL
    REFERENCES public.scope_revisions(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS work_orders_scope_revision_idx
  ON public.work_orders (scope_revision_id)
  WHERE scope_revision_id IS NOT NULL;

COMMENT ON COLUMN public.work_orders.scope_revision_id IS
  'Optional FK to the frozen scope_revisions row this work order was '
  'generated from. NULL on rows created before Scope-Memory-Saving step 7. '
  'When non-NULL, the WO PDF is required to read scope/pricing/artifacts '
  'from the cited frozen revision rather than from mutable jobs.scope_json. '
  'Strategy: strategy/scope-freeze-lifecycle-evidence.md § 6 step 6.';

COMMIT;
