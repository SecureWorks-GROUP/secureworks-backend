-- Read-only check to run against the target database before applying
-- 20261119091600_scope_authenticated_financial_views_and_job_events. Not run
-- by the contract runner. It reads the catalogue and the migration ledger
-- only, and returns one row per check with ok true or false. Run it in a
-- read-only session (Management API read_only: true, or psql with
-- default_transaction_read_only = on).

WITH rel AS (
  SELECT n.nspname || '.' || c.relname AS relation, c.oid, c.relkind, c.relrowsecurity,
         pg_get_userbyid(c.relowner) AS owner,
         coalesce(c.reloptions && ARRAY['security_invoker=true', 'security_invoker=on', 'security_invoker=1'], false) AS invoker
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('job_financials', 'aged_receivables', 'monthly_revenue', 'monthly_costs', 'job_events')
)
SELECT 'relation present: ' || r.name AS check_name,
       EXISTS (SELECT 1 FROM rel WHERE rel.relation = r.name) AS ok,
       (SELECT format('kind %s, owner %s, security_invoker %s, row security %s', relkind, owner, invoker, relrowsecurity)
        FROM rel WHERE rel.relation = r.name) AS detail
FROM unnest(ARRAY['public.job_financials', 'public.aged_receivables', 'public.monthly_revenue',
                  'public.monthly_costs', 'public.job_events']) AS r(name)
UNION ALL
SELECT 'owned by the migration role: ' || relation, owner = current_user, owner FROM rel
UNION ALL
SELECT 'server role can read: ' || relation, has_table_privilege('service_role', oid, 'SELECT'), NULL FROM rel
UNION ALL
SELECT 'signed-in role can insert job events', has_table_privilege('authenticated', 'public.job_events', 'INSERT'), NULL
UNION ALL
SELECT 'no permissive rule for all commands reaches PUBLIC, anon or authenticated on job_events',
       NOT EXISTS (SELECT 1 FROM pg_policy p
                   WHERE p.polrelid = 'public.job_events'::regclass AND p.polpermissive AND p.polcmd = '*'
                     AND (0::oid = ANY (p.polroles) OR 'anon'::regrole = ANY (p.polroles)
                          OR 'authenticated'::regrole = ANY (p.polroles))),
       NULL
UNION ALL
SELECT 'job_events rule: ' || p.polname,
       true,
       format('command %s, permissive %s, roles %s', p.polcmd, p.polpermissive, p.polroles::regrole[]::text)
FROM pg_policy p WHERE p.polrelid = 'public.job_events'::regclass
UNION ALL
SELECT 'helpers present (auth.uid, public.auth_org_id, users.role, jobs.org_id)',
       to_regprocedure('auth.uid()') IS NOT NULL AND to_regprocedure('public.auth_org_id()') IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attname = 'role' AND NOT attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.jobs'::regclass AND attname = 'org_id' AND NOT attisdropped),
       NULL
UNION ALL
SELECT 'change record not yet present', to_regclass('public.financial_read_access_changes') IS NULL, NULL
UNION ALL
SELECT 'migration version free in the ledger',
       NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261119091600'),
       NULL;
