-- Quote-builder draft crew work orders and purchase orders.
--
-- Contract: docs/quote-builder-contract.md section 6. Actions:
-- quote_builder_make_work_order and quote_builder_make_purchase_orders.
--
-- The switch is quote_builder_orders_v1, seeded OFF. While it is off, missing
-- or unreadable, those actions refuse before any write, quote_builder_get_job
-- adds no keys, job acceptance does not filter on these columns, and
-- pushPOToXero does not refuse a blank or placeholder supplier. The version id
-- is the idempotency key: a renamed supplier still matches the rows already
-- made for that issued version. While the flag is on, job acceptance
-- (updateJobStatus) excludes any row with this column set, so a quote-made
-- crew work order is never auto-approved and a quote-made purchase order is
-- never pushed to Xero, and pushPOToXero refuses a blank or placeholder
-- supplier before it reads the job.
--
-- ON DELETE RESTRICT: clearing the link would make the rows look like ordinary
-- orders, and acceptance would then approve or push them.
--
-- Nothing here writes a work order, a purchase order, or an event. Turn the
-- flag on only on the owner's word.
--
-- Rollback: supabase/rollbacks/20261014140000_quote_builder_orders_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT
  'quote_builder_orders_v1',
  false,
  'Quote builder orders: when on, staff can make one draft crew work order and draft purchase orders from an issued quote-builder version, acceptance skips those rows, and a blank or placeholder supplier cannot be pushed to Xero. Off, missing or unreadable: the two make actions refuse, quote_builder_get_job is unchanged, acceptance does not filter on the new columns, and pushPOToXero does not refuse a placeholder supplier. Turn on only on the owner''s word.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags
  WHERE flag_name = 'quote_builder_orders_v1'
);

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS quote_builder_version_id uuid NULL
  REFERENCES public.quote_builder_versions(id) ON DELETE RESTRICT;

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS quote_builder_version_id uuid NULL
  REFERENCES public.quote_builder_versions(id) ON DELETE RESTRICT;

-- One crew work order per issued version. A second press re-reads this row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_orders_one_quote_builder_version
  ON public.work_orders (quote_builder_version_id)
  WHERE quote_builder_version_id IS NOT NULL;

-- Many purchase orders per version (one per supplier group). Lookup only:
-- the name is not part of the key, so renaming a supplier cannot mint another.
CREATE INDEX IF NOT EXISTS idx_purchase_orders_quote_builder_version
  ON public.purchase_orders (quote_builder_version_id)
  WHERE quote_builder_version_id IS NOT NULL;

COMMENT ON COLUMN public.work_orders.quote_builder_version_id IS
  'Set only by quote_builder_make_work_order. Acceptance ignores these rows.';
COMMENT ON COLUMN public.purchase_orders.quote_builder_version_id IS
  'Set only by quote_builder_make_purchase_orders. Acceptance never pushes these rows.';
