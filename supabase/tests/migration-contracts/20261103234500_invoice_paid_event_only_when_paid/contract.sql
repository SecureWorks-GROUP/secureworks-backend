-- Executed after 20261103234500: "invoice.paid" is recorded only when a sales invoice becomes PAID.
-- Fixture writes are rolled back; other cases' triggers on these two tables are switched off inside
-- the transaction so only the payment trigger is under test.
BEGIN;
ALTER TABLE public.xero_invoices DISABLE TRIGGER USER;
ALTER TABLE public.xero_invoices ENABLE TRIGGER trg_payment_detected;
ALTER TABLE public.business_events DISABLE TRIGGER USER;

DO $$
DECLARE
  inv uuid;
  n int;
BEGIN
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_type, invoice_number, status, amount_due, total)
  VALUES ('00000000-0000-0000-0000-000000000001', 'fixture-only-b3', 'ACCREC', 'INV-FIXTURE', 'AUTHORISED', 100, 110)
  RETURNING id INTO inv;

  -- The write ops-api void_invoice makes (xero_void_mirror.ts), then a delete, each from an open invoice.
  UPDATE public.xero_invoices SET status = 'VOIDED', amount_due = 0 WHERE id = inv;
  UPDATE public.xero_invoices SET status = 'AUTHORISED', amount_due = 100 WHERE id = inv;
  UPDATE public.xero_invoices SET status = 'DELETED', amount_due = 0 WHERE id = inv;
  UPDATE public.xero_invoices SET status = 'AUTHORISED', amount_due = 100 WHERE id = inv;
  SELECT count(*) INTO n FROM public.business_events WHERE event_type = 'invoice.paid' AND entity_id = inv::text;
  IF n <> 0 THEN
    RAISE EXCEPTION 'a void or delete recorded invoice.paid (% events)', n;
  END IF;

  -- A payment that pays it off.
  UPDATE public.xero_invoices SET status = 'PAID', amount_due = 0 WHERE id = inv;
  SELECT count(*) INTO n FROM public.business_events WHERE event_type = 'invoice.paid' AND entity_id = inv::text;
  IF n <> 1 THEN
    RAISE EXCEPTION 'paying the invoice off recorded % invoice.paid events, expected 1', n;
  END IF;

  -- Already PAID: amount_due moving back to 0 is not a second payment.
  UPDATE public.xero_invoices SET amount_due = 5 WHERE id = inv;
  UPDATE public.xero_invoices SET amount_due = 0 WHERE id = inv;
  SELECT count(*) INTO n FROM public.business_events WHERE event_type = 'invoice.paid' AND entity_id = inv::text;
  IF n <> 1 THEN
    RAISE EXCEPTION 'an invoice already PAID recorded invoice.paid again (% events)', n;
  END IF;

  IF md5(pg_get_functiondef('public.fn_payment_detected()'::regprocedure)) <> '4bf8d1847135539f995590d276583a61' THEN
    RAISE EXCEPTION 'fn_payment_detected is not the 20261103234500 definition';
  END IF;
END;
$$;
ROLLBACK;
