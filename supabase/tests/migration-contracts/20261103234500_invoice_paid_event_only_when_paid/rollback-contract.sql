-- After the down migration: the definition before 20261103234500 is back, and so is its behaviour
-- (a void records invoice.paid), proving the rollback restores the live surface it replaced.
BEGIN;
ALTER TABLE public.xero_invoices DISABLE TRIGGER USER;
ALTER TABLE public.xero_invoices ENABLE TRIGGER trg_payment_detected;
ALTER TABLE public.business_events DISABLE TRIGGER USER;
DO $$
DECLARE
  inv uuid;
  n int;
BEGIN
  IF md5(pg_get_functiondef('public.fn_payment_detected()'::regprocedure)) <> 'c0680811439254b5190a335d2aef804a' THEN
    RAISE EXCEPTION 'the rollback did not restore the definition before 20261103234500';
  END IF;
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_type, invoice_number, status, amount_due, total)
  VALUES ('00000000-0000-0000-0000-000000000001', 'fixture-only-b3-rollback', 'ACCREC', 'INV-FIXTURE', 'AUTHORISED', 100, 110)
  RETURNING id INTO inv;
  UPDATE public.xero_invoices SET status = 'VOIDED', amount_due = 0 WHERE id = inv;
  SELECT count(*) INTO n FROM public.business_events WHERE event_type = 'invoice.paid' AND entity_id = inv::text;
  IF n <> 1 THEN
    RAISE EXCEPTION 'after the rollback a void recorded % invoice.paid events, expected the old 1', n;
  END IF;
END;
$$;
ROLLBACK;
