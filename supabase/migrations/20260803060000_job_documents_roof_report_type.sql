-- job_documents.type: admit 'roof_report' so the own-letterhead roof report
-- can attach to its job.
--
-- Defect (gap G1, found 2026-08-03 on MLB-26267, first real end-to-end
-- attempt at the own-letterhead roof-report flow): ops-api
-- attachMakesafeDocument lists 'roof_report' in allowedTypes and carries an
-- explicit comment that it is DELIBERATELY exempt from the report-type gate
-- ("generating our own letterhead report is the whole point of the
-- roof-report flow"), but the job_documents_type_check CHECK constraint never
-- gained the value, so the attach insert 500s:
--
--   new row for relation "job_documents" violates check constraint
--   "job_documents_type_check"
--
-- The one code path purpose-built for own-letterhead roof reports has never
-- been able to write a row. It also cascades: sw_send_email refuses any PDF
-- attachment without an authoritative job_document_id, so the rendered report
-- could not be emailed at all.
--
-- DRIFT RECONCILIATION (verified against production, 2026-08-03)
-- --------------------------------------------------------------
-- The migration chain on main and the live constraint have drifted. This
-- migration REBUILDS the constraint to the verified live set PLUS
-- 'roof_report'; it does not blind-append, and it never narrows production.
-- The chain:
--
--   * 20250301000001_schema.sql created job_documents with an inline
--     five-value check (quote, material_order, work_order, sheets_order,
--     variation); Postgres auto-named it job_documents_type_check.
--   * 20260419000001_add_supplier_doc_types.sql -- the ONLY migration on
--     main that defines this constraint -- rebuilt it to sixteen values
--     (adding approval, site_photo, general, supplier_quote,
--     supplier_work_order, supplier_invoice, council_plans, engineering,
--     client_reference, asbestos, other).
--   * 'invoice', 'makesafe_report' and 'swms' are in the live constraint and
--     on live jobs but in NO migration on main: they were applied to
--     production by hand, then committed for history as
--     20260616000001_makesafe_doc_types.sql on the branch
--     chore/makesafe-doc-types-migration (commit 5f46edc, "chore: commit
--     already-applied makesafe doc-types migration for history") -- a branch
--     that was never merged to main.
--
-- The verified live definition (pg_get_constraintdef, 2026-08-03):
--
--   CHECK ((type = ANY (ARRAY['quote','material_order','work_order',
--     'sheets_order','variation','approval','site_photo','general',
--     'supplier_quote','supplier_work_order','supplier_invoice',
--     'council_plans','engineering','client_reference','asbestos','other',
--     'invoice','makesafe_report','swms'])))
--
-- Every value in that live set is preserved below; exactly one value is
-- added: 'roof_report'.
--
-- Zero-row-safe: no data is read or rewritten. Re-adding the constraint
-- re-validates existing rows, and every existing row passes because this
-- strictly widens the live definition.
--
-- Rollback twin:
-- supabase/rollbacks/20260803060000_job_documents_roof_report_type_down.sql
-- restores the verified live definition above byte-for-byte.

ALTER TABLE job_documents DROP CONSTRAINT IF EXISTS job_documents_type_check;

ALTER TABLE job_documents ADD CONSTRAINT job_documents_type_check
  CHECK (type IN (
    'quote', 'material_order', 'work_order', 'sheets_order', 'variation',
    'approval', 'site_photo', 'general', 'supplier_quote',
    'supplier_work_order', 'supplier_invoice',
    'council_plans', 'engineering', 'client_reference', 'asbestos', 'other',
    'invoice', 'makesafe_report', 'swms',
    'roof_report'
  ));
