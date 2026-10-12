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
