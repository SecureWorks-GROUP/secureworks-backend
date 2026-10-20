-- Down for 20261020150000_dispatch_line_receipts. Roll ops-api back first: the deployed
-- dispatch_delivery_record_receipt / _void_receipt actions, the dispatch_materials read, every
-- Dispatch write's counts and the pipeline&dispatch=1 list name this table and the stamp column.
-- Drops the receipts table, its guard, the line stamp trigger and the stamp column. Refuses while
-- any receipt row exists (voided ones included): receipts are append-only delivery evidence and the
-- stamp column cannot be rebuilt, so a re-apply would read lines added after a sighting as
-- Delivered again. Export the rows and decide before clearing them by hand. With no receipts,
-- lines, orders, sightings and every slice 4 to 7 record stay, and lines read Delivered by their
-- order's sighting alone, as slice 6 read them.
-- One transaction, so a refusal also stops the drops when run without ON_ERROR_STOP.
BEGIN;

DO $$
BEGIN
  -- Nested so the table is only read when it exists (PL/pgSQL plans the whole condition).
  IF to_regclass('public.job_material_line_receipts') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.job_material_line_receipts) THEN
      RAISE EXCEPTION 'dispatch line receipts down refused: job_material_line_receipts holds rows; export them and decide before rolling back';
    END IF;
  END IF;
END
$$;
DROP TABLE IF EXISTS public.job_material_line_receipts;
DROP FUNCTION IF EXISTS public.dispatch_line_receipt_guard();
DROP TRIGGER IF EXISTS trg_job_material_lines_po_attached ON public.job_material_lines;
DROP FUNCTION IF EXISTS public.dispatch_line_po_attached_stamp();
ALTER TABLE public.job_material_lines DROP COLUMN IF EXISTS purchase_order_attached_at;

COMMIT;
