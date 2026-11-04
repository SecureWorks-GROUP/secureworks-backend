-- Put back the old rule (amount_due reaching 0 is enough) so contract.sql must fail on the void.
CREATE OR REPLACE FUNCTION public.fn_payment_detected()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.amount_due > 0 AND NEW.amount_due = 0 AND NEW.invoice_type = 'ACCREC' THEN
    INSERT INTO business_events (event_type, source, entity_type, entity_id, job_id, payload, occurred_at, recorded_at)
    VALUES ('invoice.paid', 'xero-sync-trigger', 'invoice', NEW.id::text, NEW.job_id, '{}'::jsonb, now(), now());
  END IF;
  RETURN NEW;
END;
$function$;
