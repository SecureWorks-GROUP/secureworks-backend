-- Down for 20261014150000_dispatch_purchase_orders. Roll ops-api back first: the deployed
-- dispatch_order* actions, dispatch_email_link_po and the extended dispatch_materials read name
-- everything below. Drops the held-draft table, the two transaction functions, the number function,
-- the two indexes, the source check and the nine purchase_orders columns. Dispatch orders stay as
-- ordinary purchase orders (their lines keep purchase_order_id). The sequence is left where it is,
-- so a number already given is never given again, and the private bucket and its PDFs are kept.
DROP FUNCTION IF EXISTS public.dispatch_commit_order_update(jsonb);
DROP FUNCTION IF EXISTS public.dispatch_commit_order(jsonb);
DROP FUNCTION IF EXISTS public.dispatch_next_po_number();
DROP TABLE IF EXISTS public.job_order_emails;
DROP INDEX IF EXISTS public.purchase_orders_open_dispatch_supplier_key;
DROP INDEX IF EXISTS public.purchase_orders_org_po_number_key;
ALTER TABLE public.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_source_valid;
ALTER TABLE public.purchase_orders
  DROP COLUMN IF EXISTS supplier_id,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS created_by_email,
  DROP COLUMN IF EXISTS pdf_path,
  DROP COLUMN IF EXISTS pdf_sha256,
  DROP COLUMN IF EXISTS pdf_version,
  DROP COLUMN IF EXISTS pdf_rendered_at,
  DROP COLUMN IF EXISTS last_sent_pdf_version,
  DROP COLUMN IF EXISTS last_sent_at;
