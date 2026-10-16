-- Dispatch slice 6: Deliveries. Who set an order's confirmed delivery date by
-- hand, and who sighted the delivery on site and when.
--
-- Contract: docs/dispatch-slice-6-contract.md. Rules:
-- supabase/functions/ops-api/dispatch_deliveries.ts. Writes go only through the
-- three ops-api `dispatch_delivery_*` actions, each a person's own press.
--
-- Six nullable columns on purchase_orders and one check, so every existing
-- order, create_po, update_po, list_pos (select *) and the Xero order sync are
-- untouched. No table, trigger, function or publication. The sighting is kept
-- apart from delivery_confirmed_at, which keeps its meaning and gains no writer.
--
-- Rollback: supabase/rollbacks/20261016150000_dispatch_deliveries_down.sql.

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS confirmed_delivery_set_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS confirmed_delivery_set_by uuid NULL REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS confirmed_delivery_set_by_email text NULL,
  ADD COLUMN IF NOT EXISTS delivery_sighted_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS delivery_sighted_by uuid NULL REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS delivery_sighted_by_email text NULL;

-- A sighting always names a person.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_delivery_sighted_named'
                 AND conrelid = 'public.purchase_orders'::regclass) THEN
    ALTER TABLE public.purchase_orders
      ADD CONSTRAINT purchase_orders_delivery_sighted_named
      CHECK ((delivery_sighted_at IS NULL) = (delivery_sighted_by_email IS NULL));
  END IF;
END $$;
