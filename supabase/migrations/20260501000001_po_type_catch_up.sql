-- Catch-up migration: purchase_orders.po_type (repo↔DB drift reconcile, M3-U1)
--
-- Mission : coding/work/missions/profit-money-surface-2026-07-07/CONTRACT.md (M3-U1)
-- Campaign: profitability-job-costing · wiki #140
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why this file exists
-- ─────────────────────────────────────────────────────────────────────────────
-- purchase_orders.po_type is ALREADY LIVE in prod (verified 2026-07-07: text,
-- DEFAULT 'material', nullable; all live rows = 'material'). NO migration ever
-- created it — it was added out-of-band, before the quote-revision-binding
-- migration 20260501100000_quote_revision_binding_and_read_shape.sql, whose
-- view body already SELECTs po.po_type (line ~61). That means a fresh scratch
-- apply of this repo would FAIL at 20260501100000 because nothing created the
-- column first. This catch-up migration closes that gap: it records the live-only
-- DDL as a migration and is deliberately numbered 20260501000001 so it runs
-- BEFORE 20260501100000 on a clean database.
--
-- The M8 labour-PO allowance engine (a later mission) is the owner of the
-- po_type='labour' value and any backfill — this file records ONLY the column
-- that already exists live; it does NOT add values, constraints, or backfill.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- HAND-APPLIED: the column was applied to prod out-of-band (date unknown; present
-- before 2026-05-01 when 20260501100000 first read it). This file is the catch-up
-- record only. Additive + idempotent (ADD COLUMN IF NOT EXISTS); a no-op on
-- re-apply and on the live database where the column already exists.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS po_type text DEFAULT 'material';

COMMENT ON COLUMN public.purchase_orders.po_type IS
  'Purchase-order kind. Live default ''material'' (all live rows are ''material'' as of 2026-07-07). The ''labour'' value + any burn-down semantics are owned by the M8 labour-PO allowance engine, not this catch-up record. Added out-of-band before any migration; this file (M3-U1) is the drift catch-up so a fresh scratch apply resolves 20260501100000''s read of po.po_type.';
