-- Deliberately read an installer bill no person placed as confirmed (the JP-12
-- hole the view must not open), and switch off the no-recorded-person guard
-- that would otherwise catch it. The contract must fail.
DO $$
DECLARE v text := pg_get_viewdef('public.cfo_bill_reconciliation_outcomes'::regclass);
BEGIN
  IF position('THEN ''installer_unconfirmed''::text' IN v) = 0 THEN
    RAISE EXCEPTION 'h7 break: installer branch not found in the view text';
  END IF;
  IF v !~ '\(j(_[0-9]+)?\.decider IS NULL\)' THEN
    RAISE EXCEPTION 'h7 break: no-recorded-person guard not found in the view text';
  END IF;
  v := replace(v, 'THEN ''installer_unconfirmed''::text', 'THEN ''confirmed''::text');
  v := regexp_replace(v, '\(j(_[0-9]+)?\.decider IS NULL\)', 'false', 'g');
  EXECUTE 'CREATE OR REPLACE VIEW public.cfo_bill_reconciliation_outcomes AS ' || v;
END $$;
