-- Rollback of 20261111150000_dispatch_v2_order_document_office_delete: put back
-- the original check (a saved row must keep its job document). NOT VALID, so
-- rows for files the office already deleted are kept as they are; deleting a
-- Dispatch-saved file is refused again after this rollback.
ALTER TABLE public.dispatch_v2_order_documents
  DROP CONSTRAINT IF EXISTS dispatch_v2_order_documents_saved_has_time,
  DROP CONSTRAINT IF EXISTS dispatch_v2_order_documents_saved_has_document,
  ADD CONSTRAINT dispatch_v2_order_documents_saved_has_document CHECK (
    state <> 'saved' OR (job_document_id IS NOT NULL AND saved_at IS NOT NULL)
  ) NOT VALID;

COMMENT ON COLUMN public.dispatch_v2_order_documents.job_document_id IS NULL;
