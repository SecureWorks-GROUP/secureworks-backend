-- Contract for 20261015170000_debt_ws_report.sql. Every fixture write is inside a
-- transaction that rolls back.

-- 1. The three settings, with their defaults on the existing row: Marnin, cc Shaun,
--    the Monday auto-send off.
DO $$
DECLARE
  s record;
BEGIN
  SELECT report_recipients, report_cc, report_auto_send INTO s
    FROM public.debt_ws_settings WHERE id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contract: the settings row is missing';
  END IF;
  IF s.report_recipients IS DISTINCT FROM ARRAY['marnin@secureworkswa.com.au']::text[] THEN
    RAISE EXCEPTION 'contract: report_recipients default is %', s.report_recipients;
  END IF;
  IF s.report_cc IS DISTINCT FROM ARRAY['shaun@secureworkswa.com.au']::text[] THEN
    RAISE EXCEPTION 'contract: report_cc default is %', s.report_cc;
  END IF;
  IF s.report_auto_send THEN
    RAISE EXCEPTION 'contract: the Monday auto-send is on by default';
  END IF;
END $$;

-- 2. Only our own domain: an outside address, a look-alike domain, a capital letter or
--    an empty To list is refused by the database.
DO $$
DECLARE
  v_bad text;
  v_refused boolean;
BEGIN
  FOREACH v_bad IN ARRAY ARRAY[
    'someone@example.com',
    'marnin@secureworkswa.com.au.evil.test',
    'Marnin@secureworkswa.com.au'
  ] LOOP
    v_refused := false;
    BEGIN
      UPDATE public.debt_ws_settings SET report_recipients = ARRAY[v_bad] WHERE id = 1;
    EXCEPTION WHEN check_violation THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'contract: report_recipients accepted %', v_bad;
    END IF;
  END LOOP;
  v_refused := false;
  BEGIN
    UPDATE public.debt_ws_settings SET report_recipients = '{}' WHERE id = 1;
  EXCEPTION WHEN check_violation THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'contract: an empty report_recipients list was accepted';
  END IF;
  v_refused := false;
  BEGIN
    UPDATE public.debt_ws_settings SET report_cc = ARRAY['boss@gmail.com'] WHERE id = 1;
  EXCEPTION WHEN check_violation THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'contract: report_cc accepted an outside address';
  END IF;
END $$;

-- Two of our own addresses and no cc are fine.
BEGIN;
UPDATE public.debt_ws_settings
   SET report_recipients = ARRAY['marnin@secureworkswa.com.au', 'accounts@secureworkswa.com.au'],
       report_cc = '{}'
 WHERE id = 1;
ROLLBACK;

-- 3. debt_ws_reports: row-level security on, one policy, service role only.
DO $$
BEGIN
  IF to_regclass('public.debt_ws_reports') IS NULL THEN
    RAISE EXCEPTION 'contract: debt_ws_reports is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.debt_ws_reports'::regclass) THEN
    RAISE EXCEPTION 'debt_ws_reports requires row-level security';
  END IF;
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'debt_ws_reports') <> 1
     OR EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'debt_ws_reports'
                   AND NOT (roles = ARRAY['service_role']::name[])) THEN
    RAISE EXCEPTION 'contract: debt_ws_reports must carry exactly one service-role policy';
  END IF;
END $$;

-- 4. One sending-or-sent auto report per week; manual sends and a failed auto send are
--    not limited by it.
BEGIN;
INSERT INTO public.debt_ws_reports (kind, week_start, status, to_emails)
VALUES ('auto', '2026-10-12', 'sent', ARRAY['marnin@secureworkswa.com.au']),
       ('manual', '2026-10-12', 'sent', ARRAY['marnin@secureworkswa.com.au']),
       ('manual', '2026-10-12', 'sending', ARRAY['marnin@secureworkswa.com.au']),
       ('auto', '2026-10-12', 'failed', ARRAY['marnin@secureworkswa.com.au']);
