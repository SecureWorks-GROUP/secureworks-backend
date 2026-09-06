-- ROLLBACK of 20260906190000_quote_group_email_send_records.sql

drop policy if exists service_role_all_quote_group_email_send_records
  on public.quote_group_email_send_records;

drop index if exists public.quote_group_email_send_records_job_recipient_idx;

drop table if exists public.quote_group_email_send_records;
