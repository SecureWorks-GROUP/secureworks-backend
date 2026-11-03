-- Minimal surface for the payment trigger before 20261103234500: the xero_invoices and business_events
-- columns fn_payment_detected reads and writes, and the function exactly as production had it (md5
-- c0680811439254b5190a335d2aef804a, read 3 Nov 2026 08:43Z) with its trigger.
CREATE TABLE IF NOT EXISTS public.xero_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.xero_invoices
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS xero_invoice_id text,
  ADD COLUMN IF NOT EXISTS invoice_type text,
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS contact_name text,
  ADD COLUMN IF NOT EXISTS xero_contact_id text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS amount_due numeric,
  ADD COLUMN IF NOT EXISTS total numeric,
  ADD COLUMN IF NOT EXISTS job_id uuid;

CREATE TABLE IF NOT EXISTS public.business_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.business_events
  ADD COLUMN IF NOT EXISTS event_type text,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS entity_type text,
  ADD COLUMN IF NOT EXISTS entity_id text,
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS payload jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS occurred_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS recorded_at timestamptz DEFAULT now();

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

DROP TRIGGER IF EXISTS trg_payment_detected ON public.xero_invoices;
CREATE TRIGGER trg_payment_detected AFTER UPDATE OF amount_due ON public.xero_invoices
  FOR EACH ROW EXECUTE FUNCTION fn_payment_detected();
