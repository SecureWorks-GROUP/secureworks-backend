-- Test only, in this throwaway copy: set aside the rules other
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
-- Two invoices already share a number: the unique index cannot be built.
INSERT INTO public.trade_invoices (id, invoice_number, status)
VALUES (gen_random_uuid(), 'SW-INV-T-000000-001', 'approved'),
       (gen_random_uuid(), 'SW-INV-T-000000-001', 'approved');
