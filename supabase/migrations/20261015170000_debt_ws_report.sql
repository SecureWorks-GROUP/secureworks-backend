-- Debt Workshop: the debt report (Shaun approved 15 Oct 2026).
--
-- The Debt tab gets a "Debt report" button. It opens the live debt position (cash at bank,
-- money received, debt by category, companies, every open invoice, and a line that ties the
-- totals to Xero's open total to the cent). From that view the owner can download it as a
-- PDF or email it to Marnin. Contract: docs/debt-workshop/README.md ("The debt report").
--
-- This migration:
-- 1. Adds three settings to debt_ws_settings (row id = 1):
--      report_recipients  who the report goes to. Default: Marnin.
--      report_cc          who is copied. Default: Shaun (users.id 9913309f..., the workshop
--                         owner, whose users.email is shaun@secureworkswa.com.au).
--      report_auto_send   the Monday 08:00 Perth auto-send. Default OFF.
--    Every address must be on our own domain (@secureworkswa.com.au): the report holds
--    every client's name and balance, so it never goes outside the company. A CHECK
--    constraint holds that rule here, and ops-api checks it again before every send.
-- 2. Creates debt_ws_reports: one row per report email (manual or the Monday auto-send),
--    written as 'sending' before the email goes, with the HTML and the PDF kept as a copy.
--    At most one sending-or-sent auto report per Monday-to-Sunday week.
-- 3. Creates debt_ws_payments_between(org, from, to): the customer payments applied in Xero
--    between two dates, read from our Xero copy (xero_invoices.raw_json -> Payments), for
--    the "money received in the last 7 and 30 days" figures. Read only.
-- 4. Schedules debt-ws-report-auto (Monday 00:00 UTC = 08:00 Perth). Its trigger returns
--    without calling anything unless report_auto_send is on, and ops-api checks the
--    switches again (sending must be on too). Skipped where pg_cron is absent.
--
-- Nothing is sent when this migration applies: report_auto_send starts off, and a manual
-- send needs the owner's click. Re-applying is a no-op and keeps a changed settings row.

-- 1. Settings
ALTER TABLE public.debt_ws_settings
  ADD COLUMN IF NOT EXISTS report_recipients text[] NOT NULL
    DEFAULT ARRAY['marnin@secureworkswa.com.au']::text[],
  ADD COLUMN IF NOT EXISTS report_cc text[] NOT NULL
    DEFAULT ARRAY['shaun@secureworkswa.com.au']::text[],
  ADD COLUMN IF NOT EXISTS report_auto_send boolean NOT NULL DEFAULT false;

-- Only our own domain, lower case, and at least one recipient.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'debt_ws_settings_report_addresses_internal'
       AND conrelid = 'public.debt_ws_settings'::regclass
  ) THEN
    ALTER TABLE public.debt_ws_settings
      ADD CONSTRAINT debt_ws_settings_report_addresses_internal CHECK (
        cardinality(report_recipients) BETWEEN 1 AND 10
        AND cardinality(report_cc) <= 10
        AND array_to_string(report_recipients || report_cc, ',')
          ~ '^([a-z0-9._%+-]+@secureworkswa\.com\.au)(,[a-z0-9._%+-]+@secureworkswa\.com\.au)*$'
      );
  END IF;
END $$;

COMMENT ON COLUMN public.debt_ws_settings.report_recipients IS
  'Debt report: who it is emailed to (To). Our own domain only (@secureworkswa.com.au, lower case). Default Marnin.';
COMMENT ON COLUMN public.debt_ws_settings.report_cc IS
  'Debt report: who is copied (Cc). Our own domain only. Default Shaun.';
COMMENT ON COLUMN public.debt_ws_settings.report_auto_send IS
  'Debt report: the Monday 08:00 Perth auto-send. Default off. Also needs sending_enabled.';

-- 2. The report sends
CREATE TABLE IF NOT EXISTS public.debt_ws_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  kind text NOT NULL CHECK (kind IN ('manual', 'auto')),
  -- The Monday of the Perth week the report was sent in.
  week_start date NOT NULL,
  status text NOT NULL DEFAULT 'sending'
    CHECK (status IN ('sending', 'sent', 'failed', 'refused')),
  to_emails text[] NOT NULL DEFAULT '{}',
  cc_emails text[] NOT NULL DEFAULT '{}',
  subject text,
  -- The short summary in the email body, and the headline figures, for the record.
  summary text,
  totals jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(totals) = 'object'),
  -- The copy: the report as HTML and the PDF that was attached (base64), with its hash.
  html text,
  pdf_base64 text,
  pdf_sha256 text,
  sent_by uuid,
  sent_by_name text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_ws_reports_auto_week
  ON public.debt_ws_reports (org_id, week_start)
  WHERE kind = 'auto' AND status IN ('sending', 'sent');
