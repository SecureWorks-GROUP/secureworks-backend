-- 20260501130000_quote_revisions_job_document_id_nullable.sql
-- CAP0-QUOTE-REVISION-QUICKQUOTE: relax quote_revisions.job_document_id from
-- NOT NULL to NULL.
--
-- Why: Quick Quote releases via ops-api/send_quick_quote_email don't create a
-- job_documents row. The send-quote/send and /send-runs paths always do, so the
-- column stays populated for those rows. Existing rows are unaffected (all
-- already non-null since the table was created on 2026-04-30 with the strict
-- constraint).
--
-- The FK reference + ON DELETE RESTRICT clause are preserved — only nullability
-- changes. The controlled-immutability trigger uses IS DISTINCT FROM, so a
-- released row with NULL job_document_id is just as immutable as a released row
-- with a populated job_document_id; nothing about the lifecycle changes.
--
-- get_release_packet() handles NULL job_document_id correctly: the `doc` CTE
-- filter `jd.id = (select job_document_id from rev)` returns no rows when the
-- revision's job_document_id is NULL, so packet.document is jsonb null.
-- Consumers (Cap 1 readiness, JARVIS, Secure Sale) must handle null document.

alter table public.quote_revisions
  alter column job_document_id drop not null;

comment on column public.quote_revisions.job_document_id is
  'Optional FK to the job_documents row this revision was generated from. NULL
   when the release path doesn''t produce a job_documents row (Quick Quote via
   ops-api/send_quick_quote_email). Patio/Fence quotes via send-quote /send and
   /send-runs always populate this with the source document id.';
