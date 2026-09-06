-- ROLLBACK of 20260906170000_job_documents_send_resend_idempotency_key.sql

alter table public.job_documents
  drop column if exists send_resend_idempotency_key;
