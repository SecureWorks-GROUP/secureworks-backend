-- Contract for 20261113150000_quote_option_acceptances.sql. Every fixture write is
-- inside a transaction that rolls back.

-- 1. Row-level security, exactly one service-role policy, no browser role can read or
-- write the record.
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.quote_option_acceptances'::regclass) THEN
    RAISE EXCEPTION 'quote options contract: row-level security is off';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'quote_option_acceptances') <> 1
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'quote_option_acceptances'
                 AND NOT (roles = ARRAY['service_role']::name[])) THEN
    RAISE EXCEPTION 'quote options contract: the record must carry exactly one service-role policy';
  END IF;
  IF has_table_privilege('anon', 'public.quote_option_acceptances', 'SELECT')
     OR has_table_privilege('authenticated', 'public.quote_option_acceptances', 'SELECT')
     OR has_table_privilege('anon', 'public.quote_option_acceptances', 'INSERT')
     OR has_table_privilege('authenticated', 'public.quote_option_acceptances', 'INSERT') THEN
    RAISE EXCEPTION 'quote options contract: a browser role can read or write the record';
  END IF;
END $$;

-- 2. One record per document, written once, money that adds up.
BEGIN;
INSERT INTO public.jobs (id, org_id, status, type, job_number)
VALUES ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-000000000001', 'accepted', 'patio', 'ZZTEST-F001');
INSERT INTO public.job_documents (id, job_id, type)
VALUES ('00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-00000000f001', 'quote'),
       ('00000000-0000-0000-0000-00000000f102', '00000000-0000-0000-0000-00000000f001', 'quote');
INSERT INTO public.quote_revisions (id, job_id, job_document_id, version, totals_snapshot_json, released_via, sent_at)
VALUES ('00000000-0000-0000-0000-00000000f201', '00000000-0000-0000-0000-00000000f001',
        '00000000-0000-0000-0000-00000000f101', 1, '{}'::jsonb, 'contract', now());
INSERT INTO public.quote_option_acceptances (
  job_id, job_document_id, quote_revision_id, accepted_via, offered, taken_option_ids,
  base_total_inc_gst, accepted_total_ex_gst, accepted_gst, accepted_total_inc_gst, accepted_deposit_inc_gst)
VALUES ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f101',
        '00000000-0000-0000-0000-00000000f201', 'public_link',
        '[{"id":"a","name":"Lights","sell_ex_gst":400,"gst":40,"sell_inc_gst":440,"goes":"supplier"}]'::jsonb,
        ARRAY['a'], 1100, 1400, 140, 1540, 770);
DO $$
DECLARE
  bad record;
BEGIN
  -- A second record for the same document is refused.
  BEGIN
    INSERT INTO public.quote_option_acceptances (
      job_id, job_document_id, quote_revision_id, accepted_via, offered,
      base_total_inc_gst, accepted_total_ex_gst, accepted_gst, accepted_total_inc_gst, accepted_deposit_inc_gst)
    VALUES ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f101',
            '00000000-0000-0000-0000-00000000f201', 'public_link', '[{"id":"a"}]'::jsonb, 1100, 1000, 100, 1100, 550);
    RAISE EXCEPTION 'quote options contract: a second record for one document was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- Written once: an update is refused.
  BEGIN
    UPDATE public.quote_option_acceptances SET taken_option_ids = '{}'::text[]
     WHERE job_document_id = '00000000-0000-0000-0000-00000000f101';
    RAISE EXCEPTION 'quote options contract: the record was changed';
  EXCEPTION WHEN restrict_violation THEN NULL;
  END;
  -- Money and shape checks, each refused.
  FOR bad IN
    SELECT * FROM (VALUES
      ('public_link', '[{"id":"a"}]', 1100::numeric, 1000::numeric, 100::numeric, 1200::numeric, 550::numeric, 'ex plus GST is not inc'),
      ('public_link', '[{"id":"a"}]', 1100, 900, 90, 990, 495, 'accepted below base'),
      ('public_link', '[{"id":"a"}]', 1100, 1000, 100, 1100, 1200, 'deposit above total'),
      ('public_link', '[{"id":"a"}]', 1100, 1000, 100, 1100, -1, 'negative deposit'),
      ('public_link', '[]', 1100, 1000, 100, 1100, 550, 'no option offered'),
      ('public_link', '{"id":"a"}', 1100, 1000, 100, 1100, 550, 'offered not a list'),
      ('public_link', '[1,2,3,4,5,6,7]', 1100, 1000, 100, 1100, 550, 'more than six offered'),
      ('staff_phone', '[{"id":"a"}]', 1100, 1000, 100, 1100, 550, 'staff not named'),
      ('by_email', '[{"id":"a"}]', 1100, 1000, 100, 1100, 550, 'unknown way in')
    ) AS v(via, offered, base, ex, gst, inc, dep, what)
  LOOP
    BEGIN
      INSERT INTO public.quote_option_acceptances (
        job_id, job_document_id, quote_revision_id, accepted_via, offered,
        base_total_inc_gst, accepted_total_ex_gst, accepted_gst, accepted_total_inc_gst, accepted_deposit_inc_gst)
      VALUES ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f102',
              '00000000-0000-0000-0000-00000000f201', bad.via, bad.offered::jsonb,
              bad.base, bad.ex, bad.gst, bad.inc, bad.dep);
      RAISE EXCEPTION 'quote options contract: accepted a record with %', bad.what;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  -- Staff on the phone, named, nothing ticked: accepted (offered, not taken).
  INSERT INTO public.quote_option_acceptances (
    job_id, job_document_id, quote_revision_id, accepted_via, accepted_by, offered,
    base_total_inc_gst, accepted_total_ex_gst, accepted_gst, accepted_total_inc_gst, accepted_deposit_inc_gst)
  VALUES ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f102',
          '00000000-0000-0000-0000-00000000f201', 'staff_phone', '00000000-0000-0000-0000-00000000f301',
          '[{"id":"a"}]'::jsonb, 1100, 1000, 100, 1100, 550);
  IF (SELECT taken_option_ids FROM public.quote_option_acceptances
       WHERE job_document_id = '00000000-0000-0000-0000-00000000f102') <> '{}'::text[] THEN
    RAISE EXCEPTION 'quote options contract: nothing ticked must record no taken ids';
  END IF;
END $$;
ROLLBACK;
