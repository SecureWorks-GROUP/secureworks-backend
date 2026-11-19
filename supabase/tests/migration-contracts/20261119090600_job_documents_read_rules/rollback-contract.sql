-- After the down migration: the three 2025 rules are back as they were, the
-- office rules and both functions are gone, and the insert rule is unchanged.
DO $$
DECLARE problems text[] := ARRAY[]::text[];
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_documents'
      AND policyname IN ('Public can view shared docs', 'Users can view job docs', 'Estimators+ can update docs')
      AND roles = ARRAY['public']::name[]) <> 3 THEN
    problems := array_append(problems, 'the 2025 rules are not all back for PUBLIC'::text);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_documents'
             AND policyname IN ('job_documents_office_read', 'job_documents_office_update')) THEN
    problems := array_append(problems, 'an office rule is still present'::text);
  END IF;
  IF to_regprocedure('public.job_document_by_share_token(text)') IS NOT NULL
     OR to_regprocedure('public.job_documents_office_job(uuid)') IS NOT NULL THEN
    problems := array_append(problems, 'a function is still present'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_documents'
                 AND policyname = 'Estimators+ can create docs' AND cmd = 'INSERT') THEN
    problems := array_append(problems, 'the insert rule is missing'::text);
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'jd-rules rollback: %', array_to_string(problems, '; ');
  END IF;
END $$;
