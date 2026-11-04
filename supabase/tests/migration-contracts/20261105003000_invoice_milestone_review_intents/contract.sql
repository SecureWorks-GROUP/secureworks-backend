BEGIN;
INSERT INTO public.jobs(id, org_id, type, status, job_number) VALUES
  ('11000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'patio', 'accepted', 'WS6-REVIEW-ONE'),
  ('11000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'WS6-REVIEW-TWO'),
  ('11000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'repair', 'accepted', 'WS6-REVIEW-OTHER');
INSERT INTO public.job_documents(id, job_id, type, sent_at, accepted_at, job_contact_id) VALUES
  ('22000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'quote', '2026-11-01', '2026-11-02', NULL),
  ('22000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000001', 'quote', '2026-11-01', '2026-11-02', NULL),
  ('22000000-0000-4000-8000-000000000003', '11000000-0000-4000-8000-000000000001', 'quote', '2026-11-01', NULL, NULL);
-- Newer documents bind an exact released row. Never use a later/unrelated row.
INSERT INTO public.quote_revisions(id, job_id, job_document_id, version, totals_snapshot_json, released_via, sent_at) VALUES
  ('33000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 1, '{}', 'send-quote/send', '2026-11-01'),
  ('33000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 2, '{}', 'send-quote/send', '2026-11-02');
UPDATE public.job_documents SET quote_revision_id = '33000000-0000-4000-8000-000000000001'
  WHERE id IN ('22000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000002');
UPDATE public.jobs SET status = 'scheduled' WHERE id::text LIKE '11000000-%';
DO $$ BEGIN
  IF (SELECT count(*) FROM public.invoice_milestone_reviews WHERE job_id = '11000000-0000-4000-8000-000000000001') <> 2 THEN
    RAISE EXCEPTION 'one scheduled review per accepted document, excluding unaccepted'; END IF;
  IF NOT EXISTS (SELECT FROM public.invoice_milestone_reviews WHERE accepted_document_id = '22000000-0000-4000-8000-000000000001'
    AND accepted_quote_revision_id = '33000000-0000-4000-8000-000000000001'
    AND state = 'held' AND hold_reasons = ARRAY['machine_billing_terms_missing']) THEN
    RAISE EXCEPTION 'exact bound revision retained and held, never latest'; END IF;
  IF NOT EXISTS (SELECT FROM public.invoice_milestone_reviews WHERE accepted_document_id = '22000000-0000-4000-8000-000000000002'
    AND accepted_quote_revision_id IS NULL AND 'accepted_revision_binding_missing' = ANY(hold_reasons)) THEN
    RAISE EXCEPTION 'another document revision must not be adopted'; END IF;
  IF NOT EXISTS (SELECT FROM public.invoice_milestone_reviews WHERE job_id = '11000000-0000-4000-8000-000000000002'
    AND accepted_document_id IS NULL AND 'accepted_document_missing' = ANY(hold_reasons)) THEN
    RAISE EXCEPTION 'missing acceptance is visible and held'; END IF;
  IF EXISTS (SELECT FROM public.invoice_milestone_reviews WHERE job_id = '11000000-0000-4000-8000-000000000003') THEN
    RAISE EXCEPTION 'unrelated repair must be unchanged'; END IF;
END $$;
-- Same save, reset and re-schedule never create another review obligation.
UPDATE public.jobs SET status = 'scheduled' WHERE id = '11000000-0000-4000-8000-000000000001';
UPDATE public.jobs SET status = 'accepted' WHERE id = '11000000-0000-4000-8000-000000000001';
UPDATE public.jobs SET status = 'scheduled' WHERE id = '11000000-0000-4000-8000-000000000001';
INSERT INTO public.council_submissions(id, job_id, steps) VALUES
 ('44000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', '[{"step_id":"engineering","status":"pending"}]');
UPDATE public.council_submissions SET current_step_index = 1 WHERE id = '44000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  IF (SELECT count(*) FROM public.invoice_milestone_reviews) <> 3 THEN RAISE EXCEPTION 'repeat scheduling or workflow jump duplicated review'; END IF;
END $$;
UPDATE public.council_submissions SET steps = '[{"step_id":"engineering","status":"complete"}]'
  WHERE id = '44000000-0000-4000-8000-000000000001';
UPDATE public.council_submissions SET steps = '[{"step_id":"engineering","status":"complete"}]'
  WHERE id = '44000000-0000-4000-8000-000000000001';
UPDATE public.council_submissions SET steps = '[{"step_id":"engineering","status":"pending"}]'
  WHERE id = '44000000-0000-4000-8000-000000000001';
UPDATE public.council_submissions SET steps = '[{"step_id":"engineering","status":"complete"}]'
  WHERE id = '44000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  IF (SELECT count(*) FROM public.invoice_milestone_reviews) <> 5 THEN RAISE EXCEPTION 'council completion/recompletion must add exactly one review per accepted document'; END IF;
  IF EXISTS (SELECT FROM public.invoice_milestone_reviews WHERE state <> 'held') THEN RAISE EXCEPTION 'no review may become invoice authority'; END IF;
  IF has_table_privilege('anon', 'public.invoice_milestone_reviews', 'SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('authenticated', 'public.invoice_milestone_reviews', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'queue must not expose direct browser access'; END IF;
  IF has_function_privilege('authenticated', 'public.enqueue_invoice_milestone_review(uuid,text,text,jsonb)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.enqueue_invoice_milestone_review(uuid,text,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'browser must not invoke privileged capture'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.invoice_milestone_reviews'::regclass) THEN RAISE EXCEPTION 'RLS required'; END IF;
END $$;
-- First-party calendar creates scheduled assignments while jobs remains accepted/processing.
INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
 ('11000000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000001','patio','accepted','WS6-REVIEW-BOOKING'),
 ('11000000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000001','patio','accepted','WS6-REVIEW-FAILURE');
INSERT INTO public.job_assignments(id,job_id,scheduled_date,role,status,is_ghost,assignment_type) VALUES
 ('55000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000004','2026-11-06','observer','scheduled',false,'install'),
 ('55000000-0000-4000-8000-000000000002','11000000-0000-4000-8000-000000000004','2026-11-06','lead_installer','scheduled',true,'install'),
 ('55000000-0000-4000-8000-000000000003','11000000-0000-4000-8000-000000000004','2026-11-06','lead_installer','scheduled',false,'delivery'),
 ('55000000-0000-4000-8000-000000000004','11000000-0000-4000-8000-000000000004','2026-11-06','lead_installer','cancelled',false,'install');
DO $$ BEGIN
 IF EXISTS (SELECT FROM public.invoice_milestone_reviews WHERE job_id='11000000-0000-4000-8000-000000000004') THEN
  RAISE EXCEPTION 'watchers delivery and cancelled rows must not trigger'; END IF;
END $$;
INSERT INTO public.job_assignments(id,job_id,scheduled_date,role,status,is_ghost,assignment_type) VALUES
 ('55000000-0000-4000-8000-000000000005','11000000-0000-4000-8000-000000000004','2026-11-06','lead_installer','scheduled',false,'install'),
 ('55000000-0000-4000-8000-000000000006','11000000-0000-4000-8000-000000000004','2026-11-06','crew','scheduled',false,NULL);
UPDATE public.job_assignments SET scheduled_date='2026-11-07' WHERE job_id='11000000-0000-4000-8000-000000000004';
DO $$ BEGIN
 IF (SELECT count(*) FROM public.invoice_milestone_reviews WHERE job_id='11000000-0000-4000-8000-000000000004') <> 1 THEN
  RAISE EXCEPTION 'calendar booking must capture once across crew and reschedule'; END IF;
 IF (SELECT status FROM public.jobs WHERE id='11000000-0000-4000-8000-000000000004') <> 'accepted' THEN
  RAISE EXCEPTION 'capture must not move lifecycle'; END IF;
END $$;
-- A workflow jump may mark earlier steps complete but is not a milestone attestation.
UPDATE public.council_submissions SET steps='[{"step_id":"jumped","status":"complete","completion_source":"workflow_jump"}]', current_step_index=1 WHERE id='44000000-0000-4000-8000-000000000001';
DO $$ BEGIN
 IF EXISTS (SELECT FROM public.invoice_milestone_reviews WHERE milestone_key='council_step:jumped') THEN RAISE EXCEPTION 'workflow jump fabricated milestone'; END IF;
END $$;
SAVEPOINT explicit_attestation;
UPDATE public.council_submissions SET steps='[{"step_id":"jumped","status":"complete","completion_source":"explicit_status_update"}]' WHERE id='44000000-0000-4000-8000-000000000001';
DO $$ BEGIN
 IF (SELECT count(*) FROM public.invoice_milestone_reviews WHERE milestone_key='council_step:jumped') <> 2 THEN RAISE EXCEPTION 'later explicit completion must capture one held review per accepted document'; END IF;
END $$;
ROLLBACK TO SAVEPOINT explicit_attestation;
-- Malformed or unidentified workflow steps never become named billing evidence.
UPDATE public.council_submissions SET steps='[1,"x",{},{"status":"complete"}]' WHERE id='44000000-0000-4000-8000-000000000001';
UPDATE public.council_submissions SET steps='null' WHERE id='44000000-0000-4000-8000-000000000001';
DO $$ BEGIN
 IF (SELECT count(*) FROM public.invoice_milestone_reviews) <> 6 THEN RAISE EXCEPTION 'malformed council input fabricated review'; END IF;
END $$;
-- Do not acknowledge a source write if its review would be lost.
ALTER TABLE public.invoice_milestone_reviews ADD CONSTRAINT injected_capture_failure
 CHECK (job_id <> '11000000-0000-4000-8000-000000000005') NOT VALID;
INSERT INTO public.council_submissions(id,job_id,steps) VALUES
 ('44000000-0000-4000-8000-000000000005','11000000-0000-4000-8000-000000000005','[{"step_id":"engineering","status":"pending"}]');
DO $$ BEGIN
 BEGIN
  UPDATE public.jobs SET status='scheduled' WHERE id='11000000-0000-4000-8000-000000000005';
  RAISE EXCEPTION 'status capture failure was swallowed';
 EXCEPTION WHEN check_violation THEN NULL; END;
 IF (SELECT status FROM public.jobs WHERE id='11000000-0000-4000-8000-000000000005') <> 'accepted' THEN RAISE EXCEPTION 'failed status capture committed'; END IF;
 BEGIN
  INSERT INTO public.job_assignments(id,job_id,scheduled_date,role,status,assignment_type)
   VALUES ('55000000-0000-4000-8000-000000000009','11000000-0000-4000-8000-000000000005','2026-11-06','crew','scheduled','install');
  RAISE EXCEPTION 'assignment capture failure was swallowed';
 EXCEPTION WHEN check_violation THEN NULL; END;
 IF EXISTS (SELECT FROM public.job_assignments WHERE id='55000000-0000-4000-8000-000000000009') THEN RAISE EXCEPTION 'failed assignment capture committed'; END IF;
 BEGIN
  UPDATE public.council_submissions SET steps='[{"step_id":"engineering","status":"complete"}]' WHERE id='44000000-0000-4000-8000-000000000005';
  RAISE EXCEPTION 'council capture failure was swallowed';
 EXCEPTION WHEN check_violation THEN NULL; END;
 IF (SELECT steps->0->>'status' FROM public.council_submissions WHERE id='44000000-0000-4000-8000-000000000005') <> 'pending' THEN RAISE EXCEPTION 'failed council capture committed'; END IF;
 IF EXISTS (SELECT FROM public.invoice_milestone_reviews WHERE job_id='11000000-0000-4000-8000-000000000005') THEN RAISE EXCEPTION 'failed capture left partial reviews'; END IF;
END $$;
ALTER TABLE public.invoice_milestone_reviews DROP CONSTRAINT injected_capture_failure;
ROLLBACK;
