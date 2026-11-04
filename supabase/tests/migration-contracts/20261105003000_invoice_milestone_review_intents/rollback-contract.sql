BEGIN;
INSERT INTO public.jobs(id, org_id, type, status, job_number) VALUES
  ('11000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'patio', 'accepted', 'WS6-REVIEW-ROLLBACK');
INSERT INTO public.invoice_milestone_reviews(org_id,job_id,milestone_key,trigger_kind,hold_reasons,source)
  VALUES ('00000000-0000-0000-0000-000000000001','11000000-0000-4000-8000-000000000009','retained','scheduled',ARRAY['machine_billing_terms_missing'],'{}');
UPDATE public.jobs SET status = 'scheduled' WHERE id = '11000000-0000-4000-8000-000000000009';
DO $$ BEGIN
  IF (SELECT count(*) FROM public.invoice_milestone_reviews WHERE job_id = '11000000-0000-4000-8000-000000000009') <> 1 THEN
    RAISE EXCEPTION 'rollback must preserve rows and stop automatic capture'; END IF;
END $$;
ROLLBACK;
