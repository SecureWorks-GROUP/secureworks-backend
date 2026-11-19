-- Rollback of 20261119091600_scope_authenticated_financial_views_and_job_events.
--
-- Undoes, newest first, every change recorded in
-- public.financial_read_access_changes: grants removed are given back, grants
-- added are removed, row rules dropped are created again from their recorded
-- definition, the row rule added is dropped, and row security is switched off
-- where the migration switched it on. A relation dropped since is skipped.
-- Then drops the record. Refuses when the record is missing, because without
-- it what was there before cannot be known.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $down$
DECLARE
  c record;
BEGIN
  IF to_regclass('public.financial_read_access_changes') IS NULL THEN
    RAISE EXCEPTION 'scope financial reads rollback: public.financial_read_access_changes is missing, so the earlier state is not known';
  END IF;

  FOR c IN
    SELECT *
    FROM public.financial_read_access_changes
    WHERE to_regclass(relation) IS NOT NULL
    ORDER BY id DESC
  LOOP
    IF c.kind = 'grant' AND c.change = 'revoked' THEN
      IF c.column_name IS NULL THEN
        EXECUTE format('GRANT %s ON TABLE %s TO %s', c.privilege, c.relation,
                       CASE c.grantee WHEN 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(c.grantee) END);
      ELSE
        EXECUTE format('GRANT %s (%I) ON TABLE %s TO %s', c.privilege, c.column_name, c.relation,
                       CASE c.grantee WHEN 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(c.grantee) END);
      END IF;
    ELSIF c.kind = 'grant' AND c.change = 'granted' THEN
      IF c.column_name IS NULL THEN
        EXECUTE format('REVOKE %s ON TABLE %s FROM %I', c.privilege, c.relation, c.grantee);
      ELSE
        EXECUTE format('REVOKE %s (%I) ON TABLE %s FROM %I', c.privilege, c.column_name, c.relation, c.grantee);
      END IF;
    ELSIF c.kind = 'policy' AND c.change = 'created' THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %s', c.policy_name, c.relation);
    ELSIF c.kind = 'policy' AND c.change = 'dropped' THEN
      EXECUTE format('CREATE POLICY %I ON %s AS %s FOR %s TO %s%s%s',
                     c.policy_name, c.relation,
                     CASE WHEN c.policy_permissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
                     c.policy_command,
                     -- Recorded as regrole text (already quoted) or public.
                     array_to_string(c.policy_roles, ', '),
                     CASE WHEN c.policy_using IS NULL THEN '' ELSE format(' USING (%s)', c.policy_using) END,
                     CASE WHEN c.policy_check IS NULL THEN '' ELSE format(' WITH CHECK (%s)', c.policy_check) END);
    ELSIF c.kind = 'row_security' AND c.change = 'enabled' THEN
      EXECUTE format('ALTER TABLE %s DISABLE ROW LEVEL SECURITY', c.relation);
    ELSE
      RAISE EXCEPTION 'scope financial reads rollback: unknown record % (% %)', c.id, c.kind, c.change;
    END IF;
  END LOOP;
END
$down$;

DROP TABLE public.financial_read_access_changes;
