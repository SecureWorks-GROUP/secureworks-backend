BEGIN;
INSERT INTO public.jobs(id,org_id,type,status,job_number,xero_contact_id,pricing_json)
VALUES('66000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','patio','accepted','WS6-BILL-PIN','66000000-0000-4000-8000-000000000002','{}');
INSERT INTO public.job_documents(id,job_id,type,sent_at,accepted_at)
VALUES('66000000-0000-4000-8000-000000000003','66000000-0000-4000-8000-000000000001','quote',now(),now());
INSERT INTO public.quote_revisions(id,job_id,job_document_id,sent_at,version,released_via,totals_snapshot_json,pricing_snapshot_json)
VALUES('66000000-0000-4000-8000-000000000004','66000000-0000-4000-8000-000000000001','66000000-0000-4000-8000-000000000003',now(),1,'send-quote/send','{}','{"raw":{"billing_milestones":{"version":1},"payment_schedule":{"version":1,"payments":[{"id":"deposit","amount_inc_gst":0.01}]}}}');
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
UPDATE public.job_documents SET sent_at=now()+interval '1 second' WHERE id='66000000-0000-4000-8000-000000000003';
DO $$ BEGIN
 BEGIN
  UPDATE public.invoice_milestone_draft_claims SET state='dispatching' WHERE reference='WS6-CONTRACT-PIN' AND state='prepared';
  RAISE EXCEPTION 'Future document send admitted dispatch';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%accepted document changed%' THEN RAISE; END IF; END;
END $$;
UPDATE public.job_documents SET sent_at=now() WHERE id='66000000-0000-4000-8000-000000000003';
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
-- Exact acceptance receipt metadata cannot bind a different first payment or overwrite an identity.
INSERT INTO public.quote_invoice_deposit_receipts(org_id,job_id,quote_revision_id,accepted_document_id,provider_invoice_id,xero_contact_id,stage_id,amount_cents,reference)
VALUES('00000000-0000-0000-0000-000000000001','66000000-0000-4000-8000-000000000001','66000000-0000-4000-8000-000000000004','66000000-0000-4000-8000-000000000003','66000000-0000-4000-8000-000000000020','66000000-0000-4000-8000-000000000002','deposit',1,'Fixture accepted first payment');
DO $$ BEGIN
 IF has_table_privilege('authenticated','public.quote_invoice_deposit_receipts','SELECT') OR has_table_privilege('service_role','public.quote_invoice_deposit_receipts','UPDATE') THEN RAISE EXCEPTION 'Deposit receipt is mutable or browser-readable'; END IF;
 IF has_table_privilege('service_role','public.quote_invoice_deposit_receipts','DELETE') OR has_table_privilege('service_role','public.quote_invoice_billing_bindings','INSERT,UPDATE,DELETE') OR has_table_privilege('service_role','public.invoice_milestone_draft_claims','DELETE') THEN RAISE EXCEPTION 'Inherited ALL grants bypass invoice evidence retention'; END IF;
 BEGIN UPDATE public.quote_invoice_billing_bindings SET xero_contact_id='66000000-0000-4000-8000-000000000099' WHERE quote_revision_id='66000000-0000-4000-8000-000000000004'; RAISE EXCEPTION 'Payer binding mutated'; EXCEPTION WHEN raise_exception THEN IF SQLERRM='Payer binding mutated' THEN RAISE; END IF; END;
 BEGIN DELETE FROM public.quote_invoice_deposit_receipts WHERE provider_invoice_id='66000000-0000-4000-8000-000000000020'; RAISE EXCEPTION 'Deposit receipt erased'; EXCEPTION WHEN raise_exception THEN IF SQLERRM='Deposit receipt erased' THEN RAISE; END IF; END;
 BEGIN DELETE FROM public.invoice_milestone_draft_claims WHERE reference='WS6-CONTRACT-PIN'; RAISE EXCEPTION 'Claim erased for retry'; EXCEPTION WHEN raise_exception THEN IF SQLERRM='Claim erased for retry' THEN RAISE; END IF; END;

 BEGIN
 INSERT INTO public.quote_invoice_deposit_receipts(org_id,job_id,quote_revision_id,accepted_document_id,provider_invoice_id,xero_contact_id,stage_id,amount_cents,reference)
 VALUES('00000000-0000-0000-0000-000000000001','66000000-0000-4000-8000-000000000001','66000000-0000-4000-8000-000000000004','66000000-0000-4000-8000-000000000003','66000000-0000-4000-8000-000000000021','66000000-0000-4000-8000-000000000002','different-stage',1,'Fixture other payment');
 RAISE EXCEPTION 'Non-first-stage receipt admitted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='Non-first-stage receipt admitted' THEN RAISE; END IF; END;
