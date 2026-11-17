-- P2-01.7 successor: restore this proof's original definition before it
-- inspects or rewrites that definition. Existing assertions stay unchanged.
SELECT to_regclass('public.v_job_cost_events_legacy') IS NOT NULL AS p2017_unwind \gset
\if :p2017_unwind
\ir ../../../rollbacks/20261117210402_job_cost_events_from_cost_lines_down.sql
\endif
-- Deliberately let ops-rejected trade invoices count as job cost again (the
-- defect PR 1 removes), then prove the contract catches it.
DO $$
DECLARE
  d text := pg_get_viewdef('public.v_job_cost_events'::regclass);
  broken text := replace(d, '(ti.status <> ''ops-reject''::text)', 'true');
BEGIN
  IF broken = d THEN RAISE EXCEPTION 'break-contract: ops-reject predicate not found'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events AS ' || broken;
END $$;
