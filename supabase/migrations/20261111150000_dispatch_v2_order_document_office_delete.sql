-- Dispatch v2 (Shaun, 11 Nov 2026): the office can delete a supplier PDF that
-- Dispatch saved to a job.
--
-- The bug: deleting a job_documents row that Dispatch saved failed with
-- "violates check constraint dispatch_v2_order_documents_saved_has_document".
-- The foreign key from dispatch_v2_order_documents.job_document_id is
-- ON DELETE SET NULL, but that check required every 'saved' row to keep its
-- job_document_id, so the whole delete was refused.
--
-- The fix: a 'saved' row only needs its saved_at. When the office deletes the
-- file, the foreign key clears job_document_id and the row stays 'saved'. The
-- row is the once-only memory for that file on that job (unique job_id,
-- content_sha256), and ops-api skips every file whose row is 'saved', so a
-- deleted file is never saved back by the five-minute sweep. No code change.
--
-- So: state 'saved' with job_document_id NULL means "saved once, then deleted
-- from the job by the office".
--
-- No job, job document, supplier, Xero, GHL or send is touched. No backfill.
-- Rollback: supabase/rollbacks/20261111150000_dispatch_v2_order_document_office_delete_down.sql.

ALTER TABLE public.dispatch_v2_order_documents
  DROP CONSTRAINT IF EXISTS dispatch_v2_order_documents_saved_has_document,
  DROP CONSTRAINT IF EXISTS dispatch_v2_order_documents_saved_has_time,
  ADD CONSTRAINT dispatch_v2_order_documents_saved_has_time CHECK (
    state <> 'saved' OR saved_at IS NOT NULL
  );

COMMENT ON COLUMN public.dispatch_v2_order_documents.job_document_id IS
  'The job_documents row this file was saved as. NULL on a saved row: the office deleted the file from the job; the row stays so the file is never saved again.';
