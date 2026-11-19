-- Down for 20261119090600_job_documents_read_rules.sql: puts back the three
-- 2025 rules exactly as 20250301000001_schema.sql wrote them and removes the
-- two office rules and both functions. Grants and the insert rule were not
-- changed, so nothing else is restored.

SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS job_documents_office_read ON public.job_documents;
DROP POLICY IF EXISTS job_documents_office_update ON public.job_documents;
DROP FUNCTION IF EXISTS public.job_document_by_share_token(text);
DROP FUNCTION IF EXISTS public.job_documents_office_job(uuid);

DROP POLICY IF EXISTS "Users can view job docs" ON public.job_documents;
DROP POLICY IF EXISTS "Estimators+ can update docs" ON public.job_documents;
DROP POLICY IF EXISTS "Public can view shared docs" ON public.job_documents;

create policy "Users can view job docs"
  on job_documents for select
  using (exists (select 1 from jobs where jobs.id = job_documents.job_id and jobs.org_id = auth_org_id()));

create policy "Estimators+ can update docs"
  on job_documents for update
  using (exists (select 1 from jobs where jobs.id = job_documents.job_id and jobs.org_id = auth_org_id()));

create policy "Public can view shared docs"
  on job_documents for select
  using (share_token is not null and sent_to_client = true);
