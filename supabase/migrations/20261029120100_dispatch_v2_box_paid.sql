-- Dispatch v2: Mark paid on a supplier order (the payment step).
--
-- Shaun, 29 Oct 2026: when a supplier we have no account with comes back
-- with a quote, the order waits on us to pay, and stays there until someone
-- records in Dispatch that we paid. Mark paid is a record only: it pays
-- nobody, touches no Xero and sends nothing. It stamps who and when on the
-- supplier box, and the box then shows Order confirmed.
--
-- Contract: docs/dispatch-v2-board-contract.md, section 3c. Rules:
-- supabase/functions/ops-api/dispatch_v2_payment.ts (a stamp counts only for
-- the order it was marked against). Writers: dispatch_v2_mark_paid and
-- dispatch_v2_undo_paid (dispatch_v2_payment_write.ts), each audited in
-- job_events. Readers: dispatch_board.ts and dispatch_v2_store.ts.
--
-- Three nullable columns and one check on job_material_suppliers: every
-- existing box and every other Dispatch action is untouched. No backfill, no
-- table, trigger, function or publication. Nothing here writes jobs,
-- purchase_orders, suppliers, Xero, GHL, SMS or email.
--
-- Rollback: supabase/rollbacks/20261029120100_dispatch_v2_box_paid_down.sql.

ALTER TABLE public.job_material_suppliers
  ADD COLUMN IF NOT EXISTS paid_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS paid_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS paid_by_email text NULL;

DO $$
BEGIN
  -- A paid stamp always says by whom (the email; the user id is null for the
  -- ops key and when the person is removed).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_material_suppliers_paid_stamp'
                 AND conrelid = 'public.job_material_suppliers'::regclass) THEN
    ALTER TABLE public.job_material_suppliers
      ADD CONSTRAINT job_material_suppliers_paid_stamp
      CHECK ((paid_at IS NULL) = (paid_by_email IS NULL));
  END IF;
END $$;

COMMENT ON COLUMN public.job_material_suppliers.paid_at IS
  'Dispatch v2: when a person pressed Mark paid on this supplier order (a record only, no payment is made). Counts only while newer than the box''s newest order email and than a hand pick of Awaiting payment.';
COMMENT ON COLUMN public.job_material_suppliers.paid_by_email IS
  'Dispatch v2: who pressed Mark paid.';
