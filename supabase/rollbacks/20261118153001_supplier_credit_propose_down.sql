SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP FUNCTION IF EXISTS public.supplier_credit_record_proposal(
  uuid, uuid, text, text, text, text, text, date, numeric, numeric, text, text, uuid, jsonb, jsonb, jsonb
);
DROP FUNCTION IF EXISTS public.supplier_credit_matching_bills(uuid, text);
DROP FUNCTION IF EXISTS public.supplier_credit_candidate_attachments(uuid, timestamptz, integer, uuid[]);

DROP INDEX IF EXISTS public.xero_invoices_accpay_org_lower_number_idx;
DROP INDEX IF EXISTS public.supplier_credit_drafts_org_source_attachment_idx;
DROP INDEX IF EXISTS public.context_email_attachments_stored_pdf_created_idx;
