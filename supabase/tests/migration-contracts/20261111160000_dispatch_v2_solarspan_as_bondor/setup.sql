-- Prerequisites for 20261111160000_dispatch_v2_solarspan_as_bondor (Shaun, 11 Nov 2026: an order emailed to
-- Solarspan is a Bondor order).
-- The registered stack already supplies dispatch_approved_supplier_emails (the 20261104102000 stand-in, production
-- column names and types) and context_not_job_sender (20261104102000 itself). Nothing an earlier registered case
-- created is changed here.
-- The rows the migration's one-off data changes match, as they stand in production on 11 Nov 2026 (Bondor To
-- wa@bondor.com.au, no CC; Solarspan To wasales@solarspan.com.au, no CC; both active), plus the same two names in
-- another organisation, which the migration must leave alone. Every fixture id starts 5b1a (unique in this shared
-- database). The other organisation's addresses are example.test ones, so they never name solarspan.com.au.

DO $$
BEGIN
  IF to_regclass('public.dispatch_approved_supplier_emails') IS NULL
     OR to_regprocedure('public.context_not_job_sender(public.business_events)') IS NULL THEN
    RAISE EXCEPTION 'Solarspan as Bondor prerequisites missing: the approved list or context_not_job_sender';
  END IF;
END $$;

INSERT INTO public.dispatch_approved_supplier_emails (id, org_id, name, used_for, to_emails, cc_emails, active) VALUES
  ('5b1a0000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'Bondor', 'patio',
   ARRAY['wa@bondor.com.au'], ARRAY[]::text[], true),
  ('5b1a0000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'Solarspan', 'patio',
   ARRAY['wasales@solarspan.com.au'], ARRAY[]::text[], true),
  ('5b1a0000-0000-4000-8000-000000000003', '5b1a0000-0000-4000-8000-000000000099', 'Bondor', 'patio',
   ARRAY['orders@bondor-other.example.test'], ARRAY[]::text[], true),
  ('5b1a0000-0000-4000-8000-000000000004', '5b1a0000-0000-4000-8000-000000000099', 'Solarspan', 'patio',
   ARRAY['orders@solarspan-other.example.test'], ARRAY[]::text[], true)
ON CONFLICT (id) DO NOTHING;
