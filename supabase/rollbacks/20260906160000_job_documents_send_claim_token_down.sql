-- ROLLBACK of 20260906160000_job_documents_send_claim_token.sql

alter table public.job_documents
  drop column if exists send_claim_token;
