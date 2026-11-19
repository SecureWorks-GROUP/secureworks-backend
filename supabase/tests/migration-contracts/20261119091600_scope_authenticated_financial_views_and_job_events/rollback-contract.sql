-- After the rollback the grants, rules and row security on the five relations
-- are exactly what they were before the migration, and the record is gone.
\set ON_ERROR_STOP on
DO $rb$
DECLARE
  v_diff text;
BEGIN
  WITH now_grants AS (
    SELECT c.relname::text AS relation, NULL::text AS column_name,
           a.grantee::regrole::text AS grantee, a.privilege_type, a.is_grantable
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname IN ('job_financials', 'aged_receivables', 'monthly_revenue', 'monthly_costs', 'job_events')
    UNION ALL
    SELECT c.relname::text, at.attname::text, a.grantee::regrole::text, a.privilege_type, a.is_grantable
    FROM pg_class c
    JOIN pg_attribute at ON at.attrelid = c.oid AND at.attnum > 0 AND NOT at.attisdropped AND at.attacl IS NOT NULL
    CROSS JOIN LATERAL aclexplode(at.attacl) a
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname IN ('job_financials', 'aged_receivables', 'monthly_revenue', 'monthly_costs', 'job_events')
  ),
  diff AS (
    (SELECT 'missing' AS side, * FROM zfv_before.grants EXCEPT SELECT 'missing', * FROM now_grants)
    UNION ALL
    (SELECT 'extra', * FROM now_grants EXCEPT SELECT 'extra', * FROM zfv_before.grants)
  )
  SELECT string_agg(format('%s %s.%s %s %s', side, relation, coalesce(column_name, '*'), grantee, privilege_type), '; ')
  INTO v_diff FROM diff;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'fv-scope rollback: grants differ from before the migration: %', v_diff;
  END IF;

  WITH now_policies AS (
    SELECT polname::text AS name, polcmd::text AS cmd, polpermissive AS permissive,
           polroles::regrole[]::text AS roles,
           pg_get_expr(polqual, polrelid) AS using_expr, pg_get_expr(polwithcheck, polrelid) AS check_expr
    FROM pg_policy WHERE polrelid = 'public.job_events'::regclass
  ),
  diff AS (
    (SELECT 'missing' AS side, * FROM zfv_before.policies EXCEPT SELECT 'missing', * FROM now_policies)
    UNION ALL
    (SELECT 'extra', * FROM now_policies EXCEPT SELECT 'extra', * FROM zfv_before.policies)
  )
  SELECT string_agg(format('%s %s %s %s', side, name, cmd, roles), '; ') INTO v_diff FROM diff;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'fv-scope rollback: job_events rules differ from before the migration: %', v_diff;
  END IF;

  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_events'::regclass)
     IS DISTINCT FROM (SELECT rls FROM zfv_before.row_security) THEN
    RAISE EXCEPTION 'fv-scope rollback: row security on job_events differs from before the migration';
  END IF;
  IF to_regclass('public.financial_read_access_changes') IS NOT NULL THEN
    RAISE EXCEPTION 'fv-scope rollback: the change record is still there';
  END IF;
END
$rb$;
