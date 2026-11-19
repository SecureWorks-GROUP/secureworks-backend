-- Rollback of 20261119091300_tighten_default_function_sequence_grants.
--
-- Restores exactly the grants that migration removed from anon and PUBLIC, and
-- removes exactly the grants it added to authenticated and service_role, from
-- public.object_grant_changes: on routines, on sequences, and in postgres's
-- default privileges. A routine or sequence dropped since is skipped. Then
-- drops the record and the catalogue rule. Refuses when the record is
-- missing, because without it the grants removed cannot be known.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $down$
DECLARE
  c record;
  v_to text;
BEGIN
  IF to_regclass('public.object_grant_changes') IS NULL THEN
    RAISE EXCEPTION 'tighten default, function and sequence grants rollback: public.object_grant_changes is missing, so the removed grants are not known';
  END IF;
  PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);

  FOR c IN
    SELECT object_kind, object, object_type, grantee, privilege, grantable, change
    FROM public.object_grant_changes
    WHERE CASE object_kind
            WHEN 'function' THEN to_regprocedure(object) IS NOT NULL
            WHEN 'sequence' THEN to_regclass(object) IS NOT NULL
            ELSE true
          END
    ORDER BY id DESC
  LOOP
    v_to := CASE c.grantee WHEN 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(c.grantee) END;
    IF c.change = 'revoked' THEN
      EXECUTE format('%s GRANT %s ON %s TO %s%s',
                     CASE c.object_kind
                       WHEN 'default' THEN format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres %s',
                                                  CASE c.object WHEN '*' THEN '' ELSE 'IN SCHEMA public' END)
                       ELSE '' END,
                     c.privilege,
                     CASE c.object_kind
                       WHEN 'function' THEN 'ROUTINE ' || c.object
                       WHEN 'sequence' THEN 'SEQUENCE ' || c.object
                       ELSE c.object_type END,
                     v_to,
                     CASE WHEN c.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    ELSE
      EXECUTE format('%s REVOKE %s ON %s FROM %s',
                     CASE c.object_kind
                       WHEN 'default' THEN format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres %s',
                                                  CASE c.object WHEN '*' THEN '' ELSE 'IN SCHEMA public' END)
                       ELSE '' END,
                     c.privilege,
                     CASE c.object_kind
                       WHEN 'function' THEN 'ROUTINE ' || c.object
                       WHEN 'sequence' THEN 'SEQUENCE ' || c.object
                       ELSE c.object_type END,
                     v_to);
    END IF;
  END LOOP;
END
$down$;

DROP FUNCTION IF EXISTS public.object_grant_open();
DROP TABLE public.object_grant_changes;
