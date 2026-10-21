-- Deliberately read an installer bill no person placed as confirmed (the JP-12
-- hole the view must not open). The contract must fail.
DO $$
DECLARE v text := pg_get_viewdef('public.cfo_bill_reconciliation_outcomes'::regclass);
BEGIN
  IF position('THEN ''installer_unconfirmed''::text' IN v) = 0 THEN
    RAISE EXCEPTION 'h7 break: installer branch not found in the view text';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.cfo_bill_reconciliation_outcomes AS '
    || replace(v, 'THEN ''installer_unconfirmed''::text', 'THEN ''confirmed''::text');
END $$;
