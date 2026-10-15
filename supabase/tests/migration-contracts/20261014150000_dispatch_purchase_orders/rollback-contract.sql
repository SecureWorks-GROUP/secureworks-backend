-- Rollback contract: 20261014150000_dispatch_purchase_orders. The down drops the held-draft table,
-- the four functions and the nine purchase_orders columns, and leaves purchase_orders, the slice 4
-- tables and the sequence in place.
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF to_regclass('public.job_order_emails') IS NOT NULL THEN
  RAISE EXCEPTION 'dispatch purchase orders rollback contract: job_order_emails still exists';
 END IF;
 IF to_regprocedure('public.dispatch_commit_order(jsonb)') IS NOT NULL
  OR to_regprocedure('public.dispatch_commit_order_update(jsonb)') IS NOT NULL
  OR to_regprocedure('public.dispatch_release_unknown_send(jsonb)') IS NOT NULL
  OR to_regprocedure('public.dispatch_next_po_number()') IS NOT NULL THEN
  RAISE EXCEPTION 'dispatch purchase orders rollback contract: a dispatch function still exists';
 END IF;
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'purchase_orders'
             AND column_name IN ('supplier_id', 'source', 'created_by_email', 'pdf_path', 'pdf_sha256',
                                 'pdf_version', 'pdf_rendered_at', 'last_sent_pdf_version', 'last_sent_at')) THEN
  RAISE EXCEPTION 'dispatch purchase orders rollback contract: a slice 5 purchase_orders column still exists';
 END IF;
 IF to_regclass('public.job_material_lines_purchase_order_id_idx') IS NOT NULL THEN
  RAISE EXCEPTION 'dispatch purchase orders rollback contract: the purchase_order_id index still exists';
 END IF;
 IF to_regclass('public.purchase_orders') IS NULL OR to_regclass('public.job_material_lines') IS NULL
  OR to_regclass('public.po_number_seq') IS NULL THEN
  RAISE EXCEPTION 'dispatch purchase orders rollback contract: the down removed something it does not own';
 END IF;
END $$;
