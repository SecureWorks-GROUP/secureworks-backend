-- Contract for 20261111160000_dispatch_v2_solarspan_as_bondor. Proves, against the real migration on the registered
-- stack:
--   1. the recognise-only column exists: text[], not null, empty by default;
--   2. in SecureWorks Group's organisation only, Bondor's entry carries wasales@solarspan.com.au as a recognise-only
--      address with its To and CC unchanged (Dispatch sends and copies nothing new), and the Solarspan entry is
--      retired with its addresses kept; the other organisation's two entries are untouched;
--   3. context_not_job_sender still names a Solarspan sender a supplier (through Bondor's recognise-only address,
--      now the Solarspan entry is retired), and a Bondor sender, and still names nobody for an unknown sender; it
--      stays service role only and its comment says what changed.
-- Fixture ids start 5b1a; everything written here is rolled back.

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '120s';

-- 1. The column.
DO $$
DECLARE c record;
BEGIN
  SELECT data_type, udt_name, is_nullable, column_default INTO c
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'dispatch_approved_supplier_emails'
    AND column_name = 'also_known_emails';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solarspan as Bondor: also_known_emails is missing';
  END IF;
  IF c.udt_name <> '_text' OR c.is_nullable <> 'NO' OR c.column_default IS NULL THEN
    RAISE EXCEPTION 'Solarspan as Bondor: also_known_emails is % %, nullable %, default %',
      c.data_type, c.udt_name, c.is_nullable, c.column_default;
  END IF;
  INSERT INTO public.dispatch_approved_supplier_emails (id, org_id, name, to_emails)
  VALUES ('5b1a0000-0000-4000-8000-000000000010', '5b1a0000-0000-4000-8000-000000000099', 'Default Check',
          ARRAY['x@default-check.example.test']);
  IF (SELECT also_known_emails FROM public.dispatch_approved_supplier_emails
      WHERE id = '5b1a0000-0000-4000-8000-000000000010') IS DISTINCT FROM ARRAY[]::text[] THEN
    RAISE EXCEPTION 'Solarspan as Bondor: a new entry does not start with no recognise-only addresses';
  END IF;
END $$;

-- 2. The data changes.
DO $$
DECLARE r record;
BEGIN
  SELECT to_emails, cc_emails, also_known_emails, active INTO r FROM public.dispatch_approved_supplier_emails
  WHERE id = '5b1a0000-0000-4000-8000-000000000001';
  IF r.also_known_emails IS DISTINCT FROM ARRAY['wasales@solarspan.com.au']::text[] THEN
    RAISE EXCEPTION 'Solarspan as Bondor: Bondor recognises %, not Solarspan''s address', r.also_known_emails;
  END IF;
  IF r.to_emails IS DISTINCT FROM ARRAY['wa@bondor.com.au']::text[] OR r.cc_emails IS DISTINCT FROM ARRAY[]::text[]
     OR NOT r.active THEN
    RAISE EXCEPTION 'Solarspan as Bondor: Bondor''s send addresses changed (to %, cc %, active %)',
      r.to_emails, r.cc_emails, r.active;
  END IF;
  SELECT to_emails, cc_emails, also_known_emails, active INTO r FROM public.dispatch_approved_supplier_emails
  WHERE id = '5b1a0000-0000-4000-8000-000000000002';
  IF r.active OR r.to_emails IS DISTINCT FROM ARRAY['wasales@solarspan.com.au']::text[]
     OR r.also_known_emails IS DISTINCT FROM ARRAY[]::text[] THEN
    RAISE EXCEPTION 'Solarspan as Bondor: the Solarspan entry is not retired as it was (active %, to %, also %)',
      r.active, r.to_emails, r.also_known_emails;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.dispatch_approved_supplier_emails
    WHERE id IN ('5b1a0000-0000-4000-8000-000000000003', '5b1a0000-0000-4000-8000-000000000004')
      AND (NOT active OR cardinality(also_known_emails) > 0)
  ) THEN
    RAISE EXCEPTION 'Solarspan as Bondor: another organisation''s entry was changed';
  END IF;
END $$;

-- 3. context_not_job_sender.
DO $$
DECLARE r record; got text; bad text[] := '{}';
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('a Solarspan sender', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"Sales <wasales@solarspan.com.au>","subject":"Order received"}}', 'supplier_no_ref'),
    ('another Solarspan address', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"accounts@solarspan.com.au","subject":"Statement"}}', 'supplier_no_ref'),
    ('a Bondor sender', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"natalia.kuschell@bondor.com.au","subject":"Bondor #1465465"}}', 'supplier_no_ref'),
    ('an unknown sender', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"new.person@gmail.com","subject":"Patio quote"}}', NULL)
  ) AS f(label, row_json, expected) LOOP
    got := public.context_not_job_sender(jsonb_populate_record(NULL::public.business_events, r.row_json::jsonb))->>'reason';
    IF got IS DISTINCT FROM r.expected THEN
      bad := bad || format('%s: %s, expected %s', r.label, coalesce(got, 'null'), coalesce(r.expected, 'null'));
    END IF;
  END LOOP;
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'Solarspan as Bondor: %', array_to_string(bad, '; ');
  END IF;
  IF has_function_privilege('anon', 'public.context_not_job_sender(public.business_events)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.context_not_job_sender(public.business_events)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.context_not_job_sender(public.business_events)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Solarspan as Bondor: context_not_job_sender grants changed';
  END IF;
  IF position('(20261111160000)' IN coalesce(obj_description(
       'public.context_not_job_sender(public.business_events)'::regprocedure, 'pg_proc'), '')) = 0 THEN
    RAISE EXCEPTION 'Solarspan as Bondor: context_not_job_sender''s comment does not say what changed';
  END IF;
END $$;

ROLLBACK;
