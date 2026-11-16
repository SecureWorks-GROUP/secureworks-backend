-- Prerequisites for 20261114020000_dispatch_line_budget_cost. Earlier registered cases
-- already create every table this migration alters or references (jobs,
-- job_material_suppliers, job_material_lines, dispatch_supplier_order_emails,
-- job_budgets, feature_flags) and the API roles; this only checks they are there.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.jobs', 'public.suppliers', 'public.job_material_suppliers',
                           'public.job_material_lines', 'public.dispatch_supplier_order_emails',
                           'public.scope_revisions', 'public.job_budgets', 'public.feature_flags'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'dispatch line budget cost setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t) THEN
      RAISE EXCEPTION 'dispatch line budget cost setup: role % missing from the registered stack', t;
    END IF;
  END LOOP;
END $$;
