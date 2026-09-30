-- 2026-09-30: the service-role key pasted in this file (fingerprint 4595ba)
-- was leaked by being committed. It is redacted here; the live jobs now read
-- the key from Vault (20260930120000_cron_service_key_from_vault.sql), and
-- the key itself is retired by rotation. This file predates the auto-apply
-- baseline and is never re-applied. Do not paste a key back in.

-- ════════════════════════════════════════════════════════════
-- Phase 2 Cron Jobs: stale followup, EOD checks, Shaun's brief
--
-- Uses hardcoded service_role_key (same pattern as 000004/000011).
-- vault.decrypted_secrets is broken in pg_cron context.
-- ════════════════════════════════════════════════════════════

-- Stale quote/deposit followup — daily at 9am AWST (1:00 UTC)
SELECT cron.schedule('stale-followup', '0 1 * * *',
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=stale_followup',headers:='{"Authorization":"Bearer REDACTED-legacy-service-role-key","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);

-- EOD follow-up — weekdays at 5pm AWST (9:00 UTC)
SELECT cron.schedule('eod-followup-5pm', '0 9 * * 1-5',
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=eod_followup',headers:='{"Authorization":"Bearer REDACTED-legacy-service-role-key","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);

-- EOD escalation — weekdays at 7pm AWST (11:00 UTC)
SELECT cron.schedule('eod-escalation-7pm', '0 11 * * 1-5',
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=eod_followup',headers:='{"Authorization":"Bearer REDACTED-legacy-service-role-key","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);

-- Shaun's morning brief — daily at 7:30am AWST (23:30 UTC previous day)
SELECT cron.schedule('shaun-morning-brief', '30 23 * * *',
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=shaun_brief',headers:='{"Authorization":"Bearer REDACTED-legacy-service-role-key","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);
