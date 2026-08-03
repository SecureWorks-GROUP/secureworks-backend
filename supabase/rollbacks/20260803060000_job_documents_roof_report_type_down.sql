-- ROLLBACK of 20260803060000_job_documents_roof_report_type.sql
--
-- Restores job_documents_type_check EXACTLY as verified live on production
-- on 2026-08-03 (pg_get_constraintdef), i.e. WITHOUT 'roof_report'. The
-- definition below is byte-identical to that verified live definition.
--
-- READ THIS BEFORE RUNNING IT. Once the roof-report flow has attached any
-- 'roof_report' rows, this rollback FAILS on its own constraint
-- re-validation: the restored check rejects those rows. Delete or retype
-- every job_documents row with type = 'roof_report' first (each one is a
-- rendered own-letterhead roof report whose PDF also lives in the
-- job-documents storage bucket). While the fix is rolled back, the ops-api
-- attachMakesafeDocument path for type 'roof_report' 500s again at insert
-- time -- the original G1 defect.

ALTER TABLE job_documents DROP CONSTRAINT IF EXISTS job_documents_type_check;

ALTER TABLE job_documents ADD CONSTRAINT job_documents_type_check
  CHECK ((type = ANY (ARRAY['quote','material_order','work_order','sheets_order','variation','approval','site_photo','general','supplier_quote','supplier_work_order','supplier_invoice','council_plans','engineering','client_reference','asbestos','other','invoice','makesafe_report','swms'])));
