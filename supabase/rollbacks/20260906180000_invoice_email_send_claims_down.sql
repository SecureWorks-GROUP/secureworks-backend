-- ROLLBACK of 20260906180000_invoice_email_send_claims.sql

drop policy if exists service_role_all_invoice_email_send_claims
  on public.invoice_email_send_claims;

drop table if exists public.invoice_email_send_claims;
