-- Break the one-side rule: an allocation the bill's own copy already counts
-- (bill_side counts_it) is counted from the credit note as well. The
-- contract must catch the second count.
DO $$
DECLARE
  def text := pg_get_viewdef('public.v_supplier_credit_allocations'::regclass);
  broken text := replace(def, 'ARRAY[''none''::text, ''not_this_one''::text]', 'ARRAY[''none''::text, ''not_this_one''::text, ''counts_it''::text]');
BEGIN
  IF broken = def THEN RAISE EXCEPTION 'break-contract: the side rule was not found in the view'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_supplier_credit_allocations AS ' || broken;
END $$;
