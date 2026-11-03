-- 20261104070000 to 20261104072000 (A6 cost rules) moved v_job_cost_events on to production's definition and then
-- their own: unwind them first, back to the stack's own definition.
SELECT md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true))='25143b7d28aae47cd44a16323fa99389' AS test_has_a6_cost_rules \gset
\if :test_has_a6_cost_rules
\ir ../../../rollbacks/20261104072000_job_cost_credit_at_note_ex_gst_down.sql
\ir ../../../rollbacks/20261104071000_job_cost_xero_crew_bill_super_down.sql
\ir ../../../rollbacks/20261104070000_job_cost_follows_ledger_split_lines_down.sql
\ir ../20261104070000_job_cost_follows_ledger_split_lines/restore-preimage.sql
\endif
SELECT md5(pg_get_viewdef('public.v_job_cost_events'::regclass))='92d9a2923438e6a1da601e2179ae34e3' AS test_has_credit_labour_composition \gset
\if :test_has_credit_labour_composition
\ir ../../../rollbacks/20261031020000_job_credit_labour_composition_down.sql
\ir ../../../rollbacks/20261030170000_job_labour_employer_oncost_down.sql
\endif
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
