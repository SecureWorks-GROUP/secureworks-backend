-- Dispatch v2: ASAP or Pick a date on each supplier box.
--
-- Shaun, 29 Oct 2026: most orders go out "as soon as you can". Each supplier
-- box now carries its date choice. ASAP greys out the calendar and the order
-- email says "Date: ASAP" (so the send is allowed); Pick a date works as
-- before. A sent ASAP order with no supplier date yet is "ASAP, waiting on
-- their date", not red "no date" and not counted late.
--
-- Contract: docs/dispatch-v2-board-contract.md, section 3c. Writers:
-- dispatch_v2_set_date_mode (dispatch_v2_payment_write.ts) and
-- dispatch_v2_make_email (dispatch_v2_store.ts), the press audited in
-- job_events. Readers: dispatch_board.ts and dispatch_v2_store.ts.
--
-- Three nullable columns and one check on job_material_suppliers. The mode
-- column is added with NO default first, so every existing box stays NULL
-- (read as "date" when the box or its open email has a date, else "asap");
-- only then is the default set, so every new box starts on ASAP. No
-- backfill, no table, trigger, function or publication. Nothing here writes
-- jobs, purchase_orders, suppliers, Xero, GHL, SMS or email.
--
-- Rollback: supabase/rollbacks/20261030120000_dispatch_v2_box_date_mode_down.sql.

ALTER TABLE public.job_material_suppliers
  ADD COLUMN IF NOT EXISTS order_date_mode text NULL,
  ADD COLUMN IF NOT EXISTS order_date_mode_set_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS order_date_mode_set_by_email text NULL;

-- New boxes start on ASAP. Set after the column exists, so existing boxes
-- keep NULL.
ALTER TABLE public.job_material_suppliers
  ALTER COLUMN order_date_mode SET DEFAULT 'asap';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_material_suppliers_order_date_mode'
                 AND conrelid = 'public.job_material_suppliers'::regclass) THEN
    ALTER TABLE public.job_material_suppliers
      ADD CONSTRAINT job_material_suppliers_order_date_mode
      CHECK (order_date_mode IS NULL OR order_date_mode IN ('asap', 'date'));
  END IF;
END $$;

COMMENT ON COLUMN public.job_material_suppliers.order_date_mode IS
  'Dispatch v2: the box''s date choice for its next order email, asap or date. NULL on boxes made before 30 Oct 2026 (read as date when the box or its open email has a date, else asap).';
COMMENT ON COLUMN public.job_material_suppliers.order_date_mode_set_at IS
  'Dispatch v2: when a person last chose ASAP or Pick a date (null = never, the default).';
COMMENT ON COLUMN public.job_material_suppliers.order_date_mode_set_by_email IS
  'Dispatch v2: who last chose ASAP or Pick a date.';
