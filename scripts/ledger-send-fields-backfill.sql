-- Read-only counts of typed values that already exist.
-- email_events.recipient and invoice.emailed detail_json.to are the addresses.
-- xero_invoices amount_paid, amount_due and raw Payments / credits are the money.
-- This file does not UPDATE or INSERT.

SELECT
 (SELECT count(*) FROM public.email_events e
   WHERE btrim(e.recipient) ~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$')
  AS email_events_one_address,
 (SELECT count(*) FROM public.job_events j
   WHERE lower(btrim(j.event_type)) = 'invoice.emailed'
    AND btrim(j.detail_json->>'to') ~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$')
  AS invoice_emailed_one_address,
 (SELECT count(*) FROM public.xero_invoices x
   WHERE x.amount_paid IS NOT NULL
    OR x.amount_due IS NOT NULL
    OR (jsonb_typeof(x.raw_json->'Payments') = 'array' AND jsonb_array_length(x.raw_json->'Payments') > 0)
    OR (jsonb_typeof(x.raw_json->'CreditNotes') = 'array' AND jsonb_array_length(x.raw_json->'CreditNotes') > 0)
    OR (jsonb_typeof(x.raw_json->'Overpayments') = 'array' AND jsonb_array_length(x.raw_json->'Overpayments') > 0)
    OR (jsonb_typeof(x.raw_json->'Prepayments') = 'array' AND jsonb_array_length(x.raw_json->'Prepayments') > 0))
  AS xero_invoices_with_money,
 (SELECT count(*) FROM public.xero_invoices x
   WHERE upper(btrim(coalesce(x.status, ''))) = 'PAID' AND x.invoice_type = 'ACCREC')
  AS paid_accrec,
 (SELECT count(*) FROM public.xero_invoices x
   WHERE upper(btrim(coalesce(x.status, ''))) = 'PAID' AND x.invoice_type = 'ACCPAY')
  AS paid_accpay,
 (SELECT count(*) FROM public.job_documents d
   WHERE d.sent_at IS NOT NULL
    AND (
     EXISTS (SELECT 1 FROM public.email_events e
      WHERE e.job_id = d.job_id AND e.metadata->>'document_id' = d.id::text)
     OR EXISTS (SELECT 1 FROM public.job_events j
      WHERE j.job_id = d.job_id
       AND lower(btrim(j.event_type)) IN ('invoice.emailed', 'quote_sent')
       AND j.detail_json->>'document_id' = d.id::text)))
  AS sent_documents_named,
 (SELECT count(*) FROM public.job_events j
   WHERE lower(btrim(j.event_type)) = 'quote_sent'
    AND btrim(j.detail_json->>'sent_to') ~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$')
  AS quote_sent_one_address;
