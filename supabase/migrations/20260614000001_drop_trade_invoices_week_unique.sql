-- ════════════════════════════════════════════════════════════════════════════
-- Drop per-week uniqueness on trade_invoices
-- Mission: allow-multiple-invoices-per-week 2026-06-14
--
-- History of idx_trade_inv_unique:
--   20260325000003 — created: UNIQUE (user_id, week_start)
--   20260401000001 — recreated as partial: UNIQUE (user_id, week_start)
--                    WHERE week_start IS NOT NULL
--   20260401000013 — dropped (subsequently re-added out-of-band via
--                    pr0-rate-repair-staged.sql STEP 11 as the same partial
--                    index to protect clean prod data)
--   20260614000001 — THIS FILE: drop permanently so multiple invoices per
--                    week are allowed (supplemental/correction submissions).
--
-- The app-side 409 duplicate-week guard was also removed from generate_trade_invoice
-- in the same PR. Per-assignment protection (invoiced_in) is unchanged.
-- ════════════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS idx_trade_inv_unique;
