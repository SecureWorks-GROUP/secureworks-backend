-- CI: the registered stack already holds 20261106160000's
-- group_work_order_hours_paid_budget, so this is a no-op. Isolated local
-- proof: the three API roles and a byte copy of that function body.
DO $roles$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $roles$;
SELECT to_regprocedure('public.group_work_order_hours_paid_budget(text,numeric)') IS NULL
  AS isolated_hours_budget_setup \gset
\if :isolated_hours_budget_setup
\ir pre_hours_paid_budget.sql
\endif
