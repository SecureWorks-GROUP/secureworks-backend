-- B3 builder reference link: the candidate read and the stored link time.
\set ON_ERROR_STOP on
BEGIN;
-- Fixed instants only (README rule 3).
INSERT INTO public.jobs (id, org_id, job_number, type, status, created_at, client_name, site_address, metadata) VALUES
 ('10000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'SWMS-261163', 'makesafe', 'processing', '2026-08-07T08:27:08Z', 'Customer A', '53 Example St, Falcon', '{"builder_po_number":"PO-58097","requesting_company":{"slug":"mlb"}}'),
 ('10000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'SWF-261360', 'fencing', 'archived', '2026-09-02T08:35:36Z', 'Customer A', '53 Example Street, Falcon WA 6210', '{"mlb_ref":"MLB-26303"}'),
 ('10000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'SWR-SITE', 'repair', 'scheduled', '2026-09-03T00:00:00Z', 'Customer A', '53 Example St', '{}'),
 ('10000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'SWR-LONGER', 'repair', 'scheduled', '2026-09-03T00:00:00Z', 'Customer B', '9 Other Rd', '{"mlb_ref":"MLB-263031"}'),
 ('10000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', 'SWR-ELSEWHERE', 'repair', 'scheduled', '2026-09-03T00:00:00Z', 'Customer A', '54 Example St', '{}'),
 ('10000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000002', 'SWR-OTHER-ORG', 'repair', 'scheduled', '2026-09-03T00:00:00Z', 'Customer A', '53 Example St', '{"mlb_ref":"MLB-26303"}');
INSERT INTO public.makesafe_job_details (job_id, external_ref, requesting_company_slug) VALUES
 ('10000000-0000-4000-8000-000000000001', 'MLB-26303', 'mlb');
INSERT INTO public.xero_invoices (id, org_id, xero_invoice_id, invoice_number, invoice_type, status, total, job_id, created_at) VALUES
 ('20000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'x-1', 'INV-1', 'ACCREC', 'PAID', 497.20, '10000000-0000-4000-8000-000000000001', '2026-08-10T00:00:00Z'),
 ('20000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'x-2', 'INV-2', 'ACCREC', 'VOIDED', 100, '10000000-0000-4000-8000-000000000001', '2026-08-11T00:00:00Z'),
 ('20000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'x-3', 'BILL-3', 'ACCPAY', 'PAID', 50, '10000000-0000-4000-8000-000000000001', '2026-08-12T00:00:00Z');

DO $c$
DECLARE r jsonb; nums text[];
BEGIN
  r := public.xero_builder_reference_candidates(ARRAY['26303', '58097']);
  SELECT array_agg(e->>'job_number' ORDER BY e->>'job_number') INTO nums FROM jsonb_array_elements(r) e;
  -- Reference: the card (claim and PO) and the fence job (mlb_ref). Site: the open job at 53 Example St.
  -- Not: a longer digit run, another site, another org.
  IF nums IS DISTINCT FROM ARRAY['SWF-261360', 'SWMS-261163', 'SWR-SITE'] THEN
    RAISE EXCEPTION 'candidates are %, expected SWF-261360, SWMS-261163, SWR-SITE', nums;
  END IF;
  IF (SELECT count(DISTINCT e->>'site_key') FROM jsonb_array_elements(r) e) <> 1
     OR (SELECT e->>'site_key' FROM jsonb_array_elements(r) e LIMIT 1) <> '53 example st' THEN
    RAISE EXCEPTION 'site keys are not the context placer''s key: %', r;
  END IF;
  IF (SELECT e->'refs'->>'details_external_ref' FROM jsonb_array_elements(r) e WHERE e->>'job_number' = 'SWMS-261163') <> 'MLB-26303'
     OR (SELECT e->>'builder' FROM jsonb_array_elements(r) e WHERE e->>'job_number' = 'SWMS-261163') <> 'mlb' THEN
    RAISE EXCEPTION 'the card''s own reference and builder are not returned: %', r;
  END IF;
  -- Only the job's issued customer invoices, never a voided one or a bill.
  IF (SELECT jsonb_agg(i->>'invoice_number') FROM jsonb_array_elements(r) e, jsonb_array_elements(e->'invoices') i WHERE e->>'job_number' = 'SWMS-261163') <> '["INV-1"]'::jsonb THEN
    RAISE EXCEPTION 'the card''s invoices are wrong: %', r;
  END IF;
  IF public.xero_builder_reference_candidates(ARRAY['1234', 'abcde', NULL]) <> '[]'::jsonb
     OR public.xero_builder_reference_candidates(NULL) <> '[]'::jsonb THEN
    RAISE EXCEPTION 'keys that are not 5 or more digits must find nothing';
  END IF;
  IF has_function_privilege('anon', 'public.xero_builder_reference_candidates(text[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.xero_builder_reference_candidates(text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'the candidate read must not be open to anon or authenticated';
  END IF;
END
$c$;

-- The stored link time: set by the trigger the first time job_id is set, never by a caller.
INSERT INTO public.xero_invoices (id, org_id, xero_invoice_id, invoice_number, invoice_type, status, job_id, job_linked_at) VALUES
 ('30000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'y-1', 'INV-Y1', 'ACCREC', 'AUTHORISED', '10000000-0000-4000-8000-000000000002', '2000-01-01'),
 ('30000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'y-2', 'INV-Y2', 'ACCREC', 'AUTHORISED', NULL, '2000-01-01');
DO $s$
DECLARE a timestamptz; b timestamptz;
BEGIN
  SELECT job_linked_at INTO a FROM public.xero_invoices WHERE id = '30000000-0000-4000-8000-000000000001';
  SELECT job_linked_at INTO b FROM public.xero_invoices WHERE id = '30000000-0000-4000-8000-000000000002';
  IF a IS DISTINCT FROM now() OR b IS NOT NULL THEN
    RAISE EXCEPTION 'insert: linked row stamped % (want now), unlinked row % (want null)', a, b;
  END IF;
  UPDATE public.xero_invoices SET job_linked_at = '2000-01-01' WHERE id = '30000000-0000-4000-8000-000000000002';
  IF (SELECT job_linked_at FROM public.xero_invoices WHERE id = '30000000-0000-4000-8000-000000000002') IS NOT NULL THEN
    RAISE EXCEPTION 'a caller wrote the stamp';
  END IF;
  UPDATE public.xero_invoices SET job_id = '10000000-0000-4000-8000-000000000003' WHERE id = '30000000-0000-4000-8000-000000000002';
  IF (SELECT job_linked_at FROM public.xero_invoices WHERE id = '30000000-0000-4000-8000-000000000002') IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'the first link was not stamped';
  END IF;
  -- Rows linked before the column existed keep no stamp when the sync rewrites the same job.
  ALTER TABLE public.xero_invoices DISABLE TRIGGER xero_invoices_job_linked_at;
  UPDATE public.xero_invoices SET job_linked_at = NULL WHERE id = '30000000-0000-4000-8000-000000000001';
  ALTER TABLE public.xero_invoices ENABLE TRIGGER xero_invoices_job_linked_at;
  UPDATE public.xero_invoices SET job_id = job_id WHERE id = '30000000-0000-4000-8000-000000000001';
  IF (SELECT job_linked_at FROM public.xero_invoices WHERE id = '30000000-0000-4000-8000-000000000001') IS NOT NULL THEN
    RAISE EXCEPTION 'rewriting an existing link stamped it as new';
  END IF;
  -- A move or an unlink and relink keeps the first stamp.
  UPDATE public.xero_invoices SET job_id = '10000000-0000-4000-8000-000000000001' WHERE id = '30000000-0000-4000-8000-000000000002';
  UPDATE public.xero_invoices SET job_id = NULL WHERE id = '30000000-0000-4000-8000-000000000002';
  UPDATE public.xero_invoices SET job_id = '10000000-0000-4000-8000-000000000003' WHERE id = '30000000-0000-4000-8000-000000000002';
  IF (SELECT job_linked_at FROM public.xero_invoices WHERE id = '30000000-0000-4000-8000-000000000002') IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'a move or relink changed the first stamp';
  END IF;
END
$s$;
ROLLBACK;
