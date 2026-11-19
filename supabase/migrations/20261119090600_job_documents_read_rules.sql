-- Tighten the read and update rules on public.job_documents.
--
-- What this changes:
--   1. Drops the three 2025 rules "Public can view shared docs",
--      "Users can view job docs" and "Estimators+ can update docs"
--      (20250301000001_schema.sql).
--   2. Adds job_documents_office_read (SELECT) and job_documents_office_update
--      (UPDATE), both TO authenticated: the caller is office staff (users.role
--      admin, owner, ops_manager, sales or sales_manager) and the document's
--      job is in the caller's organisation. The check runs in the SECURITY
--      DEFINER helper job_documents_office_job(job_id), so it does not depend
--      on the users or jobs row rules. estimator is left out: it is the role a
--      new signed-in account is given (as in 20261002190000).
--   3. Adds job_document_by_share_token(token): one sent document by its share
--      token, as a fixed column list (no data snapshot, no token, no ids beyond
--      the document's own). A null, empty or unknown token, or a document not
--      sent to the client, returns no row. It writes nothing.
--
-- What this deliberately does NOT change:
--   - The insert rule "Estimators+ can create docs" and every table grant.
--   - Edge functions: they read and write this table with the service role,
--     which bypasses row rules.
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
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'job_documents_read_rules: auth.uid() is missing';
  END IF;
END
$pre$;

ALTER TABLE public.job_documents ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.job_documents_office_job(p_job_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.jobs j ON j.id = p_job_id AND j.org_id = u.org_id
    WHERE u.id = auth.uid()
      AND lower(u.role::text) IN ('admin', 'owner', 'ops_manager', 'sales', 'sales_manager')
  );
$$;

COMMENT ON FUNCTION public.job_documents_office_job(uuid) IS
  'True when the signed-in caller is office staff in the organisation of the given job. estimator is excluded because new accounts are given it.';

REVOKE ALL ON FUNCTION public.job_documents_office_job(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_documents_office_job(uuid) TO authenticated, service_role;

CREATE FUNCTION public.job_document_by_share_token(p_token text)
RETURNS TABLE (
  id uuid,
  type text,
  version integer,
  pdf_url text,
  sent_at timestamptz,
  viewed_at timestamptz,
  accepted_at timestamptz,
  declined_at timestamptz,
  client_name text,
  site_suburb text,
  job_type text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT d.id, d.type::text, d.version, d.pdf_url, d.sent_at, d.viewed_at,
         d.accepted_at, d.declined_at, j.client_name::text, j.site_suburb::text, j.type::text
  FROM public.job_documents d
  JOIN public.jobs j ON j.id = d.job_id
  WHERE nullif(btrim(p_token), '') IS NOT NULL
    AND d.share_token = p_token
    AND d.sent_to_client IS TRUE
  ORDER BY d.id
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.job_document_by_share_token(text) IS
  'The one sent document whose share token is given, as a fixed column list. No row for a null, empty or unknown token or an unsent document.';

REVOKE ALL ON FUNCTION public.job_document_by_share_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.job_document_by_share_token(text) TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "Public can view shared docs" ON public.job_documents;
DROP POLICY IF EXISTS "Users can view job docs" ON public.job_documents;
DROP POLICY IF EXISTS "Estimators+ can update docs" ON public.job_documents;

CREATE POLICY job_documents_office_read
  ON public.job_documents
  FOR SELECT
  TO authenticated
  USING (public.job_documents_office_job(job_id));

CREATE POLICY job_documents_office_update
  ON public.job_documents
  FOR UPDATE
  TO authenticated
  USING (public.job_documents_office_job(job_id))
  WITH CHECK (public.job_documents_office_job(job_id));

DO $post$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'job_documents'
      AND cmd IN ('SELECT', 'ALL')
      AND roles && ARRAY['public', 'anon']::name[]
  ) THEN
    RAISE EXCEPTION 'job_documents_read_rules: a read rule still applies to anon or PUBLIC';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'job_documents'
      AND cmd IN ('UPDATE', 'ALL')
      AND roles && ARRAY['public', 'anon']::name[]
  ) THEN
    RAISE EXCEPTION 'job_documents_read_rules: an update rule still applies to anon or PUBLIC';
  END IF;
END
$post$;
