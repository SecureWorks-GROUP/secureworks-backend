BEGIN;
INSERT INTO public.jobs(id,org_id,type,status,job_number,xero_contact_id,pricing_json)
VALUES('66000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','patio','accepted','WS6-BILL-PIN','66000000-0000-4000-8000-000000000002','{}');
INSERT INTO public.job_documents(id,job_id,type,sent_at,accepted_at)
VALUES('66000000-0000-4000-8000-000000000003','66000000-0000-4000-8000-000000000001','quote',now(),now());
INSERT INTO public.quote_revisions(id,job_id,job_document_id,sent_at,version,released_via,pricing_snapshot_json)
VALUES('66000000-0000-4000-8000-000000000004','66000000-0000-4000-8000-000000000001','66000000-0000-4000-8000-000000000003',now(),1,'send-quote/send','{"raw":{"billing_milestones":{"version":1}}}');
UPDATE public.job_documents SET quote_revision_id='66000000-0000-4000-8000-000000000004' WHERE id='66000000-0000-4000-8000-000000000003';
UPDATE public.jobs SET xero_contact_id='66000000-0000-4000-8000-000000000099',status='scheduled' WHERE id='66000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.quote_invoice_billing_bindings WHERE quote_revision_id='66000000-0000-4000-8000-000000000004' AND state='eligible' AND xero_contact_id='66000000-0000-4000-8000-000000000002') THEN RAISE EXCEPTION 'Released payer did not remain pinned'; END IF;
  IF has_table_privilege('authenticated','public.invoice_milestone_draft_claims','SELECT') OR has_table_privilege('authenticated','public.quote_invoice_billing_bindings','UPDATE') THEN RAISE EXCEPTION 'Browser can read money or alter payer binding'; END IF;
  IF has_table_privilege('service_role','public.quote_invoice_billing_bindings','UPDATE') THEN RAISE EXCEPTION 'Payer binding is mutable by service'; END IF;
END $$;
INSERT INTO public.invoice_milestone_draft_claims(org_id,job_id,quote_revision_id,review_id,stage_id,xero_contact_id,amount_cents,currency,label,printed_terms,due_date,reference,payload_hash,state)
SELECT org_id,job_id,accepted_quote_revision_id,id,'install','66000000-0000-4000-8000-000000000002',1,'AUD','Fixture stage','Fixture accepted terms','2026-11-06','WS6-CONTRACT-PIN',repeat('a',64),'prepared'
FROM public.invoice_milestone_reviews WHERE job_id='66000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  BEGIN
    UPDATE public.invoice_milestone_draft_claims SET amount_cents=2 WHERE reference='WS6-CONTRACT-PIN';
    RAISE EXCEPTION 'Commercial payload changed';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='Commercial payload changed' THEN RAISE; END IF; END;
END $$;
UPDATE public.invoice_milestone_draft_claims SET state='dispatching' WHERE reference='WS6-CONTRACT-PIN' AND state='prepared';
DO $$ BEGIN
  IF (SELECT count(*) FROM public.invoice_milestone_draft_claims WHERE reference='WS6-CONTRACT-PIN' AND state='dispatching')<>1 THEN RAISE EXCEPTION 'First dispatch missing'; END IF;
  UPDATE public.invoice_milestone_draft_claims SET state='dispatching' WHERE reference='WS6-CONTRACT-PIN' AND state='prepared';
  IF FOUND THEN RAISE EXCEPTION 'Second dispatch acquired same claim'; END IF;
END $$;
UPDATE public.invoice_milestone_draft_claims SET state='unknown',provider_invoice_id='66000000-0000-4000-8000-000000000005' WHERE reference='WS6-CONTRACT-PIN';
DO $$ BEGIN
  BEGIN
    UPDATE public.invoice_milestone_draft_claims SET state='prepared' WHERE reference='WS6-CONTRACT-PIN';
    RAISE EXCEPTION 'Unknown dispatch was reset';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='Unknown dispatch was reset' THEN RAISE; END IF; END;
  BEGIN
    UPDATE public.invoice_milestone_draft_claims SET provider_invoice_id='66000000-0000-4000-8000-000000000099' WHERE reference='WS6-CONTRACT-PIN';
    RAISE EXCEPTION 'Provider id replaced';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='Provider id replaced' THEN RAISE; END IF; END;
END $$;
UPDATE public.invoice_milestone_draft_claims SET state='draft_confirmed' WHERE reference='WS6-CONTRACT-PIN';
-- A document superseded after preparation cannot acquire dispatch.
INSERT INTO public.invoice_milestone_draft_claims(org_id,job_id,quote_revision_id,review_id,stage_id,xero_contact_id,amount_cents,currency,label,printed_terms,due_date,reference,payload_hash,state)
SELECT org_id,job_id,accepted_quote_revision_id,id,'admission','66000000-0000-4000-8000-000000000002',1,'AUD','Fixture stage','Fixture accepted terms','2026-11-06','WS6-CONTRACT-ADMISSION',repeat('c',64),'prepared'
FROM public.invoice_milestone_reviews WHERE job_id='66000000-0000-4000-8000-000000000001';
UPDATE public.job_documents SET superseded_at=now() WHERE id='66000000-0000-4000-8000-000000000003';
DO $$ BEGIN
 BEGIN
  UPDATE public.invoice_milestone_draft_claims SET state='dispatching' WHERE reference='WS6-CONTRACT-ADMISSION';
  RAISE EXCEPTION 'Superseded document acquired dispatch';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='Superseded document acquired dispatch' THEN RAISE; END IF; END;
END $$;
UPDATE public.job_documents SET superseded_at=NULL WHERE id='66000000-0000-4000-8000-000000000003';
-- A second opt-in with mutable redirect cannot gain an eligible binding.
UPDATE public.jobs SET pricing_json='{"billing_contact":{"name":"Fixture alternate payer"}}' WHERE id='66000000-0000-4000-8000-000000000001';
INSERT INTO public.quote_revisions(id,job_id,job_document_id,sent_at,version,released_via,pricing_snapshot_json)
VALUES('66000000-0000-4000-8000-000000000006','66000000-0000-4000-8000-000000000001','66000000-0000-4000-8000-000000000003',now(),2,'send-quote/send','{"raw":{"billing_milestones":{"version":1}}}');
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.quote_invoice_billing_bindings WHERE quote_revision_id='66000000-0000-4000-8000-000000000006' AND state='held' AND hold_reason='billing_contact_override_requires_review') THEN RAISE EXCEPTION 'Bill-to ambiguity became authority'; END IF;
END $$;
COMMIT;
