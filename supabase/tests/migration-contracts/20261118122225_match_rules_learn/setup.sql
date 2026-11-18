SELECT to_regclass('public.reconcile_decisions') IS NULL AS needs_decisions \gset
\if :needs_decisions
\ir ../20261118060051_reconcile_tables/setup.sql
\ir ../../../migrations/20261118060051_reconcile_tables.sql
\endif
SELECT to_regclass('public.match_rules') IS NULL AS needs_rules \gset
\if :needs_rules
\ir ../../../migrations/20261117160500_match_tables.sql
\endif
CREATE TABLE IF NOT EXISTS public.users(id uuid PRIMARY KEY, org_id uuid, name text, role text);
