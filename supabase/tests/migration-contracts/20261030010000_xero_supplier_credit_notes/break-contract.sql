-- Break: a voided credit note counts as live, so its allocations land on a job.
-- The contract must catch it.
-- TP-07 slice 2 (20261030060000) replaces this view: roll it back first (this
-- is a disposable copy), so the break is made in slice 1's own body.
SELECT to_regclass('public.v_supplier_credit_allocations') IS NOT NULL AS cn_netting_live \gset
\if :cn_netting_live
\ir ../../../rollbacks/20261030060000_supplier_credit_netting_down.sql
\endif
DO $$
DECLARE
  def text := pg_get_viewdef('public.v_supplier_credit_placement'::regclass);
  broken text := replace(def, '(ARRAY[''AUTHORISED''::text, ''PAID''::text])', '(ARRAY[''AUTHORISED''::text, ''PAID''::text, ''VOIDED''::text])');
BEGIN
  IF broken = def THEN RAISE EXCEPTION 'break-contract: the live rule was not found in the view'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_supplier_credit_placement WITH (security_invoker = true) AS ' || broken;
END $$;
