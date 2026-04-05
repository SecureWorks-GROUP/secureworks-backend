-- ════════════════════════════════════════════════════════════
-- Debt Automation — Payment Detection + Contact Enrichment
--
-- 1. Trigger: detects when xero_invoices.amount_due drops to 0
--    → inserts 'invoice.paid' into business_events
-- 2. View: surfaces overdue debtors with missing contact info
-- ════════════════════════════════════════════════════════════

-- ── 1. Payment detection trigger ──

CREATE OR REPLACE FUNCTION fn_payment_detected()
RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

-- Drop if exists to allow re-run
DROP TRIGGER IF EXISTS trg_payment_detected ON xero_invoices;

CREATE TRIGGER trg_payment_detected
  AFTER UPDATE OF amount_due ON xero_invoices
  FOR EACH ROW
  EXECUTE FUNCTION fn_payment_detected();

COMMENT ON FUNCTION fn_payment_detected() IS 'Fires when Xero sync marks an invoice as paid (amount_due → 0). Inserts invoice.paid event for downstream processing (chase termination, thank-you SMS).';


-- ── 2. Contact enrichment queue view ──

CREATE OR REPLACE VIEW contact_enrichment_queue AS
SELECT
  xi.contact_name,
  xi.xero_contact_id,
  xi.xero_invoice_id,
  xi.invoice_number,
  xi.amount_due,
  xi.due_date,
  (CURRENT_DATE - xi.due_date) AS days_overdue,
  CASE
    WHEN xi.due_date >= CURRENT_DATE THEN 'current'
    WHEN xi.due_date >= CURRENT_DATE - 30 THEN '1-30'
    WHEN xi.due_date >= CURRENT_DATE - 60 THEN '31-60'
    WHEN xi.due_date >= CURRENT_DATE - 90 THEN '61-90'
    ELSE '90+'
  END AS age_bucket,
  cm.ghl_contact_id,
  cm.phone AS cm_phone,
  cm.email AS cm_email,
  j.id AS job_id,
  j.job_number,
  j.client_phone AS job_phone,
  j.client_email AS job_email,
  j.site_address,
  j.type AS job_type,
  -- Flag what's missing
  CASE
    WHEN cm.ghl_contact_id IS NOT NULL AND (cm.phone IS NOT NULL OR j.client_phone IS NOT NULL) THEN 'reachable'
    WHEN cm.ghl_contact_id IS NULL AND (cm.phone IS NOT NULL OR j.client_phone IS NOT NULL) THEN 'has_phone_no_ghl'
    WHEN cm.ghl_contact_id IS NOT NULL AND cm.phone IS NULL AND j.client_phone IS NULL THEN 'has_ghl_no_phone'
    ELSE 'unreachable'
  END AS contact_status,
  -- Best available phone (contact_matches preferred, job fallback)
  COALESCE(cm.phone, j.client_phone) AS best_phone,
  COALESCE(cm.email, j.client_email) AS best_email
FROM xero_invoices xi
LEFT JOIN contact_matches cm ON cm.xero_contact_id = xi.xero_contact_id
LEFT JOIN jobs j ON j.id = xi.job_id
WHERE xi.invoice_type = 'ACCREC'
  AND xi.status IN ('AUTHORISED', 'SUBMITTED')
  AND xi.amount_due > 0
  AND xi.due_date < CURRENT_DATE
ORDER BY xi.amount_due DESC;

COMMENT ON VIEW contact_enrichment_queue IS 'Overdue ACCREC invoices with contact status. Shows best available phone/email from contact_matches or job fallback. Used by debt-chase automation to identify unreachable debtors.';


-- ── 3. Process payment events — pg_cron calls ops-api ──
-- Runs every 5 min. Picks up unprocessed invoice.paid events and calls
-- ops-api handle_payment_event for each (stops chase, sends thank-you).

CREATE OR REPLACE FUNCTION fn_process_payment_events()
RETURNS void AS $$
DECLARE
  evt RECORD;
  api_url text;
  svc_key text;
BEGIN
  -- Get service key from vault
  SELECT decrypted_secret INTO svc_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

  api_url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=handle_payment_event';

  -- Process events not yet handled (check metadata for processed flag)
  FOR evt IN
    SELECT id, payload, job_id
    FROM business_events
    WHERE event_type = 'invoice.paid'
      AND source = 'xero-sync-trigger'
      AND (metadata IS NULL OR metadata->>'payment_processed' IS NULL)
    ORDER BY occurred_at ASC
    LIMIT 10
  LOOP
    -- Call ops-api to handle the payment event
    PERFORM net.http_post(
      url := api_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || svc_key
      ),
      body := evt.payload || jsonb_build_object('job_id', evt.job_id)
    );

    -- Mark as processed
    UPDATE business_events
    SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"payment_processed": true}'::jsonb
    WHERE id = evt.id;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Schedule: every 5 minutes
SELECT cron.unschedule('process-payment-events') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'process-payment-events'
);
SELECT cron.schedule(
  'process-payment-events',
  '*/5 * * * *',
  $$SELECT fn_process_payment_events()$$
);
