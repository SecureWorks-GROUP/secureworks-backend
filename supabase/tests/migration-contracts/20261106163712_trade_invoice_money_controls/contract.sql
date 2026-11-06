-- Trade invoice money controls (20261106163712).

-- 1. Invoice numbers are unique; an invoice with no number is not.
BEGIN;
-- Test only, undone with the transaction: set aside the rules other
-- migrations put on these two tables (foreign keys, checks, NOT NULLs and
-- triggers), so this case tests only its own guard and unique index.
DO $iso$
DECLARE r record;
BEGIN
  FOR r IN SELECT conrelid::regclass AS t, conname FROM pg_constraint
    WHERE conrelid IN ('public.trade_invoices'::regclass, 'public.trade_invoice_lines'::regclass)
      AND contype IN ('f', 'c') LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.t, r.conname);
  END LOOP;
  FOR r IN SELECT a.attrelid::regclass AS t, a.attname FROM pg_attribute a
    WHERE a.attrelid IN ('public.trade_invoices'::regclass, 'public.trade_invoice_lines'::regclass)
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull AND a.attname <> 'id' LOOP
    EXECUTE format('ALTER TABLE %s ALTER COLUMN %I DROP NOT NULL', r.t, r.attname);
  END LOOP;
  FOR r IN SELECT tgrelid::regclass AS t, tgname FROM pg_trigger
    WHERE tgrelid IN ('public.trade_invoices'::regclass, 'public.trade_invoice_lines'::regclass)
      AND NOT tgisinternal AND tgname <> 'trg_trade_invoice_lines_no_week_claim_guard' LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', r.t, r.tgname);
  END LOOP;
END $iso$;
INSERT INTO public.trade_invoices (id, invoice_number, status)
VALUES ('00000000-0000-4000-8000-000000000001', 'SW-INV-T-000000-001', 'approved'),
       ('00000000-0000-4000-8000-000000000002', NULL, 'draft'),
       ('00000000-0000-4000-8000-000000000003', NULL, 'draft');
DO $$
BEGIN
  BEGIN
    INSERT INTO public.trade_invoices (id, invoice_number, status)
    VALUES ('00000000-0000-4000-8000-000000000004', 'SW-INV-T-000000-001', 'approved');
    RAISE EXCEPTION 'contract: a repeated invoice number was accepted';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM NOT LIKE '%trade_invoices_invoice_number_key%' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;

-- 2. The event record is append-only, service role only, and checked.
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trade_invoice_events'::regclass) THEN
    RAISE EXCEPTION 'contract: trade_invoice_events must have RLS on';
  END IF;
  IF has_table_privilege('anon', 'public.trade_invoice_events', 'SELECT')
     OR has_table_privilege('authenticated', 'public.trade_invoice_events', 'SELECT')
     OR has_table_privilege('authenticated', 'public.trade_invoice_events', 'INSERT') THEN
    RAISE EXCEPTION 'contract: browser roles must not reach trade_invoice_events';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.trade_invoice_events', 'INSERT')
     OR has_table_privilege('service_role', 'public.trade_invoice_events', 'UPDATE')
     OR has_table_privilege('service_role', 'public.trade_invoice_events', 'DELETE') THEN
    RAISE EXCEPTION 'contract: service role may insert and read events only';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trade_invoice_extra_rate_rules'::regclass)
     OR has_table_privilege('authenticated', 'public.trade_invoice_extra_rate_rules', 'SELECT')
     OR has_table_privilege('anon', 'public.trade_invoice_extra_rate_rules', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.trade_invoice_extra_rate_rules', 'UPDATE') THEN
    RAISE EXCEPTION 'contract: rate rules are service role only, RLS on';
  END IF;
  IF EXISTS (SELECT 1 FROM public.trade_invoice_extra_rate_rules) THEN
    RAISE EXCEPTION 'contract: the rate rules ship empty';
  END IF;
END $$;

BEGIN;
INSERT INTO public.trade_invoice_events (id, trade_invoice_id, event_type, actor, detail)
VALUES ('00000000-0000-4000-8000-0000000000e1', gen_random_uuid(), 'voided_bill_released', 'system:xero-sync', '{"status":"VOIDED"}');
DO $$
BEGIN
  BEGIN
    UPDATE public.trade_invoice_events SET reason = 'x' WHERE id = '00000000-0000-4000-8000-0000000000e1';
    RAISE EXCEPTION 'contract: an event was updated';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.trade_invoice_events WHERE id = '00000000-0000-4000-8000-0000000000e1';
    RAISE EXCEPTION 'contract: an event was deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.trade_invoice_events (trade_invoice_id, event_type, actor)
    VALUES (gen_random_uuid(), 'anything_else', 'x');
    RAISE EXCEPTION 'contract: an unknown event type was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.trade_invoice_events (trade_invoice_id, event_type, actor)
    VALUES (gen_random_uuid(), 'extra_rate_held', '  ');
    RAISE EXCEPTION 'contract: a blank actor was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.trade_invoice_extra_rate_rules (line_type, max_unit_rate_ex) VALUES ('Materials', 10);
    RAISE EXCEPTION 'contract: a mixed-case rule type was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.trade_invoice_extra_rate_rules (line_type, max_unit_rate_ex) VALUES ('materials', 0);
    RAISE EXCEPTION 'contract: a zero limit was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
INSERT INTO public.trade_invoice_extra_rate_rules (line_type, max_unit_rate_ex) VALUES ('*', 100), ('materials', 250);
ROLLBACK;

-- 3. One live no-week invoice per person per work order and line kind.
BEGIN;
-- Test only, undone with the transaction: set aside the rules other
-- migrations put on these two tables (foreign keys, checks, NOT NULLs and
-- triggers), so this case tests only its own guard and unique index.
DO $iso$
DECLARE r record;
BEGIN
  FOR r IN SELECT conrelid::regclass AS t, conname FROM pg_constraint
    WHERE conrelid IN ('public.trade_invoices'::regclass, 'public.trade_invoice_lines'::regclass)
      AND contype IN ('f', 'c') LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.t, r.conname);
  END LOOP;
  FOR r IN SELECT a.attrelid::regclass AS t, a.attname FROM pg_attribute a
    WHERE a.attrelid IN ('public.trade_invoices'::regclass, 'public.trade_invoice_lines'::regclass)
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull AND a.attname <> 'id' LOOP
    EXECUTE format('ALTER TABLE %s ALTER COLUMN %I DROP NOT NULL', r.t, r.attname);
  END LOOP;
  FOR r IN SELECT tgrelid::regclass AS t, tgname FROM pg_trigger
    WHERE tgrelid IN ('public.trade_invoices'::regclass, 'public.trade_invoice_lines'::regclass)
      AND NOT tgisinternal AND tgname <> 'trg_trade_invoice_lines_no_week_claim_guard' LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', r.t, r.tgname);
  END LOOP;
