-- Executed against disposable PostgreSQL after the migration.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'xero_invoices'
      AND column_name = 'reconcile_attempted_at'
      AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'xero_invoices.reconcile_attempted_at is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'xero_invoices'
      AND column_name = 'reconcile_last_error'
      AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'xero_invoices.reconcile_last_error is missing';
  END IF;
END;
$$;

-- A pre-existing row must keep a null attempt stamp: never verified is not the
-- same claim as verified at migration time, and the sweep orders on it.
DO $$
DECLARE
  stamped timestamptz;
BEGIN
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_type, status, synced_at)
  VALUES ('00000000-0000-0000-0000-000000000001', 'fixture-only-draft', 'ACCREC', 'DRAFT', now() - interval '3 days');
  SELECT reconcile_attempted_at INTO stamped
  FROM public.xero_invoices WHERE xero_invoice_id = 'fixture-only-draft';
  IF stamped IS NOT NULL THEN
    RAISE EXCEPTION 'reconcile_attempted_at must default to null, got %', stamped;
  END IF;
END;
$$;

-- A never-attempted draft must sort ahead of an attempted one so the daily
-- sweep reaches new drafts before retrying a row that already failed.
DO $$
DECLARE
  first_id text;
BEGIN
  UPDATE public.xero_invoices
  SET reconcile_attempted_at = now(), reconcile_last_error = 'fixture-only failure'
  WHERE xero_invoice_id = 'fixture-only-draft';

  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_type, status, synced_at)
  VALUES ('00000000-0000-0000-0000-000000000001', 'fixture-only-fresh', 'ACCREC', 'DRAFT', now() - interval '2 days');

  SELECT xero_invoice_id INTO first_id
  FROM public.xero_invoices
  WHERE invoice_type = 'ACCREC' AND status = 'DRAFT'
  ORDER BY reconcile_attempted_at ASC NULLS FIRST, synced_at ASC
  LIMIT 1;

  IF first_id <> 'fixture-only-fresh' THEN
    RAISE EXCEPTION 'a failed draft still heads the sweep: %', first_id;
  END IF;
END;
$$;

ROLLBACK;
