-- Down for 20261020150000_dispatch_line_receipts. Roll ops-api back first: the deployed
-- dispatch_delivery_record_receipt / _void_receipt actions, the dispatch_materials read, every
-- Dispatch write's counts and the pipeline&dispatch=1 list name this table and the stamp column.
-- Drops the receipts table, its guard, the line stamp trigger and the stamp column. Every receipt
-- (who recorded what, when, and every void) is lost with the table; lines, orders, sightings and
-- every slice 4 to 7 record stay. Lines then read Delivered by their order's sighting alone, as
-- slice 6 read them.
DROP TABLE IF EXISTS public.job_material_line_receipts;
DROP FUNCTION IF EXISTS public.dispatch_line_receipt_guard();
DROP TRIGGER IF EXISTS trg_job_material_lines_po_attached ON public.job_material_lines;
DROP FUNCTION IF EXISTS public.dispatch_line_po_attached_stamp();
ALTER TABLE public.job_material_lines DROP COLUMN IF EXISTS purchase_order_attached_at;
