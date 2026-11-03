-- Break the one-side rule: an allocation the bill's own copy already counts
-- (bill_side counts_it) is counted from the credit note as well. The
-- contract must catch the second count.
-- 20261104123000 (C3 one-job speed-up) rewrote the view, and the contract unwinds it first through its down, which
-- refuses a view that is not exactly its own. Unwind it here, the same step the contract takes, so the break lands
-- on the definition the contract reads.
SELECT md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true))='b48997c55913ce3c90e3a3c947533fd3' AS test_has_c3_fast \gset
\if :test_has_c3_fast
\ir ../../../rollbacks/20261104123000_job_cost_events_faster_same_rows_down.sql
\endif
DO $$
DECLARE
  def text := pg_get_viewdef('public.v_supplier_credit_allocations'::regclass);
  broken text := replace(def, 'ARRAY[''none''::text, ''not_this_one''::text]', 'ARRAY[''none''::text, ''not_this_one''::text, ''counts_it''::text]');
BEGIN
  IF broken = def THEN RAISE EXCEPTION 'break-contract: the side rule was not found in the view'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_supplier_credit_allocations AS ' || broken;
END $$;
