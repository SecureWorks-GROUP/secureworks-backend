-- Dispatch v2: remember when a person re-opened a supplier order's payment.
--
-- Picking Awaiting payment by hand re-opens the payment: a paid stamp or a
-- Pay on tag made before that pick no longer counts. Until now the rule read
-- the box's stored stage, which keeps only the LATEST hand pick, so a second
-- hand pick after the re-open (for example Manufacturing) made the old stamp
-- count again. This column keeps the time of the latest hand pick of
-- Awaiting payment, whatever is picked after it.
--
-- Contract: docs/dispatch-v2-board-contract.md, section 3c (rule 5). Rules:
-- supabase/functions/ops-api/dispatch_v2_payment.ts (dispatchV2StampCounts).
-- Writer: dispatch_v2_set_material_stage (dispatch_v2_material_stage_write.ts)
-- when the stage picked is Awaiting payment. Readers: dispatch_board.ts and
-- dispatch_v2_store.ts.
--
-- One nullable column on job_material_suppliers: every existing box and every
-- other Dispatch action is untouched. No backfill (a box re-opened before
-- this column existed still has its stored Awaiting payment pick, which the
-- rule also reads). No table, trigger, function or publication. Nothing here
-- writes jobs, purchase_orders, suppliers, Xero, GHL, SMS or email.
--
-- Rollback: supabase/rollbacks/20261029120300_dispatch_v2_box_payment_reopened_down.sql.

ALTER TABLE public.job_material_suppliers
  ADD COLUMN IF NOT EXISTS payment_reopened_at timestamptz NULL;

COMMENT ON COLUMN public.job_material_suppliers.payment_reopened_at IS
  'Dispatch v2: when a person last picked Awaiting payment by hand. A paid stamp or Pay on tag counts only while newer than this.';