END $iso$;
INSERT INTO public.trade_invoices (id, user_id, status, week_start, invoice_number) VALUES
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000f1', 'approved', NULL, 'N-1'),
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000f1', 'pending_acknowledgment', NULL, 'N-2'),
  ('00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-0000000000f1', 'draft', NULL, 'N-3'),
  ('00000000-0000-4000-8000-0000000000a4', '00000000-0000-4000-8000-0000000000f1', 'pending_acknowledgment', '2026-01-05', 'N-4'),
  ('00000000-0000-4000-8000-0000000000a5', '00000000-0000-4000-8000-0000000000f2', 'pending_acknowledgment', NULL, 'N-5'),
  ('00000000-0000-4000-8000-0000000000a6', '00000000-0000-4000-8000-0000000000f1', 'ops-reject', NULL, 'N-6');

-- The first claim on the work order.
INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex, source_work_order_id)
VALUES ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'work order', 100, '00000000-0000-4000-8000-0000000000c1');

DO $$
BEGIN
  -- The same person, work order and kind on a second live no-week invoice.
  BEGIN
    INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex, source_work_order_id)
    VALUES ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000b1', ' Work Order ', 50, '00000000-0000-4000-8000-0000000000c1');
    RAISE EXCEPTION 'contract: a second live no-week claim was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'no_week_claim_already_invoiced' THEN RAISE; END IF;
  END;
END $$;

-- Allowed: a draft, a weekly invoice, another person, travel, a deduction,
-- another kind, a line naming no work order, a second line on the same invoice.
INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex, source_work_order_id) VALUES
  ('00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-0000000000b1', 'work order', 100, '00000000-0000-4000-8000-0000000000c1'),
  ('00000000-0000-4000-8000-0000000000a4', '00000000-0000-4000-8000-0000000000b1', 'work order', 100, '00000000-0000-4000-8000-0000000000c1'),
  ('00000000-0000-4000-8000-0000000000a5', '00000000-0000-4000-8000-0000000000b1', 'work order', 100, '00000000-0000-4000-8000-0000000000c1'),
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000b1', 'travel', 30, '00000000-0000-4000-8000-0000000000c1'),
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000b1', 'work order', -20, '00000000-0000-4000-8000-0000000000c1'),
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000b1', 'materials', 40, '00000000-0000-4000-8000-0000000000c1'),
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000b1', 'work order', 40, NULL),
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'work order', 10, '00000000-0000-4000-8000-0000000000c1');

-- Once the first invoice is released, the claim is free again.
UPDATE public.trade_invoices SET status = 'ops-reject' WHERE id = '00000000-0000-4000-8000-0000000000a1';
INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex, source_work_order_id)
VALUES ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000b1', 'work order', 100, '00000000-0000-4000-8000-0000000000c1');
ROLLBACK;
