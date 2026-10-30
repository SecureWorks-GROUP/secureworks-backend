-- Dispatch v2: Pay on pickup / Pay on delivery on a supplier order.
--
-- Shaun, 29 Oct 2026: some suppliers confirm the order and take the money
-- when we collect it, or when they drop it off. Pay on pickup / Pay on
-- delivery records that: the box moves to Order confirmed exactly as Mark
-- paid would, and carries a visible tag so the crew or the office knows money
-- is still owed on the day. A record only: it pays nobody, touches no Xero
-- and sends nothing. Allowed on any supplier box, on account included.
--
-- Contract: docs/dispatch-v2-board-contract.md, section 3c. Rules:
-- supabase/functions/ops-api/dispatch_v2_payment.ts (a tag counts only for
-- the order it was set against, on the same terms as a paid stamp). Writer:
-- dispatch_v2_set_pay_on (dispatch_v2_payment_write.ts), audited in
-- job_events. Readers: dispatch_board.ts and dispatch_v2_store.ts.
--
-- Four nullable columns and one check on job_material_suppliers: every
-- existing box and every other Dispatch action is untouched. No backfill, no
-- table, trigger, function or publication. Nothing here writes jobs,
-- purchase_orders, suppliers, Xero, GHL, SMS or email.
--
-- Rollback: supabase/rollbacks/20261029120200_dispatch_v2_box_pay_on_down.sql.

ALTER TABLE public.job_material_suppliers
  ADD COLUMN IF NOT EXISTS pay_on text NULL,
  ADD COLUMN IF NOT EXISTS pay_on_set_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS pay_on_set_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pay_on_set_by_email text NULL;

DO $$
BEGIN
  -- The tag is pickup or delivery, and is set if and only if it says when and
  -- by whom (the user id is null for the ops key and when the person is
  -- removed).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_material_suppliers_pay_on_stamp'
                 AND conrelid = 'public.job_material_suppliers'::regclass) THEN
    ALTER TABLE public.job_material_suppliers
      ADD CONSTRAINT job_material_suppliers_pay_on_stamp
      CHECK (
        (pay_on IS NULL OR pay_on IN ('pickup', 'delivery'))
        AND (pay_on IS NULL) = (pay_on_set_at IS NULL)
        AND (pay_on IS NULL) = (pay_on_set_by_email IS NULL)
      );
  END IF;
END $$;

COMMENT ON COLUMN public.job_material_suppliers.pay_on IS
  'Dispatch v2: pickup or delivery when we pay this supplier on the day (Pay on pickup / Pay on delivery). Counts only while newer than the box''s newest order email and than a hand pick of Awaiting payment.';
COMMENT ON COLUMN public.job_material_suppliers.pay_on_set_at IS
  'Dispatch v2: when a person set the Pay on tag.';
COMMENT ON COLUMN public.job_material_suppliers.pay_on_set_by_email IS
  'Dispatch v2: who set the Pay on tag.';
