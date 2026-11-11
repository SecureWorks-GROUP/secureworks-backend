-- Prerequisites for 20261111150000_dispatch_v2_order_document_office_delete:
-- dispatch_v2_order_documents (stood in by the 20261105190000 setup) gets the
-- real foreign key to job_documents, ON DELETE SET NULL, as
-- 20261105161000_dispatch_v2_order_documents made it. jobs and job_documents
-- already exist in the registered stack.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dispatch_v2_order_documents_job_document_id_fkey'
  ) THEN
    ALTER TABLE public.dispatch_v2_order_documents
      ADD CONSTRAINT dispatch_v2_order_documents_job_document_id_fkey
      FOREIGN KEY (job_document_id) REFERENCES public.job_documents(id) ON DELETE SET NULL;
  END IF;
END $$;
