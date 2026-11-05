-- Down for 20261105190000_dispatch_v2_order_photo_documents.
--
-- Puts the two checks back to what 20261105161000 made: source is
-- 'supplier_reply' or 'order_sheet', and kind has no 'order_photo'.
--
-- The old checks cannot hold while any order_photo memory row exists, so
-- those rows are removed first. Only the once-only memory goes: the photos
-- already saved to jobs stay on the jobs (job_documents and the files in
-- job-documents are not touched). Roll back the ops-api change as well, or
-- the next confirmed order will try to save its photos again and be refused
-- by the old check (logged, nothing saved).

DELETE FROM public.dispatch_v2_order_documents
WHERE source = 'order_photo' OR kind = 'order_photo';

ALTER TABLE public.dispatch_v2_order_documents
  DROP CONSTRAINT IF EXISTS dispatch_v2_order_documents_source_valid,
  ADD CONSTRAINT dispatch_v2_order_documents_source_valid CHECK (
    source IN ('supplier_reply', 'order_sheet')
  );

ALTER TABLE public.dispatch_v2_order_documents
  DROP CONSTRAINT IF EXISTS dispatch_v2_order_documents_kind_valid,
  ADD CONSTRAINT dispatch_v2_order_documents_kind_valid CHECK (
    kind IN ('order_confirmation', 'invoice', 'quote', 'order_document', 'order_sheet')
  );

COMMENT ON COLUMN public.dispatch_v2_order_documents.source IS NULL;
