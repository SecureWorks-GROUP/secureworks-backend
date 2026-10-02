-- Close the two network-reaching Group A functions to the public key.
--
-- A read-only production check on 2 Oct 2026 found both still executable by
-- anon and authenticated (SECURITY DEFINER, owned by the migrating role):
--   * send_outlook_email_b64(text,text,text,text,text,text,text): live-only
--     (no repo source). Queues and posts an Outlook email with a base64
--     attachment through the send-outlook-email edge function. With the anon
--     key anyone can send email as the company.
--   * deliver_proposed_actions(): live-only. Posts pending AI proposals to the
--     telegram-bot edge function. Called only by pg_cron, which runs as
--     postgres.
-- No repository, edge function, browser page or agent calls either one with
-- the anon key or a signed-in user session; pg_cron runs every job as
-- postgres.
--
-- This migration changes privileges only. Neither function is dropped and no
-- body is touched.
--   * Before changing anything it snapshots each function's current ACL into
--     public.function_grant_snapshots, so the rollback restores the exact
--     pre-apply grants instead of guessing them.
--   * EXECUTE is revoked from PUBLIC, anon and authenticated.
--   * EXECUTE is granted explicitly to service_role and postgres, so neither
--     loses a grant it held only through PUBLIC.
--   * The post-check fails the whole apply if anon or authenticated can still
--     execute any overload of either name, or if service_role or postgres
--     cannot.
--
-- A signature absent from the database (fresh migration-only provisioning)
-- is skipped with a NOTICE. Rollback, only on the owner's word:
-- supabase/rollbacks/20261002200100_sec_group_a_urgent_revoke_down.sql.

CREATE TABLE IF NOT EXISTS public.function_grant_snapshots (
  migration text NOT NULL,
  signature text NOT NULL,
  owner_name text NOT NULL,
  proacl aclitem[],
  taken_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (migration, signature)
);
COMMENT ON TABLE public.function_grant_snapshots IS
  'Pre-apply EXECUTE ACLs of functions whose grants a security migration narrowed, keyed by migration version, so its rollback restores the exact prior grants. Owner and service_role only.';
ALTER TABLE public.function_grant_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.function_grant_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.function_grant_snapshots TO service_role;

DO $group_a_urgent_revoke$
DECLARE
  v_sig text;
  v_fn regprocedure;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.send_outlook_email_b64(text,text,text,text,text,text,text)',
    'public.deliver_proposed_actions()'
  ]
  LOOP
    v_fn := to_regprocedure(v_sig);
    IF v_fn IS NULL THEN
      RAISE NOTICE 'group A urgent revoke: % not present, skipped', v_sig;
      CONTINUE;
    END IF;
    INSERT INTO public.function_grant_snapshots (migration, signature, owner_name, proacl)
    SELECT '20261002200100', v_fn::text, p.proowner::regrole::text, p.proacl
    FROM pg_proc p
    WHERE p.oid = v_fn
    ON CONFLICT (migration, signature) DO NOTHING;
    RAISE NOTICE 'group A urgent revoke: % proacl before = %',
      v_fn, (SELECT proacl FROM pg_proc WHERE oid = v_fn);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role, postgres', v_fn);
  END LOOP;
END
$group_a_urgent_revoke$;

-- Post-check by NAME, so an overload this file does not list still fails the
-- apply instead of being left open.
DO $group_a_urgent_post_check$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('send_outlook_email_b64', 'deliver_proposed_actions')
  LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'group A urgent post-check: anon can still execute %', v_fn;
    END IF;
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'group A urgent post-check: authenticated can still execute %', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'group A urgent post-check: service_role lost execute on %', v_fn;
    END IF;
    IF NOT has_function_privilege('postgres', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'group A urgent post-check: postgres (pg_cron) lost execute on %', v_fn;
    END IF;
  END LOOP;
END
$group_a_urgent_post_check$;
