-- Rollback for 20261002200000_sec_group_a_revoke.sql.
-- Run ONLY on the owner's explicit word: it reopens the 28 Group A
-- functions this migration closed (an email sender, the Telegram proposal
-- dispatcher, the SES invoice void chain, the money seal and customer-data
-- reads among them) to the public anon key. The ten Group A names that were
-- already closed are not touched.
--
-- Restores each function's EXECUTE grants exactly as the forward migration
-- found them, from the ACL it snapshotted into public.function_grant_snapshots
-- (a NULL ACL means the Postgres default: PUBLIC plus the owner). Grants to
-- every non-owner role the forward migration touched are cleared first, then
-- every EXECUTE entry in the snapshot is granted back. The owner's own entry
-- is never revoked. The snapshot rows are then removed, and the table is
-- dropped once no other migration's rows remain in it.

DO $group_a_rollback$
DECLARE
  r record;
  a record;
  v_grantee text;
BEGIN
  FOR r IN
    SELECT s.signature, s.proacl, p.oid::regprocedure AS fn, p.proowner
    FROM public.function_grant_snapshots s
    JOIN pg_proc p ON p.oid = to_regprocedure(s.signature)
    WHERE s.migration = '20261002200000'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', r.fn);
    IF r.proowner <> 'postgres'::regrole THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM postgres', r.fn);
    END IF;
    FOR a IN
      SELECT x.grantee, x.is_grantable
      FROM aclexplode(COALESCE(r.proacl, acldefault('f', r.proowner))) x
      WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> r.proowner
    LOOP
      v_grantee := CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END;
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', r.fn, v_grantee,
        CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;

  DELETE FROM public.function_grant_snapshots WHERE migration = '20261002200000';
  IF NOT EXISTS (SELECT 1 FROM public.function_grant_snapshots) THEN
    DROP TABLE public.function_grant_snapshots;
  END IF;
END
$group_a_rollback$;
