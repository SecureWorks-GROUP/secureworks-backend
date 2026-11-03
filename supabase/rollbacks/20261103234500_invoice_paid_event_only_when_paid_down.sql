-- Rollback of 20261103234500: fn_payment_detected back to its definition before that change (md5
-- c0680811439254b5190a335d2aef804a, read from production 3 Nov 08:43Z), which also records "invoice.paid"
-- when a void or delete takes amount_due to 0. Events written while the change was live are not touched.
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION public.fn_payment_detected()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Fire when amount_due drops to 0 (fully paid) on a sales invoice
  IF OLD.amount_due > 0 AND NEW.amount_due = 0 AND NEW.invoice_type = 'ACCREC' THEN
    INSERT INTO business_events (
      event_type, source, entity_type, entity_id, job_id, payload,
      occurred_at, recorded_at
    ) VALUES (
      'invoice.paid',
      'xero-sync-trigger',
      'invoice',
      NEW.id::text,
      NEW.job_id,
      jsonb_build_object(
        'invoice_number', NEW.invoice_number,
        'contact_name', NEW.contact_name,
        'amount_paid', NEW.total,
        'xero_contact_id', NEW.xero_contact_id,
        'xero_invoice_id', NEW.xero_invoice_id
      ),
      now(),
      now()
    );
  END IF;
  RETURN NEW;
END;
$function$;

DO $check$
BEGIN
  IF md5(pg_get_functiondef('public.fn_payment_detected()'::regprocedure)) <> 'c0680811439254b5190a335d2aef804a' THEN
    RAISE EXCEPTION 'fn_payment_detected rollback did not restore the old definition';
  END IF;
END $check$;