END $$;
-- Same-document resend cannot borrow an earlier acceptance timestamp for deposit metadata.
UPDATE public.job_documents SET accepted_at=now()-interval '1 second' WHERE id='66000000-0000-4000-8000-000000000003';
DO $$ BEGIN
 BEGIN
 INSERT INTO public.quote_invoice_deposit_receipts(org_id,job_id,quote_revision_id,accepted_document_id,provider_invoice_id,xero_contact_id,stage_id,amount_cents,reference)
 VALUES('00000000-0000-0000-0000-000000000001','66000000-0000-4000-8000-000000000001','66000000-0000-4000-8000-000000000004','66000000-0000-4000-8000-000000000003','66000000-0000-4000-8000-000000000022','66000000-0000-4000-8000-000000000002','deposit',1,'Fixture earlier acceptance');
 RAISE EXCEPTION 'Receipt borrowed pre-send acceptance';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%exact released first-stage binding%' THEN RAISE; END IF; END;
END $$;
UPDATE public.job_documents SET accepted_at=now() WHERE id='66000000-0000-4000-8000-000000000003';
SELECT public.record_invoice_milestone_admission_hold(id,org_id,'existing_invoice_requires_review') FROM public.invoice_milestone_reviews WHERE job_id='66000000-0000-4000-8000-000000000001';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.invoice_milestone_reviews WHERE job_id='66000000-0000-4000-8000-000000000001' AND 'existing_invoice_requires_review'=ANY(hold_reasons)) THEN RAISE EXCEPTION 'Admission hold was not durable'; END IF;
END $$;
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
INSERT INTO public.quote_revisions(id,job_id,job_document_id,sent_at,version,released_via,totals_snapshot_json,pricing_snapshot_json)
VALUES('66000000-0000-4000-8000-000000000006','66000000-0000-4000-8000-000000000001','66000000-0000-4000-8000-000000000003',now(),2,'send-quote/send','{}','{"raw":{"billing_milestones":{"version":1}}}');
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.quote_invoice_billing_bindings WHERE quote_revision_id='66000000-0000-4000-8000-000000000006' AND state='held' AND hold_reason='billing_contact_override_requires_review') THEN RAISE EXCEPTION 'Bill-to ambiguity became authority'; END IF;
END $$;
UPDATE public.jobs SET pricing_json='{}' WHERE id='66000000-0000-4000-8000-000000000001';
INSERT INTO public.quote_revisions(id,job_id,job_document_id,sent_at,version,released_via,totals_snapshot_json,pricing_snapshot_json)
VALUES('66000000-0000-4000-8000-000000000007','66000000-0000-4000-8000-000000000001','66000000-0000-4000-8000-000000000003',now(),3,'send-quote/send','{}','{"raw":{"billing_milestones":{"version":1}}}');
UPDATE public.job_documents SET quote_revision_id='66000000-0000-4000-8000-000000000007' WHERE id='66000000-0000-4000-8000-000000000003';
DO $$ BEGIN
 BEGIN
  INSERT INTO public.invoice_milestone_draft_claims(org_id,job_id,quote_revision_id,review_id,stage_id,xero_contact_id,amount_cents,currency,label,printed_terms,due_date,reference,payload_hash,state)
  SELECT org_id,job_id,'66000000-0000-4000-8000-000000000007',id,'changed-stage-id','66000000-0000-4000-8000-000000000099',1,'AUD','Fixture replacement','Fixture terms','2026-11-06','WS6-CONTRACT-REPLACEMENT',repeat('f',64),'prepared' FROM public.invoice_milestone_reviews WHERE job_id='66000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'Replacement revision acquired duplicate economic billing';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%earlier accepted revision%' THEN RAISE; END IF; END;
END $$;
-- Historical acceptance without a milestone claim is still unsupported replacement authority.
INSERT INTO public.job_documents(id,job_id,type,sent_at,accepted_at,superseded_at,quote_revision_id)
VALUES('66000000-0000-4000-8000-000000000030','66000000-0000-4000-8000-000000000001','quote',now(),now(),now(),'66000000-0000-4000-8000-000000000007');
DO $$ BEGIN
 BEGIN
  INSERT INTO public.invoice_milestone_draft_claims(org_id,job_id,quote_revision_id,review_id,stage_id,xero_contact_id,amount_cents,currency,label,printed_terms,due_date,reference,payload_hash,state)
  SELECT org_id,job_id,accepted_quote_revision_id,id,'historical-check','66000000-0000-4000-8000-000000000002',1,'AUD','Fixture stage','Fixture terms','2026-11-06','WS6-CONTRACT-HISTORY',repeat('e',64),'prepared' FROM public.invoice_milestone_reviews WHERE job_id='66000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'Historical acceptance without a claim admitted billing';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%Accepted replacement quote%' THEN RAISE; END IF; END;
END $$;
-- Restore this fixture's historical marker for the independent concurrent same-revision scenario.
UPDATE public.job_documents SET accepted_at=NULL WHERE id='66000000-0000-4000-8000-000000000030';
-- Restore document context for the independent concurrent same-revision scenario.
UPDATE public.job_documents SET quote_revision_id='66000000-0000-4000-8000-000000000004' WHERE id='66000000-0000-4000-8000-000000000003';
COMMIT;
