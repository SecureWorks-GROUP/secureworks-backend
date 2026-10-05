-- Deliberately break the one-paid-key rule: key on the row's own entity id, so
-- the trigger's copy (entity = mirror row id) and xero-sync's row (entity =
-- Xero InvoiceID) of one payment get two keys and count twice.
CREATE OR REPLACE FUNCTION public.context_xero_paid_event_key(e public.business_events) RETURNS text
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN e.event_type IN ('invoice.paid','invoice.payment_received','invoice.manually_marked_paid')
  THEN 'xero:invoice:'||lower(e.entity_id)||':paid' END
$$;
