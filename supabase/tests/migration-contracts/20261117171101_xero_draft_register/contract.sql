BEGIN;
-- Reapply on the disposable GitHub database, then exercise the stored contract.
\ir ../../../migrations/20261117171101_xero_draft_register.sql

DO $$
DECLARE
  inserted public.xero_draft_register%ROWTYPE;
  table_name text;
BEGIN
  INSERT INTO public.xero_draft_register
    (org_id, xero_document_id, document_type, source_kind, register_row, lines_fingerprint,
     has_account_codes, has_division_tags, has_job_reference, has_source_document)
  VALUES ('00000000-0000-0000-0000-000000000001', 'ZZTEST-draft', 'ACCPAY', 'supplier_bill', 'X3',
          'ZZTEST-fingerprint', true, true, true, true)
  RETURNING * INTO inserted;
  IF inserted.edited_before_approval IS NOT NULL THEN
    RAISE EXCEPTION 'approval edit state must start unknown';
  END IF;
  IF inserted.problems <> '[]'::jsonb OR inserted.job_ids <> '{}'::uuid[] THEN
    RAISE EXCEPTION 'draft defaults were not stored';
  END IF;
  BEGIN
    INSERT INTO public.xero_draft_register
      (org_id, xero_document_id, document_type, source_kind, register_row, lines_fingerprint,
       has_account_codes, has_division_tags, has_job_reference, has_source_document)
    VALUES (inserted.org_id, inserted.xero_document_id, 'ACCPAY', 'supplier_bill', 'X3',
            'ZZTEST-fingerprint', true, true, true, true);
    RAISE EXCEPTION 'duplicate document was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.xero_draft_register
      (org_id, xero_document_id, document_type, source_kind, register_row, lines_fingerprint,
       has_account_codes, has_division_tags, has_job_reference, has_source_document)
    VALUES (inserted.org_id, 'ZZTEST-invalid-row', 'ACCPAY', 'supplier_bill', 'X4',
            'ZZTEST-fingerprint', true, true, true, true);
    RAISE EXCEPTION 'unsupported register row was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  FOREACH table_name IN ARRAY ARRAY['xero_draft_register','bookkeeping_checks'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || table_name)::regclass)
       OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = table_name) THEN
      RAISE EXCEPTION 'register tables must have RLS and no policies';
    END IF;
    IF has_table_privilege('anon', 'public.' || table_name, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || table_name, 'INSERT') THEN
      RAISE EXCEPTION 'browser role has register access';
    END IF;
    IF NOT has_table_privilege('service_role', 'public.' || table_name, 'SELECT,INSERT,UPDATE') THEN
      RAISE EXCEPTION 'service role lacks register access';
    END IF;
  END LOOP;
END $$;
ROLLBACK;
