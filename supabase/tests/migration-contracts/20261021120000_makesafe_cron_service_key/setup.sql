-- Pre-migration surface: the six make-safe cron triggers as production holds
-- them on 21 Oct 2026, reading vault.decrypted_secrets raw. Earlier registered
-- cases provide public.makesafe_cron_enabled() (false, the gate off) and
-- public.sw_service_key() (a fixture value), and assert that no net or vault
-- schema exists, so the pg_net and Vault stand-ins live in fixture.sql, inside
-- the contracts' rolled-back transactions.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

\ir ../../../rollbacks/20261021120000_makesafe_cron_service_key_down.sql

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.trigger_makesafe_reconcile(text)',
    'public.trigger_makesafe_status_canary()',
    'public.trigger_makesafe_portal_recheck()',
    'public.trigger_makesafe_sent_mirror()',
    'public.trigger_makesafe_story_recompute()',
    'public.trigger_makesafe_status_shadow_refresh()'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role, postgres', fn);
  END LOOP;
END $$;
