-- After the down migration: the four 2025 rules are back as they were, the
-- office rules are gone, and anon holds its table privileges again.
DO $$
DECLARE problems text[] := ARRAY[]::text[];
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_documents'
      AND policyname IN ('Public can view shared docs', 'Users can view job docs',
                         'Estimators+ can create docs', 'Estimators+ can update docs')
      AND roles = ARRAY['public']::name[]) <> 4 THEN
    problems := array_append(problems, 'the 2025 rules are not all back for PUBLIC'::text);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_documents'
             AND policyname IN ('job_documents_office_read', 'job_documents_office_insert', 'job_documents_office_update')) THEN
    problems := array_append(problems, 'an office rule is still present'::text);
  END IF;
  IF NOT has_table_privilege('anon', 'public.job_documents', 'SELECT, INSERT, UPDATE, DELETE') THEN
    problems := array_append(problems, 'anon did not get its table privileges back'::text);
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'jd-rules rollback: %', array_to_string(problems, '; ');
  END IF;
END $$;