CREATE INDEX IF NOT EXISTS idx_debt_ws_reports_recent
  ON public.debt_ws_reports (org_id, created_at DESC);
COMMENT ON TABLE public.debt_ws_reports IS
  'Debt Workshop: one row per debt report email, written as sending before the email goes, with a copy of the HTML and the attached PDF. At most one sending-or-sent auto report per week (idx_debt_ws_reports_auto_week). Written by ops-api debt_ws_report_send and debt_ws_report_auto only.';

ALTER TABLE public.debt_ws_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS debt_ws_reports_service_role_all ON public.debt_ws_reports;
CREATE POLICY debt_ws_reports_service_role_all ON public.debt_ws_reports
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. Payments received, from our Xero copy. Xero stores a payment date as
--    "/Date(1791763200000+0000)/" (midnight UTC of the payment day); an ISO date is read
--    too. Only receivables (ACCREC) that are AUTHORISED or PAID count; a voided invoice's
--    payments do not.
CREATE OR REPLACE FUNCTION public.debt_ws_payments_between(
  p_org_id uuid,
  p_from date,
  p_to date
)
RETURNS TABLE (
  xero_invoice_id text,
  invoice_number text,
  contact_name text,
  reference text,
  first_description text,
  job_id uuid,
  paid_on date,
  amount numeric
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT i.xero_invoice_id, i.invoice_number, i.contact_name, i.reference,
         i.line_items -> 0 ->> 'Description', i.job_id, p.paid_on, p.amount
    FROM public.xero_invoices i
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN e ->> 'Date' ~ '^/Date\(-?[0-9]+'
                 THEN (to_timestamp(
                   substring(e ->> 'Date' from '^/Date\((-?[0-9]+)')::bigint / 1000.0
                 ) AT TIME ZONE 'UTC')::date
               WHEN e ->> 'Date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                 THEN substring(e ->> 'Date' from 1 for 10)::date
             END AS paid_on,
             CASE WHEN e ->> 'Amount' ~ '^-?[0-9]+(\.[0-9]+)?$'
                  THEN (e ->> 'Amount')::numeric END AS amount
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(i.raw_json -> 'Payments') = 'array'
               THEN i.raw_json -> 'Payments' ELSE '[]'::jsonb END
        ) e
    ) p
   WHERE i.org_id = p_org_id
     AND i.invoice_type = 'ACCREC'
     AND i.status IN ('AUTHORISED', 'PAID')
     AND p.paid_on BETWEEN p_from AND p_to
     AND p.amount IS NOT NULL
   ORDER BY p.paid_on, i.xero_invoice_id
$$;
COMMENT ON FUNCTION public.debt_ws_payments_between(uuid, date, date) IS
  'Debt report: customer payments applied in Xero between two dates (inclusive), one row per payment, from xero_invoices.raw_json -> Payments. Read only.';
REVOKE ALL ON FUNCTION public.debt_ws_payments_between(uuid, date, date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debt_ws_payments_between(uuid, date, date)
  TO service_role;

-- 4. The Monday auto-send. A no-op unless report_auto_send is on.
CREATE OR REPLACE FUNCTION public.trigger_debt_ws_report_auto()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT coalesce(
    (SELECT report_auto_send FROM public.debt_ws_settings WHERE id = 1), false
  ) THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=debt_ws_report_auto',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.sw_service_key(),
      'Content-Type', 'application/json',
      'x-sw-actor', 'debt-ws-cron'
    ),
    body := jsonb_build_object('actor', 'debt-ws-cron'),
    timeout_milliseconds := 60000
  );
END $$;
COMMENT ON FUNCTION public.trigger_debt_ws_report_auto() IS
  'pg_cron debt-ws-report-auto (Mon 08:00 Perth): posts ops-api debt_ws_report_auto with the service key while debt_ws_settings.report_auto_send is on. Otherwise a no-op.';
REVOKE ALL ON FUNCTION public.trigger_debt_ws_report_auto() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_debt_ws_report_auto() TO service_role, postgres;

DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'debt report: pg_cron absent, the Monday auto-send is not scheduled';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'debt-ws-report-auto') THEN
    PERFORM cron.schedule('debt-ws-report-auto', '0 0 * * 1',
      $cmd$SELECT public.trigger_debt_ws_report_auto()$cmd$);
  END IF;
END $cron$;
