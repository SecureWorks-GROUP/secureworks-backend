-- Preserve payer bindings and every provider claim. Stop new capture and writes.
DROP TRIGGER IF EXISTS pin_invoice_payer_when_quote_released ON public.quote_revisions;
DROP FUNCTION IF EXISTS public.pin_quote_invoice_billing_payer();
REVOKE INSERT,UPDATE ON public.invoice_milestone_draft_claims FROM service_role;
