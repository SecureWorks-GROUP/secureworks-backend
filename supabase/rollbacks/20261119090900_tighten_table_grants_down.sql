-- Rollback of 20261119090900_tighten_table_grants.
--
-- Restores exactly the grants that migration removed from anon and PUBLIC, and
-- removes exactly the grants it added to authenticated and service_role, from
-- public.table_grant_changes. A relation dropped since is skipped. Then drops
-- the record and the catalogue rule. Refuses when the record is missing,
-- because without it the grants removed cannot be known.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $down$
DECLARE
  c record;
BEGIN
  IF to_regclass('public.table_grant_changes') IS NULL THEN
    RAISE EXCEPTION 'tighten table grants rollback: public.table_grant_changes is missing, so the removed grants are not known';
  END IF;

  FOR c IN
    SELECT relation, column_name, grantee, privilege, change
    FROM public.table_grant_changes
    WHERE to_regclass(relation) IS NOT NULL
    ORDER BY id
  LOOP
    IF c.change = 'revoked' THEN
      IF c.column_name IS NULL THEN
        EXECUTE format('GRANT %s ON TABLE %s TO %s', c.privilege, c.relation,
                       CASE c.grantee WHEN 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(c.grantee) END);
      ELSE
        EXECUTE format('GRANT %s (%I) ON TABLE %s TO %s', c.privilege, c.column_name, c.relation,
                       CASE c.grantee WHEN 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(c.grantee) END);
      END IF;
    ELSE
      IF c.column_name IS NULL THEN
        EXECUTE format('REVOKE %s ON TABLE %s FROM %I', c.privilege, c.relation, c.grantee);
      ELSE
        EXECUTE format('REVOKE %s (%I) ON TABLE %s FROM %I', c.privilege, c.column_name, c.relation, c.grantee);
      END IF;
    END IF;
  END LOOP;
END
$down$;

DROP FUNCTION IF EXISTS public.table_grant_open_relations();
DROP TABLE public.table_grant_changes;
