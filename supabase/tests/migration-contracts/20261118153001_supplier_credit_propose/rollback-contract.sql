BEGIN;
DO $rollback$
/* block */ BEGIN
  IF to_regprocedure('public.supplier_credit_candidate_attachments(uuid,timestamptz,integer,uuid[])') IS NOT NULL
     OR to_regprocedure('public.supplier_credit_matching_bills(uuid,text)') IS NOT NULL
     OR to_regprocedure('public.supplier_credit_record_proposal(uuid,uuid,text,text,text,text,text,date,numeric,numeric,text,text,uuid,jsonb,jsonb,jsonb)') IS NOT NULL
     OR to_regclass('public.context_email_attachments_stored_pdf_created_idx') IS NOT NULL
     OR to_regclass('public.supplier_credit_drafts_org_source_attachment_idx') IS NOT NULL
     OR to_regclass('public.xero_invoices_accpay_org_lower_number_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'supplier_credit_propose_rollback_incomplete';
  END IF;
END $rollback$;
SELECT 'PASS P3-02.3 rollback: functions and indexes removed cleanly';
ROLLBACK;
