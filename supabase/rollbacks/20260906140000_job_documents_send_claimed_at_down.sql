-- ROLLBACK of 20260906140000_job_documents_send_claimed_at.sql

alter table public.job_documents
  drop column if exists send_claimed_at;
