-- Extend job_documents.type to include the make-safe close-out document types
-- invoice, makesafe_report, swms.
--
-- Why: PR #174 added ops-api action `attach_makesafe_document`, which inserts
-- TYPED rows (type IN ('work_order','makesafe_report','invoice','swms')) so the
-- final report, authorised invoice and SWMS surface in Ops Dash / the trade app
-- under their own document type rather than a generic `general` bucket. The live
-- `job_documents_type_check` constraint (last set by
-- 20260419000001_add_supplier_doc_types.sql) does NOT permit those three values,
-- so every typed make-safe attach is rejected by Postgres at insert time
-- ("new row for relation \"job_documents\" violates check constraint
-- \"job_documents_type_check\"") and the M3 doc-attach feature + 11-job backfill
-- are blocked.
--
-- This migration preserves EVERY existing allowed value and adds exactly three:
-- 'invoice', 'makesafe_report', 'swms'. No existing rows are modified; widening a
-- CHECK constraint cannot invalidate rows that already passed the narrower one.

ALTER TABLE job_documents DROP CONSTRAINT IF EXISTS job_documents_type_check;

ALTER TABLE job_documents ADD CONSTRAINT job_documents_type_check
  CHECK (type IN (
    'quote', 'material_order', 'work_order', 'sheets_order', 'variation',
    'approval', 'site_photo', 'general', 'supplier_quote',
    'supplier_work_order', 'supplier_invoice',
    'council_plans', 'engineering', 'client_reference', 'asbestos', 'other',
    'invoice', 'makesafe_report', 'swms'
  ));
