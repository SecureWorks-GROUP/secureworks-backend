-- Tighten the row rules on public.job_documents.
--
-- What this changes:
--   1. Drops the four 2025 rules from 20250301000001_schema.sql:
--      "Public can view shared docs", "Users can view job docs",
--      "Estimators+ can create docs" and "Estimators+ can update docs".
--      Nothing replaces the first: no anon reader of this table exists.
--   2. Adds job_documents_office_read (SELECT), job_documents_office_insert
--      (INSERT) and job_documents_office_update (UPDATE), all TO authenticated.
--      Each keeps the 2025 same-company test (the document's job is in
--      public.auth_org_id()) and adds the office-role test the newer rules use
--      inline (20261022040000_catalogue_prices_staff_only.sql:41-49,
--      20261101010000_flashing_library_staff_only.sql:91-99): the caller's
--      users.role is admin, owner, ops_manager, sales or sales_manager, the
--      office set of 20261002190000_business_events_close_anon_read.sql:89.
--      estimator is left out: new accounts are given it.
--   3. Revokes every table privilege on job_documents from anon.
--
-- What this deliberately does NOT change:
--   - authenticated and service_role grants.
--   - Edge functions: they use the service role, which bypasses row rules.
--   - Storage buckets.
--
-- Rollback: supabase/rollbacks/20261119090600_job_documents_read_rules_down.sql

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$
BEGIN
  IF to_regclass('public.job_documents') IS NULL THEN
    RAISE EXCEPTION 'job_documents_read_rules: public.job_documents is missing';
  END IF;
  IF to_regclass('public.jobs') IS NULL OR to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'job_documents_read_rules: public.jobs or public.users is missing';
  END IF;
  IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('public.auth_org_id()') IS NULL THEN
    RAISE EXCEPTION 'job_documents_read_rules: auth.uid() or public.auth_org_id() is missing';
  END IF;
END
$pre$;

ALTER TABLE public.job_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can view shared docs" ON public.job_documents;
DROP POLICY IF EXISTS "Users can view job docs" ON public.job_documents;
DROP POLICY IF EXISTS "Estimators+ can create docs" ON public.job_documents;
DROP POLICY IF EXISTS "Estimators+ can update docs" ON public.job_documents;

CREATE POLICY job_documents_office_read
  ON public.job_documents
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_documents.job_id AND j.org_id = public.auth_org_id())
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND lower(u.role) IN ('admin', 'owner', 'ops_manager', 'sales', 'sales_manager')
    )
  );

CREATE POLICY job_documents_office_insert
  ON public.job_documents
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_documents.job_id AND j.org_id = public.auth_org_id())
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND lower(u.role) IN ('admin', 'owner', 'ops_manager', 'sales', 'sales_manager')
    )
  );

CREATE POLICY job_documents_office_update
  ON public.job_documents
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_documents.job_id AND j.org_id = public.auth_org_id())
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND lower(u.role) IN ('admin', 'owner', 'ops_manager', 'sales', 'sales_manager')
    )
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_documents.job_id AND j.org_id = public.auth_org_id())
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND lower(u.role) IN ('admin', 'owner', 'ops_manager', 'sales', 'sales_manager')
    )
  );

REVOKE ALL ON TABLE public.job_documents FROM anon;

DO $post$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'job_documents'
      AND roles && ARRAY['public', 'anon']::name[]
  ) THEN
    RAISE EXCEPTION 'job_documents_read_rules: a row rule still applies to anon or PUBLIC';
  END IF;
  IF has_table_privilege('anon', 'public.job_documents', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR has_any_column_privilege('anon', 'public.job_documents', 'SELECT, INSERT, UPDATE, REFERENCES') THEN
    RAISE EXCEPTION 'job_documents_read_rules: anon still holds a privilege on job_documents';
  END IF;
END
$post$;
