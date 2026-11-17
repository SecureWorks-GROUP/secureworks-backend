-- P2-01.7 successor: restore this proof's original definition before it
-- inspects or rewrites that definition. Existing assertions stay unchanged.
SELECT to_regclass('public.v_job_cost_events_legacy') IS NOT NULL AS p2017_unwind \gset
\if :p2017_unwind
\ir ../../../rollbacks/20261117210402_job_cost_events_from_cost_lines_down.sql
\endif
-- Break: split parts lose their own amount (each part would carry the whole line). The contract must catch it.
DO $$
DECLARE
  d text := pg_get_viewdef('public.v_job_cost_events'::regclass, true);
  b text := replace(d, 'WHEN sp.xero_invoice_id IS NOT NULL THEN sp.amount_ex_gst', 'WHEN false THEN sp.amount_ex_gst');
BEGIN
  IF b = d THEN RAISE EXCEPTION 'break-contract found nothing to break'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events AS ' || b;
END $$;
