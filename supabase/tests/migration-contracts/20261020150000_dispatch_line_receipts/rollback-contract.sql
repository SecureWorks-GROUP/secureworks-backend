-- Rollback contract: 20261020150000_dispatch_line_receipts. The down drops the receipts table, both
-- trigger functions, the line stamp trigger and the stamp column, and leaves job_material_lines and
-- every slice 4 to 6 column in place.
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF to_regclass('public.job_material_line_receipts') IS NOT NULL THEN
  RAISE EXCEPTION 'dispatch line receipts rollback contract: the receipts table still exists';
 END IF;
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'job_material_lines' AND column_name = 'purchase_order_attached_at') THEN
  RAISE EXCEPTION 'dispatch line receipts rollback contract: the stamp column still exists';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_job_material_lines_po_attached') THEN
  RAISE EXCEPTION 'dispatch line receipts rollback contract: the stamp trigger still exists';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('dispatch_line_po_attached_stamp', 'dispatch_line_receipt_guard')) THEN
  RAISE EXCEPTION 'dispatch line receipts rollback contract: a trigger function still exists';
 END IF;
 IF to_regclass('public.job_material_lines') IS NULL
    OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
         AND table_name = 'job_material_lines'
         AND column_name IN ('purchase_order_id', 'quantity', 'status')) <> 3
    OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
         AND table_name = 'purchase_orders' AND column_name = 'delivery_sighted_at') <> 1 THEN
  RAISE EXCEPTION 'dispatch line receipts rollback contract: the down removed something it does not own';
 END IF;
END $$;
