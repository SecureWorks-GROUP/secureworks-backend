-- Pre-migration surface: the two make-safe cron triggers as production holds
-- them on 21 Oct 2026, reading vault.decrypted_secrets raw. Earlier registered
-- cases provide public.makesafe_cron_enabled() (false, the gate off) and
-- public.sw_service_key() (a fixture value), and assert that no net or vault
-- schema exists, so the pg_net stand-in lives inside contract.sql's
-- rolled-back transactions and no vault is created at all.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

\ir ../../../rollbacks/20261021120000_makesafe_cron_service_key_down.sql

REVOKE ALL ON FUNCTION public.trigger_makesafe_reconcile(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_makesafe_status_canary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_makesafe_reconcile(text) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.trigger_makesafe_status_canary() TO service_role, postgres;
