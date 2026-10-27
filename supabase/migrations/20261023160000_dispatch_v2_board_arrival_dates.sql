-- Dispatch v2 board: the delivery date of each supplier order, and whether
-- that date is confirmed (the Arrival line: solid = confirmed, ring = a date
-- not yet confirmed).
--
-- Contract: docs/dispatch-v2-board-contract.md. Rules and reader:
-- supabase/functions/ops-api/dispatch_board.ts (the pipeline&dispatch=1&board=v2
-- list read and the dispatch_arrival read).
--
-- In v2 one supplier box (job_material_suppliers) is one order: one email,
-- one delivery date. v2 has no purchase orders, so the date lives on the box.
-- Seven nullable columns and three checks, so every existing box and the
-- dispatch_materials actions are untouched. No table, trigger, function or
-- publication. Nothing here writes jobs, purchase_orders, suppliers or Xero.
--
-- Writers (none in this migration): a person setting the date by hand, and
-- Accept on a supplier reply's suggested date (slice 8). Either one stamps
-- the date with who set it; a confirmation also names the person.
--
-- Rollback: supabase/rollbacks/20261023160000_dispatch_v2_board_arrival_dates_down.sql.

ALTER TABLE public.job_material_suppliers
  ADD COLUMN IF NOT EXISTS delivery_date date NULL,
  ADD COLUMN IF NOT EXISTS delivery_date_source text NULL,
  ADD COLUMN IF NOT EXISTS delivery_date_set_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS delivery_date_set_by_email text NULL,
  ADD COLUMN IF NOT EXISTS delivery_date_confirmed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS delivery_date_confirmed_by uuid NULL REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS delivery_date_confirmed_by_email text NULL;

DO $$
BEGIN
  -- Where the date came from: typed by a person, or accepted from a supplier
  -- reply.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_material_suppliers_delivery_date_source_valid'
                 AND conrelid = 'public.job_material_suppliers'::regclass) THEN
    ALTER TABLE public.job_material_suppliers
      ADD CONSTRAINT job_material_suppliers_delivery_date_source_valid
      CHECK (delivery_date_source IS NULL OR delivery_date_source IN ('by_hand', 'supplier_reply'));
  END IF;
  -- A date always says when it was set and where it came from.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_material_suppliers_delivery_date_stamped'
                 AND conrelid = 'public.job_material_suppliers'::regclass) THEN
    ALTER TABLE public.job_material_suppliers
      ADD CONSTRAINT job_material_suppliers_delivery_date_stamped
      CHECK (delivery_date IS NULL OR (delivery_date_set_at IS NOT NULL AND delivery_date_source IS NOT NULL));
  END IF;
  -- A confirmation needs a date and always names a person.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_material_suppliers_delivery_confirmed_named'
                 AND conrelid = 'public.job_material_suppliers'::regclass) THEN
    ALTER TABLE public.job_material_suppliers
      ADD CONSTRAINT job_material_suppliers_delivery_confirmed_named
      CHECK (delivery_date_confirmed_at IS NULL
             OR (delivery_date IS NOT NULL AND delivery_date_confirmed_by_email IS NOT NULL));
  END IF;
END $$;

COMMENT ON COLUMN public.job_material_suppliers.delivery_date IS
  'Dispatch v2: the day this supplier''s order is due on site (Perth day). Set by hand or by accepting a supplier reply. Null = no date yet.';
COMMENT ON COLUMN public.job_material_suppliers.delivery_date_confirmed_at IS
  'Dispatch v2: when the delivery date was confirmed (the supplier agreed it). Null = the date is in but not confirmed (a ring on the Arrival line).';