DO $$
DECLARE
  v_refused boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.debt_ws_reports (kind, week_start, status, to_emails)
    VALUES ('auto', '2026-10-12', 'sending', ARRAY['marnin@secureworkswa.com.au']);
  EXCEPTION WHEN unique_violation THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'contract: a second auto report in one week was accepted';
  END IF;
END $$;
ROLLBACK;

-- 5. Payments received: Xero's /Date()/ form and an ISO date are both read; only ACCREC
--    invoices that are AUTHORISED or PAID count, only for the org asked for, and only
--    inside the dates asked for.
BEGIN;
SET LOCAL session_replication_role = replica; -- fixtures only: no other migration's trigger fires
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, reference, line_items, raw_json)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'contract-inv-1', 'INV-1', 'ACCREC', 'PAID', 'SWF-1-DEP',
   '[{"Description": "Deposit"}]',
   '{"Payments": [{"Date": "/Date(1791763200000+0000)/", "Amount": 100.5}, {"Date": "/Date(1789171200000+0000)/", "Amount": 7}]}'),
  ('00000000-0000-0000-0000-000000000001', 'contract-inv-2', 'INV-2', 'ACCREC', 'AUTHORISED', 'SWF-2-FIN',
   NULL, '{"Payments": [{"Date": "2026-10-13T00:00:00", "Amount": 20}]}'),
  ('00000000-0000-0000-0000-000000000001', 'contract-inv-3', 'INV-3', 'ACCREC', 'VOIDED', NULL,
   NULL, '{"Payments": [{"Date": "2026-10-13T00:00:00", "Amount": 999}]}'),
  ('00000000-0000-0000-0000-000000000001', 'contract-bill-4', 'BILL-4', 'ACCPAY', 'PAID', NULL,
   NULL, '{"Payments": [{"Date": "2026-10-13T00:00:00", "Amount": 888}]}'),
  ('00000000-0000-0000-0000-000000000002', 'contract-inv-5', 'INV-5', 'ACCREC', 'PAID', NULL,
   NULL, '{"Payments": [{"Date": "2026-10-13T00:00:00", "Amount": 777}]}'),
  ('00000000-0000-0000-0000-000000000001', 'contract-inv-6', 'INV-6', 'ACCREC', 'PAID', NULL,
   NULL, '{"Payments": "not a list"}');
DO $$
DECLARE
  v_n bigint;
  v_sum numeric;
  v_first record;
BEGIN
  SELECT count(*), sum(amount) INTO v_n, v_sum
    FROM public.debt_ws_payments_between('00000000-0000-0000-0000-000000000001', '2026-10-06', '2026-10-15');
  IF v_n <> 2 OR v_sum <> 120.5 THEN
    RAISE EXCEPTION 'contract: payments read % rows totalling %, expected 2 and 120.5', v_n, v_sum;
  END IF;
  SELECT * INTO v_first
    FROM public.debt_ws_payments_between('00000000-0000-0000-0000-000000000001', '2026-10-12', '2026-10-12');
  IF v_first.xero_invoice_id IS DISTINCT FROM 'contract-inv-1'
     OR v_first.paid_on IS DISTINCT FROM '2026-10-12'::date
     OR v_first.first_description IS DISTINCT FROM 'Deposit'
     OR v_first.reference IS DISTINCT FROM 'SWF-1-DEP' THEN
    RAISE EXCEPTION 'contract: the /Date()/ payment was read as %', row_to_json(v_first);
  END IF;
END $$;
ROLLBACK;

-- 6. Neither function is open to the browser roles.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.debt_ws_payments_between(uuid, date, date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.debt_ws_payments_between(uuid, date, date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.trigger_debt_ws_report_auto()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trigger_debt_ws_report_auto()', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: a debt report function is executable by anon or authenticated';
  END IF;
END $$;

-- 7. The Monday trigger does nothing while report_auto_send is off: no net call is made,
--    so it returns cleanly even where pg_net is absent.
SELECT public.trigger_debt_ws_report_auto();
