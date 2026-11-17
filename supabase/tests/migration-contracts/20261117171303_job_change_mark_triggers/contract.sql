-- Stand the historical mark/build contract back up; the successor has its own proofs.
SELECT to_regclass('public.job_change_marks_base') IS NOT NULL AS queue_safety_live \gset
\if :queue_safety_live
\ir ../../../rollbacks/20261117172503_job_pages_queue_safety_down.sql
\endif
-- P0-02.2: observable changes and housekeeping writes, rolled back.
BEGIN;
SELECT public.job_change_mark_triggers_install();
SELECT public.job_change_mark_triggers_install();
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
INSERT INTO public.jobs (id, org_id, type, status, job_number) VALUES
 ('00000000-0000-4000-8000-000000000412','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-412'),
 ('00000000-0000-4000-8000-000000000413','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-413');
INSERT INTO public.xero_invoices (id, job_id, org_id, xero_invoice_id, invoice_type, status)
VALUES ('00000000-0000-4000-8001-000000000412','00000000-0000-4000-8000-000000000412',
 '00000000-0000-0000-0000-000000000001','ZZTEST-412','ACCREC','DRAFT');
INSERT INTO public.job_assignments (id, job_id)
VALUES ('00000000-0000-4000-8002-000000000412','00000000-0000-4000-8000-000000000412');
INSERT INTO public.job_documents (id, job_id, type, file_name)
VALUES ('00000000-0000-4000-8003-000000000412','00000000-0000-4000-8000-000000000412','other','ZZTEST-412.pdf');
DELETE FROM public.job_change_marks WHERE job_id IN
 ('00000000-0000-4000-8000-000000000412','00000000-0000-4000-8000-000000000413');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, payload, metadata)
VALUES ('00000000-0000-4000-8004-000000000412','00000000-0000-4000-8000-000000000412',
 'note','contract','note','{}','{}');
DO $c$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.job_change_marks
  WHERE job_id='00000000-0000-4000-8000-000000000412' AND 'message'=ANY(sources))
  OR EXISTS (SELECT 1 FROM public.job_change_marks WHERE job_id='00000000-0000-4000-8000-000000000413') THEN
  RAISE EXCEPTION 'job mark triggers: message must mark only its job';
 END IF;
END $c$;
CREATE TEMP TABLE mark_before ON COMMIT DROP AS
 SELECT last_marked_at FROM public.job_change_marks WHERE job_id='00000000-0000-4000-8000-000000000412';
UPDATE public.xero_invoices SET updated_at=now() WHERE id='00000000-0000-4000-8001-000000000412';
DO $c$
BEGIN
 IF (SELECT last_marked_at FROM public.job_change_marks WHERE job_id='00000000-0000-4000-8000-000000000412')
  IS DISTINCT FROM (SELECT last_marked_at FROM mark_before) THEN
  RAISE EXCEPTION 'job mark triggers: housekeeping moved the mark';
 END IF;
END $c$;
UPDATE public.xero_invoices SET status='PAID' WHERE id='00000000-0000-4000-8001-000000000412';
DO $c$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.job_change_marks
  WHERE job_id='00000000-0000-4000-8000-000000000412' AND 'payment'=ANY(sources)) THEN
  RAISE EXCEPTION 'job mark triggers: paid status must mark payment';
 END IF;
END $c$;
DELETE FROM public.job_change_marks WHERE job_id IN
 ('00000000-0000-4000-8000-000000000412','00000000-0000-4000-8000-000000000413');
UPDATE public.job_assignments SET job_id='00000000-0000-4000-8000-000000000413'
 WHERE id='00000000-0000-4000-8002-000000000412';
DO $c$
BEGIN
 IF (SELECT count(*) FROM public.job_change_marks WHERE job_id IN
  ('00000000-0000-4000-8000-000000000412','00000000-0000-4000-8000-000000000413')
  AND 'booking'=ANY(sources)) <> 2 THEN
  RAISE EXCEPTION 'job mark triggers: move must mark both jobs';
 END IF;
END $c$;
DELETE FROM public.job_change_marks WHERE job_id='00000000-0000-4000-8000-000000000412';
DELETE FROM public.job_documents WHERE id='00000000-0000-4000-8003-000000000412';
DO $c$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.job_change_marks
  WHERE job_id='00000000-0000-4000-8000-000000000412' AND 'document'=ANY(sources)) THEN
  RAISE EXCEPTION 'job mark triggers: document delete must mark job';
 END IF;
END $c$;
ROLLBACK;

-- Restore the successor for the remaining registered cases.
\ir ../../../migrations/20261117172503_job_pages_queue_safety.sql
