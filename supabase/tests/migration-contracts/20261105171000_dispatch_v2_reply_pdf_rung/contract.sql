-- Tweak 2 piece 2 (5 Nov 2026): a supplier email matched by the job number in its stored PDF can be saved with
-- the rung 'pdf_job_number'; every older rung still saves and an unknown one is still refused. Writes rolled back.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  r text;
BEGIN
  -- 1. The new rung saves.
  INSERT INTO public.dispatch_v2_supplier_emails (org_id, state, rung, job_id)
  VALUES (org, 'matched', 'pdf_job_number', 'f3000000-0000-4000-8000-000000000001');
  -- 2. Every older rung, and none, still save.
  FOREACH r IN ARRAY ARRAY['thread', 'job_number', 'supplier_ref', 'best_guess', 'manual'] LOOP
    INSERT INTO public.dispatch_v2_supplier_emails (org_id, state, rung) VALUES (org, 'matched', r);
  END LOOP;
  INSERT INTO public.dispatch_v2_supplier_emails (org_id, state, rung) VALUES (org, 'unmatched', NULL);
  -- 3. A rung nobody wrote is still refused.
  BEGIN
    INSERT INTO public.dispatch_v2_supplier_emails (org_id, state, rung) VALUES (org, 'matched', 'pdf_guess');
    RAISE EXCEPTION 'contract 3: an unknown rung saved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
