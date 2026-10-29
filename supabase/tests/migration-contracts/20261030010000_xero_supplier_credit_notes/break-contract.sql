-- Break: a voided credit note counts as live, so its allocations land on a job.
-- The contract must catch it.
DO $$
DECLARE
  def text := pg_get_viewdef('public.v_supplier_credit_placement'::regclass);
  broken text := replace(def, '(ARRAY[''AUTHORISED''::text, ''PAID''::text])', '(ARRAY[''AUTHORISED''::text, ''PAID''::text, ''VOIDED''::text])');
BEGIN
  IF broken = def THEN RAISE EXCEPTION 'break-contract: the live rule was not found in the view'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_supplier_credit_placement WITH (security_invoker = true) AS ' || broken;
END $$;
