-- Down for 20261019183000_quote_builder_orders_once.
-- Roll ops-api back first: the make action writes quote_builder_po_seq and
-- fails against a table without it. With the older ops-api the double-press
-- race of SQ-14 point 27 returns.
DROP INDEX IF EXISTS public.uq_purchase_orders_quote_builder_version_seq;
ALTER TABLE public.purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_quote_builder_seq_with_version;
ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS quote_builder_po_seq;
