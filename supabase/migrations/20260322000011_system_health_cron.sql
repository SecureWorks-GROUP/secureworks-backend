-- 2026-09-30: the service-role key pasted in this file (fingerprint 4595ba)
-- was leaked by being committed. It is redacted here; the live jobs now read
-- the key from Vault (20260930120000_cron_service_key_from_vault.sql), and
-- the key itself is retired by rotation. This file predates the auto-apply
-- baseline and is never re-applied. Do not paste a key back in.

-- ════════════════════════════════════════════════════════════
-- Cron: System health check every 30 minutes
--
-- Calls the system-health edge function to verify Xero sync
-- freshness, digest runs, stale alerts, and event generation.
-- Sends Telegram alert if anything is degraded or critical.
-- Uses hardcoded service role key (same pattern as 000004).
-- ════════════════════════════════════════════════════════════

SELECT cron.schedule('system-health-check', '*/30 * * * *',
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/system-health',headers:='{"Authorization":"Bearer REDACTED-legacy-service-role-key","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);
