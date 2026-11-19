-- Down for 20261119090600_job_documents_read_rules.sql: puts back the four
-- 2025 rules exactly as 20250301000001_schema.sql wrote them, removes the
-- three office rules, and gives anon back every table privilege on
-- job_documents (Supabase's default grant, which production held).

SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS job_documents_office_read ON public.job_documents;
DROP POLICY IF EXISTS job_documents_office_insert ON public.job_documents;
DROP POLICY IF EXISTS job_documents_office_update ON public.job_documents;

DROP POLICY IF EXISTS "Users can view job docs" ON public.job_documents;
DROP POLICY IF EXISTS "Estimators+ can create docs" ON public.job_documents;
DROP POLICY IF EXISTS "Estimators+ can update docs" ON public.job_documents;
DROP POLICY IF EXISTS "Public can view shared docs" ON public.job_documents;

create policy "Users can view job docs"
  on job_documents for select
  using (exists (select 1 from jobs where jobs.id = job_documents.job_id and jobs.org_id = auth_org_id()));

create policy "Estimators+ can create docs"
  on job_documents for insert
  with check (exists (select 1 from jobs where jobs.id = job_documents.job_id and jobs.org_id = auth_org_id()));

create policy "Estimators+ can update docs"
  on job_documents for update
  using (exists (select 1 from jobs where jobs.id = job_documents.job_id and jobs.org_id = auth_org_id()));

create policy "Public can view shared docs"
  on job_documents for select
  using (share_token is not null and sent_to_client = true);

GRANT ALL ON TABLE public.job_documents TO anon;
