BEGIN;
INSERT INTO public.jobs(id,org_id,type,status,job_number,xero_contact_id,pricing_json)
VALUES('77000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','patio','accepted','WS6-COUNCIL-PIN','77000000-0000-4000-8000-000000000002','{}');
INSERT INTO public.job_documents(id,job_id,type,sent_at,accepted_at)
VALUES('77000000-0000-4000-8000-000000000003','77000000-0000-4000-8000-000000000001','quote',now(),now());
INSERT INTO public.council_submissions(id,org_id,job_id,steps)
VALUES('77000000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000001','77000000-0000-4000-8000-000000000001','[{"step_id":"77000000-0000-4000-8000-000000000006","name":"Fixture council checkpoint","status":"pending"}]');
INSERT INTO public.quote_revisions(id,job_id,job_document_id,sent_at,version,released_via,pricing_snapshot_json)
VALUES('77000000-0000-4000-8000-000000000004','77000000-0000-4000-8000-000000000001','77000000-0000-4000-8000-000000000003',now(),1,'send-quote/send','{"raw":{"billing_milestones":{"version":1,"milestones":[{"id":"council","trigger":{"kind":"council_step_completed","submission_id":"77000000-0000-4000-8000-000000000005","step_id":"77000000-0000-4000-8000-000000000006","step_name":"Fixture council checkpoint"}}]}}}');
UPDATE public.job_documents SET quote_revision_id='77000000-0000-4000-8000-000000000004' WHERE id='77000000-0000-4000-8000-000000000003';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.quote_invoice_council_bindings WHERE quote_revision_id='77000000-0000-4000-8000-000000000004' AND state='eligible' AND step_id='77000000-0000-4000-8000-000000000006') THEN RAISE EXCEPTION 'Exact prequote council step not pinned'; END IF;
 IF has_table_privilege('authenticated','public.quote_invoice_council_bindings','SELECT') OR has_table_privilege('service_role','public.quote_invoice_council_bindings','UPDATE') THEN RAISE EXCEPTION 'Pinned council identity can be changed or read by browser'; END IF;
END $$;
UPDATE public.council_submissions SET steps='[{"step_id":"77000000-0000-4000-8000-000000000006","name":"Fixture council checkpoint","status":"complete","completion_source":"workflow_jump"}]' WHERE id='77000000-0000-4000-8000-000000000005';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.invoice_milestone_reviews WHERE job_id='77000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'Workflow jump minted a billing review'; END IF;
END $$;
UPDATE public.council_submissions SET steps='[{"step_id":"77000000-0000-4000-8000-000000000006","name":"Fixture council checkpoint","status":"complete","completion_source":"explicit_status_update"}]' WHERE id='77000000-0000-4000-8000-000000000005';
INSERT INTO public.invoice_milestone_draft_claims(org_id,job_id,quote_revision_id,review_id,stage_id,xero_contact_id,amount_cents,currency,label,printed_terms,due_date,reference,payload_hash,state)
SELECT org_id,job_id,accepted_quote_revision_id,id,'council','77000000-0000-4000-8000-000000000002',1,'AUD','Fixture council stage','Fixture accepted terms','2026-11-06','WS6-COUNCIL-CONTRACT',repeat('d',64),'prepared' FROM public.invoice_milestone_reviews WHERE job_id='77000000-0000-4000-8000-000000000001';
-- Recompletion cannot create another source identity or another dispatch right.
UPDATE public.council_submissions SET steps='[{"step_id":"77000000-0000-4000-8000-000000000006","name":"Fixture council checkpoint","status":"pending"}]' WHERE id='77000000-0000-4000-8000-000000000005';
DO $$ BEGIN
 BEGIN
  UPDATE public.invoice_milestone_draft_claims SET state='dispatching' WHERE reference='WS6-COUNCIL-CONTRACT' AND state='prepared';
  RAISE EXCEPTION 'Undone council step acquired billing dispatch';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='Undone council step acquired billing dispatch' THEN RAISE; END IF; END;
END $$;
UPDATE public.council_submissions SET steps='[{"step_id":"77000000-0000-4000-8000-000000000006","name":"Fixture council checkpoint","status":"complete","completion_source":"explicit_status_update"}]' WHERE id='77000000-0000-4000-8000-000000000005';
UPDATE public.invoice_milestone_draft_claims SET state='dispatching' WHERE reference='WS6-COUNCIL-CONTRACT' AND state='prepared';
DO $$ BEGIN
 IF (SELECT count(*) FROM public.invoice_milestone_reviews WHERE job_id='77000000-0000-4000-8000-000000000001')<>1 THEN RAISE EXCEPTION 'Council reset/recompletion duplicated billing context'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.invoice_milestone_draft_claims WHERE reference='WS6-COUNCIL-CONTRACT' AND state='dispatching') THEN RAISE EXCEPTION 'Explicit exact council completion did not admit dispatch'; END IF;
END $$;
COMMIT;
