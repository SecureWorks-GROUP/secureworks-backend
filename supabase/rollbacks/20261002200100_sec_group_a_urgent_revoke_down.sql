-- Rollback for 20261002200100_sec_group_a_urgent_revoke.sql.
-- Run ONLY on the owner's explicit word: it reopens send_outlook_email_b64
-- and deliver_proposed_actions to the public anon key, which can then send
-- email as the company and trigger Telegram deliveries.
--
-- Restores each function's EXECUTE grants exactly as the forward migration
-- found them, from the ACL it snapshotted into public.function_grant_snapshots
-- (a NULL ACL means the Postgres default: PUBLIC plus the owner). Grants to
-- every non-owner role the forward migration touched are cleared first, then
-- every EXECUTE entry in the snapshot is granted back. The owner's own entry
-- is never revoked. The snapshot rows are then removed, and the table is
-- dropped once no other migration's rows remain in it.

DO $group_a_urgent_rollback$
DECLARE
  r record;
  a record;
  v_grantee text;
BEGIN
  FOR r IN
    SELECT s.signature, s.proacl, p.oid::regprocedure AS fn, p.proowner
    FROM public.function_grant_snapshots s
    JOIN pg_proc p ON p.oid = to_regprocedure(s.signature)
    WHERE s.migration = '20261002200100'
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

  DELETE FROM public.function_grant_snapshots WHERE migration = '20261002200100';
  IF NOT EXISTS (SELECT 1 FROM public.function_grant_snapshots) THEN
    DROP TABLE public.function_grant_snapshots;
  END IF;
END
$group_a_urgent_rollback$;
