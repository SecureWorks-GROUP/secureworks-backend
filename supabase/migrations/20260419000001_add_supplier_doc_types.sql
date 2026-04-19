-- Extend job_documents.type to include supplier_work_order + supplier_invoice.
-- Added so monitor-inbox and ops.html can classify inbound supplier PDFs correctly.
-- Without this, INSERTs silently fail against the existing CHECK constraint and
-- supplier PDFs end up in storage but never in job_documents (silent drop).

ALTER TABLE job_documents DROP CONSTRAINT IF EXISTS job_documents_type_check;

ALTER TABLE job_documents ADD CONSTRAINT job_documents_type_check
  CHECK (type IN (
    'quote', 'material_order', 'work_order', 'sheets_order', 'variation',
    'approval', 'site_photo', 'general', 'supplier_quote',
    'supplier_work_order', 'supplier_invoice',
    'council_plans', 'engineering', 'client_reference', 'asbestos', 'other'
  ));
