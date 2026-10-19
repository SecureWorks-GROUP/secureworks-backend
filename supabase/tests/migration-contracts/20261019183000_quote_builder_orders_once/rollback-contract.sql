-- Rollback contract: 20261019183000_quote_builder_orders_once. The down drops the switch row, the
-- marker table, the key, the CHECK and the seq column, and leaves purchase_orders, its version
-- link and the work order key from 20261014140000 in place.
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF to_regclass('public.quote_builder_order_marks') IS NOT NULL THEN
  RAISE EXCEPTION 'quote builder orders once rollback contract: the marker table still exists';
 END IF;
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'purchase_orders' AND column_name = 'quote_builder_po_seq') THEN
  RAISE EXCEPTION 'quote builder orders once rollback contract: quote_builder_po_seq still exists';
 END IF;
 IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'quote_builder_purchase_orders_v1') THEN
  RAISE EXCEPTION 'quote builder orders once rollback contract: the purchase order switch row still exists';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'purchase_orders' AND column_name = 'quote_builder_version_id') THEN
  RAISE EXCEPTION 'quote builder orders once rollback contract: the version link was dropped';
 END IF;
 IF to_regclass('public.uq_work_orders_one_quote_builder_version') IS NULL THEN
  RAISE EXCEPTION 'quote builder orders once rollback contract: the work order key was dropped';
 END IF;
END $$;
SELECT count(*) FROM public.purchase_orders WHERE quote_builder_version_id IS NOT NULL;
